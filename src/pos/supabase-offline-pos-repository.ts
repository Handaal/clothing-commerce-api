import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import type {
  EnrollPosDeviceRequest,
  IngestOfflineAttendanceResponse,
  ListPosSyncConflictsResponse,
  IngestOfflineCustomerPaymentResponse,
  IngestOfflineReturnResponse,
  IngestOfflineSaleResponse,
  OfflineAttendanceCommand,
  OfflineBootstrapResponse,
  OfflineStockGrant,
  OfflineVoucherGrant,
  OfflineVoucherPolicy,
  OfflinePinAuthorization,
  OfflineCustomerCommand,
  IngestOfflineCustomerResponse,
  IngestOfflineSaleHoldResponse,
  OfflineSaleHoldCommand,
  PosOverridePasswordResponse,
  OfflineCustomerPaymentCommand,
  OfflineReturnCommand,
  OfflineReturnGrantResponse,
  OfflineSaleCommand,
  PosDeviceResponse,
} from "../contracts";
import type {
  IngestOfflineIntentResponse,
  OfflineIntentCommand,
  OfflineIntentOperation,
  SetStaffOfflinePinResponse,
} from "../contracts";
import {
  OfflineIntentDispositionDetailSchema,
  OfflineIntentDispositionSchema,
  OfflineIntentOperationSchema,
  OfflineVoucherGrantSchema,
  OfflineVoucherPolicySchema,
} from "../contracts";
import { OfflinePosError } from "./offline-errors";
import type { EncryptedOfflinePin, ScryptVerifierParams } from "./offline-pin-crypto";
import {
  OVERRIDE_VERIFIER_ALGORITHM,
  type OverrideServerVerifier,
} from "./override-password-crypto";
import type {
  OfflineCredential,
  OfflinePosRepository,
  OverrideVerifierEntry,
  SealedRosterEntry,
} from "./offline-repository";

const PRIVATE_SCHEMA = "offline_pos_private";
const Uuid = z.string().uuid();
const NumberValue = z.union([z.number(), z.string()]).transform((value) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("Database integer exceeds the application range.");
  return result;
});

function iso(value: string): string {
  return new Date(value).toISOString();
}

interface DatabaseErrorLike {
  readonly code?: string;
  readonly message?: string;
}
function mapError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "OD404":
      return new OfflinePosError("DEVICE_NOT_FOUND");
    case "OD403":
    case "OD409":
      return new OfflinePosError("DEVICE_ENROLLMENT_CONFLICT");
    case "OD410":
      return new OfflinePosError("DEVICE_REVOKED");
    case "OP403":
      return new OfflinePosError("OFFLINE_DISABLED");
    case "OL409":
      return new OfflinePosError("OFFLINE_LOCATION_LEASE_CONFLICT");
    case "OG404":
      return new OfflinePosError("OFFLINE_GRANT_NOT_FOUND");
    case "OG410":
      return new OfflinePosError("OFFLINE_GRANT_EXPIRED");
    case "OL422":
      return new OfflinePosError("OFFLINE_LIMIT_EXCEEDED");
    case "OG403":
    case "OG422":
    case "OS422":
      return new OfflinePosError("OFFLINE_GRANT_INVALID");
    case "OS401":
      return new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    // Customer A/R rejections surfaced by record_customer_payment during an offline paydown ingest. All
    // are deterministic (not retryable): a stale offline view overpaying the authoritative outstanding
    // (CA409), an invalid amount (CA422), or an unknown customer (CA404). Map to a blocking 4xx so the
    // POS outbox marks the command for reconciliation instead of retrying it forever as a 5xx.
    case "CA409":
    case "CA422":
      return new OfflinePosError("OFFLINE_LIMIT_EXCEEDED");
    case "CA404":
      return new OfflinePosError("OFFLINE_GRANT_INVALID");
    // Return-grant issuance rejections from returns_private.return_eligibility: order not found (RT404), a
    // non-returnable order / policy reason (RT422), or a currency mismatch (RT409). Deterministic 4xx.
    case "RT404":
      return new OfflinePosError("OFFLINE_GRANT_NOT_FOUND");
    case "RT409":
    case "RT422":
      return new OfflinePosError("OFFLINE_GRANT_INVALID");
    case "AT409":
    case "AT404":
      return new OfflinePosError("OFFLINE_GRANT_INVALID");
    case "OI403":
      return new OfflinePosError("OFFLINE_INTENT_DISABLED");
    case "OI424":
      return new OfflinePosError("OFFLINE_INTENT_DEPENDENCY_MISSING");
    case "RT423":
      return new OfflinePosError("OFFLINE_RETURN_BUDGET_MISSING");
    case "SG404":
      return new OfflinePosError("STOCK_GRANT_NOT_FOUND");
    case "SG409":
      return new OfflinePosError("STOCK_GRANT_OPEN");
    case "CH409":
      return new OfflinePosError("STOCK_GRANT_INSUFFICIENT");
    case "OH409":
      return new OfflinePosError("OFFLINE_SALE_ORDINAL_CONFLICT");
    case "OH422":
      return new OfflinePosError("OFFLINE_SALE_HOLD_INVALID");
    case "ID409":
    case "23505":
      return new OfflinePosError("IDEMPOTENCY_CONFLICT");
    default:
      return new Error(
        `Unexpected offline POS persistence error (${error.code ?? "unknown"}: ${error.message ?? "no message"}).`,
      );
  }
}

const DeviceRow = z.object({
  device_id: Uuid,
  credential_id: Uuid,
  register_id: Uuid,
  status: z.enum(["active", "revoked"]),
  public_key_fingerprint: z.string(),
  activated_at: z.string(),
  revoked_at: z.string().nullable(),
});

function deviceResult(raw: unknown): PosDeviceResponse {
  const rows = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const row = DeviceRow.parse(rows[0]);
  return {
    deviceId: row.device_id,
    credentialId: row.credential_id,
    registerId: row.register_id,
    status: row.status,
    publicKeyFingerprint: row.public_key_fingerprint,
    activatedAt: iso(row.activated_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
  };
}

const GrantRow = z.object({
  id: Uuid,
  snapshot_id: Uuid,
  tenant_id: Uuid,
  device_id: Uuid,
  register_id: Uuid,
  branch_id: Uuid,
  inventory_location_id: Uuid,
  operator_membership_id: Uuid,
  currency: z.string(),
  schema_version: z.literal(1),
  minimum_client_version: z.string(),
  issued_at: z.string(),
  operator_expires_at: z.string(),
  catalog_valid_until: z.string(),
  accepted_until: z.string(),
  max_sale_amount_minor: NumberValue,
  max_cumulative_exposure_minor: NumberValue,
  max_quantity_per_line: NumberValue,
  max_pending_offline_sales: NumberValue,
  max_offline_credit_exposure_minor: NumberValue,
  customers_snapshot: z.array(
    z.object({
      customerId: Uuid,
      name: z.string(),
      phone: z.string(),
      outstandingMinor: NumberValue,
    }),
  ),
  catalog_snapshot: z.array(
    z.object({
      productId: Uuid,
      brandId: Uuid,
      name: z.string(),
      active: z.boolean(),
      // Server-authoritative classification carried in the snapshot (see migration
      // 20261101130000). brandName may be null if the brand was removed; categories is the
      // product's non-archived collection memberships. Defaulted so a grant row issued before the
      // migration (its stored snapshot lacks these keys) still re-reads cleanly as unclassified.
      brandName: z.string().nullable().default(null),
      categories: z.array(z.object({ id: Uuid, name: z.string() })).default([]),
      variants: z.array(
        z.object({
          variantId: Uuid,
          sku: z.string(),
          optionSummary: z.string().nullable(),
          active: z.boolean(),
          authorizedUnitPriceMinor: NumberValue,
          priceId: Uuid,
          priceVersion: z.string(),
          advisoryInventory: z.object({
            onHandQuantity: NumberValue,
            version: NumberValue,
            asOf: z.string(),
          }),
        }),
      ),
    }),
  ),
});

// The set/roster RPCs live in staff_private and raise the staff domain's SQLSTATEs; map them to the
// offline-PIN error surface. ID409 is the shared idempotency-ledger conflict.
function mapStaffPinError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "ST404":
      return new OfflinePosError("OFFLINE_PIN_STAFF_NOT_FOUND");
    case "ST409":
      return new OfflinePosError("OFFLINE_PIN_STAFF_INACTIVE");
    case "ST403":
      return new OfflinePosError("OFFLINE_PIN_ESCALATION_DENIED");
    case "ID409":
    case "23505":
      return new OfflinePosError("IDEMPOTENCY_CONFLICT");
    default:
      return new Error(
        `Unexpected offline-PIN persistence error (${error.code ?? "unknown"}: ${error.message ?? "no message"}).`,
      );
  }
}

const SetOfflinePinRow = z.object({
  membershipId: Uuid,
  keyVersion: z.number().int().positive(),
  updatedAt: z.string(),
});

const RosterRow = z.object({
  membership_id: Uuid,
  username: z.string(),
  display_name: z.string(),
  key_version: z.number().int().positive(),
  cipher_algorithm: z.literal("aes-256-gcm"),
  ciphertext_base64: z.string(),
  iv_base64: z.string(),
  auth_tag_base64: z.string(),
  scrypt_n: NumberValue,
  scrypt_r: NumberValue,
  scrypt_p: NumberValue,
  key_length: NumberValue,
  salt_length: NumberValue,
});

const IngestionRow = z.object({
  ingestion_id: Uuid,
  sync_status: z.enum(["synced", "needs_reconciliation"]),
  order_id: Uuid,
  payment_id: Uuid,
  fulfillment_id: Uuid.nullable(),
  reconciliation_id: Uuid.nullable(),
  received_at: z.string(),
});

const nullableUuid = z.string().nullable();
const SyncConflictRow = z.object({
  id: z.string(),
  kind: z.enum([
    "stock_shortfall",
    "voucher",
    "customer_duplicate",
    "customer_debt",
    "attendance",
    "dependency",
    "sync_integrity",
  ]),
  reason_code: z.string(),
  status: z.enum(["open", "informational"]),
  branch_id: nullableUuid,
  inventory_location_id: nullableUuid,
  device_id: nullableUuid,
  register_id: nullableUuid,
  sync_command_id: nullableUuid,
  local_reference: z.string().nullable(),
  order_id: nullableUuid,
  payment_id: nullableUuid,
  customer_id: nullableUuid,
  promotion_id: nullableUuid,
  membership_id: nullableUuid,
  variant_id: nullableUuid,
  quantity: z.union([z.number(), z.string()]).nullable(),
  amount_minor: z.union([z.number(), z.string()]).nullable(),
  currency: z.string().nullable(),
  local_evidence: z.record(z.string(), z.unknown()),
  server_evidence: z.record(z.string(), z.unknown()),
  local_event_at: z.string().nullable(),
  detected_at: z.string(),
});
const ConflictIngestionRow = z.object({
  conflict_ingestion_id: z.string(),
  conflict_id: z.string(),
  reason_code: z.string(),
  received_at: z.string(),
});
interface ConflictRecorded {
  readonly syncStatus: "conflict_recorded";
  readonly ingestionId: string;
  readonly receivedAt: string;
  readonly conflict: {
    readonly id: string;
    readonly kind: "customer_debt" | "attendance";
    readonly reasonCode: string;
  };
}
const PaymentIngestionRow = z.object({
  ingestion_id: Uuid,
  sync_status: z.literal("synced"),
  payment: z.object({
    id: Uuid,
    customerId: Uuid,
    currency: z.string(),
    amountMinor: NumberValue,
    paidAt: z.string(),
    outstandingMinor: NumberValue,
  }),
  received_at: z.string(),
});

const AttendanceIngestionRow = z.object({
  ingestion_id: Uuid,
  sync_status: z.literal("received"),
  adjudication_status: z.enum(["pending_policy", "applied"]),
  membership_id: Uuid,
  event_type: z.enum(["clock_in", "clock_out"]),
  event_at: z.string(),
  received_at: z.string(),
});

const IntentIngestionRow = z.object({
  ingestion_id: Uuid,
  sync_status: z.literal("received"),
  operation: OfflineIntentOperationSchema,
  received_at: z.string(),
  disposition: OfflineIntentDispositionSchema,
  disposition_code: z.string().min(1),
  disposition_detail: z.record(z.string(), z.unknown()).nullable(),
  policy_version: z.string().nullable(),
  decided_at: z.string(),
});

const ReturnGrantRow = z.object({
  id: Uuid,
  requires_pos_admin_credentials: z.boolean().optional(),
  snapshot_id: Uuid,
  tenant_id: Uuid,
  device_id: Uuid,
  register_id: Uuid,
  branch_id: Uuid,
  inventory_location_id: Uuid,
  operator_membership_id: Uuid,
  order_id: Uuid,
  currency: z.string(),
  schema_version: z.literal(1),
  minimum_client_version: z.string(),
  issued_at: z.string(),
  expires_at: z.string(),
  max_refundable_minor: NumberValue,
  eligibility_snapshot: z.object({
    policy: z.object({ allowedReasons: z.array(z.string()).nullable() }).partial(),
    lines: z.array(
      z.object({
        orderLineId: Uuid,
        lineNumber: NumberValue,
        variantId: Uuid,
        eligibleQuantity: NumberValue,
        unitPriceMinor: NumberValue,
      }),
    ),
  }),
});

const ReturnIngestionRow = z.object({
  ingestion_id: Uuid,
  sync_status: z.enum(["synced", "needs_reconciliation"]),
  return_id: Uuid.nullable(),
  refund_id: Uuid.nullable(),
  refund_amount_minor: NumberValue.nullable(),
  refund_currency: z.string().nullable(),
  reconciliation_id: Uuid.nullable(),
  received_at: z.string(),
});

const OverrideRosterRow = z.object({
  membership_id: Uuid,
  username: z.string(),
  display_name: z.string(),
  permissions: z.array(z.enum(["promotions.manage", "payments.refund"])),
  verifier_version: z.number().int(),
  verifier_algorithm: z.literal(OVERRIDE_VERIFIER_ALGORITHM),
  verifier_salt_base64: z.string().min(1),
  verifier_hash_base64: z.string().min(1),
  scrypt_n: z.number().int(),
  scrypt_r: z.number().int(),
  scrypt_p: z.number().int(),
  key_length: z.number().int(),
});

const CustomerIngestionRow = z.object({
  ingestion_id: Uuid,
  customer_id: Uuid,
  duplicate_of_customer_id: Uuid.nullable(),
  received_at: z.string(),
});

const SaleHoldRow = z.object({
  hold_id: Uuid,
  status: z.literal("held_for_reconciliation"),
  held_lines: z.array(
    z.object({
      variantId: Uuid,
      quantity: NumberValue,
      requestedQuantity: NumberValue,
    }),
  ),
  received_at: z.string(),
});

const OverridePasswordRow = z
  .object({
    membershipId: Uuid,
    verifierVersion: z.number().int().positive(),
    updatedAt: z.string().transform(iso),
    cleared: z.boolean().optional(),
  })
  .transform((row) => (row.cleared === undefined ? { ...row, cleared: undefined } : row));

function mapOverrideError(error: DatabaseErrorLike): Error {
  switch (error.code) {
    case "ST403":
      return new OfflinePosError("OVERRIDE_PASSWORD_NOT_ALLOWED");
    case "ST404":
      return new OfflinePosError("OVERRIDE_PASSWORD_NOT_SET");
    case "ST409":
      return new OfflinePosError("OVERRIDE_PASSWORD_NOT_ALLOWED");
    default:
      return mapError(error);
  }
}

const StockGrantRow = z.object({
  stockGrantId: Uuid,
  offlineGrantId: Uuid,
  status: z.enum(["active", "closed", "expired", "revoked"]),
  expiresAt: z.string(),
  enforced: z.boolean(),
  lines: z.array(
    z.object({
      variantId: Uuid,
      grantedQuantity: NumberValue,
      consumedQuantity: NumberValue,
      releasedQuantity: NumberValue,
    }),
  ),
});

export class SupabaseOfflinePosRepository implements OfflinePosRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.client.schema(PRIVATE_SCHEMA).rpc(name, args);
    if (error) throw mapError(error);
    return data;
  }

  async issueVoucherGrants(
    tenantId: string,
    offlineGrantId: string,
    closePreviousGrant: { offlineGrantId: string; finalSaleOrdinal: number } | undefined,
  ): Promise<OfflineVoucherGrant[]> {
    const { data, error } = await this.client
      .schema("promotions_private")
      .rpc("issue_offline_voucher_grants", {
        p_tenant: tenantId,
        p_offline_grant_id: offlineGrantId,
        p_previous_offline_grant_id: closePreviousGrant?.offlineGrantId ?? null,
        p_previous_final_ordinal: closePreviousGrant?.finalSaleOrdinal ?? null,
      });
    if (error) throw mapError(error);
    return OfflineVoucherGrantSchema.array().parse(
      (data as Array<Record<string, unknown>>).map((grant) => ({
        ...grant,
        expiresAt: iso(String(grant.expiresAt)),
        terms: {
          ...(grant.terms as Record<string, unknown>),
          endsAt:
            (grant.terms as { endsAt: string | null }).endsAt === null
              ? null
              : iso((grant.terms as { endsAt: string }).endsAt),
        },
      })),
    );
  }

  async issueVoucherPolicies(
    tenantId: string,
    offlineGrantId: string,
  ): Promise<OfflineVoucherPolicy[]> {
    const { data, error } = await this.client
      .schema("promotions_private")
      .rpc("issue_offline_voucher_policies", {
        p_tenant: tenantId,
        p_offline_grant_id: offlineGrantId,
      });
    if (error) throw mapError(error);
    return OfflineVoucherPolicySchema.array().parse(
      (data as Array<Record<string, unknown>>).map((policy) => {
        const terms = policy.terms as { endsAt: string | null } & Record<string, unknown>;
        return {
          ...policy,
          fetchedAt: iso(String(policy.fetchedAt)),
          expiresAt: iso(String(policy.expiresAt)),
          terms: { ...terms, endsAt: terms.endsAt === null ? null : iso(terms.endsAt) },
        };
      }),
    );
  }

  async getOverrideRoster(tenantId: string, registerId: string): Promise<OverrideVerifierEntry[]> {
    const { data, error } = await this.client
      .schema("staff_private")
      .rpc("pos_override_roster", { p_tenant: tenantId, p_register: registerId });
    if (error) throw mapError(error);
    return OverrideRosterRow.array()
      .parse(data ?? [])
      .map((row) => ({
        membershipId: row.membership_id,
        username: row.username,
        displayName: row.display_name,
        permissions: row.permissions,
        verifierVersion: row.verifier_version,
        verifier: {
          algorithm: row.verifier_algorithm,
          saltBase64: row.verifier_salt_base64,
          hashBase64: row.verifier_hash_base64,
          n: row.scrypt_n,
          r: row.scrypt_r,
          p: row.scrypt_p,
          keyLength: row.key_length,
        },
      }));
  }

  async recordOverrideIssuances(
    tenantId: string,
    offlineGrantId: string,
    entries: ReadonlyArray<{ membershipId: string; permission: string; verifierVersion: number }>,
  ): Promise<void> {
    await this.rpc("record_admin_verifier_issuances", {
      p_tenant_id: tenantId,
      p_offline_grant_id: offlineGrantId,
      p_entries: entries,
    });
  }

  async ingestCustomer(
    tenantId: string,
    credentialId: string,
    command: OfflineCustomerCommand,
    canonical: string,
    fingerprint: string,
    signature: string,
  ): Promise<IngestOfflineCustomerResponse> {
    const rows = await this.rpc("record_offline_customer", {
      p_tenant_id: tenantId,
      p_credential_id: credentialId,
      p_command: command,
      p_canonical: canonical,
      p_fingerprint: fingerprint,
      p_signature: signature,
    });
    const row = CustomerIngestionRow.parse(Array.isArray(rows) ? rows[0] : rows);
    return {
      ingestionId: row.ingestion_id,
      localCustomerId: command.localCustomerId,
      customerId: row.customer_id,
      duplicateOfCustomerId: row.duplicate_of_customer_id,
      receivedAt: iso(row.received_at),
    };
  }

  async ingestSaleHold(
    tenantId: string,
    hold: {
      credentialId: string;
      command: OfflineSaleHoldCommand;
      canonical: string;
      fingerprint: string;
      signature: string;
    },
    sale: {
      credentialId: string;
      command: OfflineSaleCommand;
      canonical: string;
      fingerprint: string;
      signature: string;
    },
  ): Promise<IngestOfflineSaleHoldResponse> {
    const rows = await this.rpc("record_offline_sale_hold", {
      p_tenant_id: tenantId,
      p_hold_credential_id: hold.credentialId,
      p_hold: hold.command,
      p_hold_canonical: hold.canonical,
      p_hold_fingerprint: hold.fingerprint,
      p_hold_signature: hold.signature,
      p_sale_credential_id: sale.credentialId,
      p_sale: sale.command,
      p_sale_canonical: sale.canonical,
      p_sale_fingerprint: sale.fingerprint,
      p_sale_signature: sale.signature,
    });
    const row = SaleHoldRow.parse(Array.isArray(rows) ? rows[0] : rows);
    return {
      holdId: row.hold_id,
      saleSyncCommandId: sale.command.syncCommandId,
      offlineSaleOrdinal: sale.command.offlineSaleOrdinal,
      status: row.status,
      heldLines: row.held_lines,
      receivedAt: iso(row.received_at),
    };
  }

  async setOverridePassword(
    tenantId: string,
    membershipId: string,
    idempotencyKey: string,
    verifier: OverrideServerVerifier,
    saltLength: number,
  ): Promise<PosOverridePasswordResponse> {
    const { data, error } = await this.client
      .schema("staff_private")
      .rpc("set_pos_override_password_v2", {
        p_tenant: tenantId,
        p_actor: membershipId,
        p_key: idempotencyKey,
        p_salt_base64: verifier.saltBase64,
        p_hash_base64: verifier.hashBase64,
        p_scrypt_n: verifier.n,
        p_scrypt_r: verifier.r,
        p_scrypt_p: verifier.p,
        p_key_length: verifier.keyLength,
        p_salt_length: saltLength,
      });
    if (error) throw mapOverrideError(error);
    return OverridePasswordRow.parse(data);
  }

  async clearOverridePassword(
    proof: AuthorizedOperationContext,
    tenantId: string,
    actorMembershipId: string,
    membershipId: string,
    idempotencyKey: string,
  ): Promise<PosOverridePasswordResponse> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client
      .schema("staff_private")
      .rpc("clear_pos_override_password", {
        p_tenant: tenantId,
        p_actor: actorMembershipId,
        p_key: idempotencyKey,
        p_membership: membershipId,
      });
    if (error) throw mapOverrideError(error);
    return OverridePasswordRow.parse(data);
  }

  async issueStockGrant(
    tenantId: string,
    offlineGrantId: string,
    closePreviousGrant: { offlineGrantId: string; finalSaleOrdinal: number } | undefined,
  ): Promise<OfflineStockGrant | null> {
    const { data, error } = await this.client
      .schema("inventory_private")
      .rpc("issue_offline_stock_grant", {
        p_tenant_id: tenantId,
        p_offline_grant_id: offlineGrantId,
        p_lines: null,
        p_previous_offline_grant_id: closePreviousGrant?.offlineGrantId ?? null,
        p_previous_final_ordinal: closePreviousGrant?.finalSaleOrdinal ?? null,
      });
    if (error) throw mapError(error);
    if (data === null || data === undefined) return null;
    const row = StockGrantRow.parse(data);
    return { ...row, expiresAt: iso(row.expiresAt) };
  }

  async enrollDevice(
    proof: AuthorizedOperationContext,
    tenantId: string,
    membershipId: string,
    input: EnrollPosDeviceRequest,
    fingerprint: string,
    idempotencyKey: string,
  ) {
    assertAuthorizedOperationProof(proof);
    return deviceResult(
      await this.rpc("enroll_device", {
        p_tenant_id: tenantId,
        p_register_id: input.registerId,
        p_membership_id: membershipId,
        p_installation_id: input.installationId,
        p_display_name: input.displayName,
        p_public_key: input.publicKey.value,
        p_fingerprint: fingerprint,
        p_client_version: input.clientVersion ?? null,
        p_platform: input.platform ?? null,
        p_os_version: input.osVersion ?? null,
        p_idempotency_key: idempotencyKey,
      }),
    );
  }

  async rotateCredential(
    proof: AuthorizedOperationContext,
    tenantId: string,
    deviceId: string,
    publicKey: string,
    fingerprint: string,
    idempotencyKey: string,
  ) {
    assertAuthorizedOperationProof(proof);
    return deviceResult(
      await this.rpc("rotate_credential", {
        p_tenant_id: tenantId,
        p_device_id: deviceId,
        p_public_key: publicKey,
        p_fingerprint: fingerprint,
        p_idempotency_key: idempotencyKey,
      }),
    );
  }

  async revokeDevice(
    proof: AuthorizedOperationContext,
    tenantId: string,
    deviceId: string,
    reason: string,
    idempotencyKey: string,
  ) {
    assertAuthorizedOperationProof(proof);
    return deviceResult(
      await this.rpc("revoke_device", {
        p_tenant_id: tenantId,
        p_device_id: deviceId,
        p_reason: reason,
        p_idempotency_key: idempotencyKey,
      }),
    );
  }

  async createBootstrap(
    proof: AuthorizedOperationContext,
    tenantId: string,
    membershipId: string,
    deviceId: string,
    registerId: string,
    idempotencyKey: string,
  ): Promise<OfflineBootstrapResponse> {
    assertAuthorizedOperationProof(proof);
    const rows = await this.rpc("issue_grant", {
      p_tenant_id: tenantId,
      p_device_id: deviceId,
      p_register_id: registerId,
      p_operator_membership_id: membershipId,
      p_idempotency_key: idempotencyKey,
    });
    const raw = Array.isArray(rows) ? rows[0] : rows;
    const grant = GrantRow.parse(raw);
    return {
      grantId: grant.id,
      snapshotId: grant.snapshot_id,
      schemaVersion: grant.schema_version,
      minimumClientVersion: grant.minimum_client_version,
      tenantId: grant.tenant_id,
      deviceId: grant.device_id,
      registerId: grant.register_id,
      branchId: grant.branch_id,
      inventoryLocationId: grant.inventory_location_id,
      operatorMembershipId: grant.operator_membership_id,
      currency: grant.currency,
      issuedAt: iso(grant.issued_at),
      operatorExpiresAt: iso(grant.operator_expires_at),
      catalogValidUntil: iso(grant.catalog_valid_until),
      acceptedUntil: iso(grant.accepted_until),
      policy: {
        enabled: true,
        operatorLeaseSeconds: Math.round(
          (new Date(grant.operator_expires_at).valueOf() - new Date(grant.issued_at).valueOf()) /
            1000,
        ),
        catalogGrantSeconds: Math.round(
          (new Date(grant.catalog_valid_until).valueOf() - new Date(grant.issued_at).valueOf()) /
            1000,
        ),
        maxSaleAmountMinor: grant.max_sale_amount_minor,
        maxCumulativeExposureMinor: grant.max_cumulative_exposure_minor,
        maxQuantityPerLine: grant.max_quantity_per_line,
        maxPendingOfflineSales: grant.max_pending_offline_sales,
        maxOfflineCreditExposureMinor: grant.max_offline_credit_exposure_minor,
        // Filled by the service from get_intent_operations (register opt-in); none by default.
        intentOperations: [],
      },
      customers: grant.customers_snapshot,
      catalog: grant.catalog_snapshot.map((product) => ({
        ...product,
        variants: product.variants.map((variant) => ({
          ...variant,
          priceVersion: iso(variant.priceVersion),
          advisoryInventory: {
            ...variant.advisoryInventory,
            asOf: iso(variant.advisoryInventory.asOf),
          },
        })),
      })),
    };
  }

  async getCredential(
    tenantId: string,
    credentialId: string,
    deviceId: string,
  ): Promise<OfflineCredential | null> {
    const { data, error } = await this.client
      .from("device_credentials")
      .select("device_id,public_key_spki_base64")
      .eq("tenant_id", tenantId)
      .eq("id", credentialId)
      .eq("device_id", deviceId)
      .limit(1);
    if (error) throw mapError(error);
    const row = data?.[0];
    return row
      ? { deviceId: String(row.device_id), publicKeySpkiBase64: String(row.public_key_spki_base64) }
      : null;
  }

  async setOfflinePin(
    proof: AuthorizedOperationContext,
    tenantId: string,
    actorMembershipId: string,
    membershipId: string,
    idempotencyKey: string,
    material: EncryptedOfflinePin,
    params: ScryptVerifierParams,
  ): Promise<SetStaffOfflinePinResponse> {
    assertAuthorizedOperationProof(proof);
    const { data, error } = await this.client.schema("staff_private").rpc("set_offline_pin", {
      p_tenant: tenantId,
      p_actor: actorMembershipId,
      p_key: idempotencyKey,
      p_membership: membershipId,
      p_key_version: material.keyVersion,
      p_cipher_algorithm: material.cipherAlgorithm,
      p_ciphertext: material.ciphertextBase64,
      p_iv: material.ivBase64,
      p_auth_tag: material.authTagBase64,
      p_scrypt_n: params.n,
      p_scrypt_r: params.r,
      p_scrypt_p: params.p,
      p_key_length: params.keyLength,
      p_salt_length: params.saltLength,
    });
    if (error) throw mapStaffPinError(error);
    const row = SetOfflinePinRow.parse(data);
    return {
      membershipId: row.membershipId,
      keyVersion: row.keyVersion,
      updatedAt: iso(row.updatedAt),
    };
  }

  async enrollOfflinePin(
    proof: AuthorizedOperationContext,
    tenantId: string,
    membershipId: string,
    deviceId: string,
    registerId: string,
    idempotencyKey: string,
  ): Promise<{ enrollmentId: string; verifierVersion: number; enrolledAt: string }> {
    assertAuthorizedOperationProof(proof);
    const { data: rows, error } = await this.client
      .schema(PRIVATE_SCHEMA)
      .rpc("enroll_offline_pin", {
        p_tenant: tenantId,
        p_membership: membershipId,
        p_device: deviceId,
        p_register: registerId,
        p_idempotency_key: idempotencyKey,
      });
    if (error) {
      if (error.code === "ST403" || error.code === "OG403" || error.code === "OD410")
        throw new OfflinePosError("OFFLINE_PIN_ENROLLMENT_DENIED");
      throw mapError(error);
    }
    const row = z
      .object({
        enrollment_id: Uuid,
        verifier_version: z.number().int().positive(),
        enrolled_at: z.string(),
      })
      .parse(Array.isArray(rows) ? rows[0] : rows);
    return {
      enrollmentId: row.enrollment_id,
      verifierVersion: row.verifier_version,
      enrolledAt: iso(row.enrolled_at),
    };
  }

  async revokeOfflinePinEnrollments(
    proof: AuthorizedOperationContext,
    tenantId: string,
    filter: { membershipId?: string; deviceId?: string },
    reason: string,
  ): Promise<number> {
    assertAuthorizedOperationProof(proof);
    const data = await this.rpc("revoke_offline_pin_enrollments", {
      p_tenant: tenantId,
      p_membership: filter.membershipId ?? null,
      p_device: filter.deviceId ?? null,
      p_reason: reason,
    });
    return z.number().int().nonnegative().parse(data);
  }

  async getOfflinePinAuthorizations(
    tenantId: string,
    registerId: string,
    deviceId: string,
  ): Promise<OfflinePinAuthorization[]> {
    const data = await this.rpc("offline_pin_authorizations", {
      p_tenant: tenantId,
      p_register: registerId,
      p_device: deviceId,
    });
    return z
      .array(
        z.object({
          membership_id: Uuid,
          username: z.string().min(1),
          display_name: z.string().min(1),
          enrollment_id: Uuid,
          verifier_version: z.number().int().positive(),
        }),
      )
      .parse(data ?? [])
      .map((row) => ({
        membershipId: row.membership_id,
        username: row.username,
        displayName: row.display_name,
        enrollmentId: row.enrollment_id,
        verifierVersion: row.verifier_version,
      }));
  }

  async getStaffRoster(tenantId: string, registerId: string): Promise<SealedRosterEntry[]> {
    const { data, error } = await this.client.schema("staff_private").rpc("offline_sell_roster", {
      p_tenant: tenantId,
      p_register: registerId,
    });
    if (error) throw mapStaffPinError(error);
    const rows = z.array(RosterRow).parse(data ?? []);
    return rows.map((row) => ({
      membershipId: row.membership_id,
      username: row.username,
      displayName: row.display_name,
      material: {
        keyVersion: row.key_version,
        cipherAlgorithm: row.cipher_algorithm,
        ciphertextBase64: row.ciphertext_base64,
        ivBase64: row.iv_base64,
        authTagBase64: row.auth_tag_base64,
      },
      params: {
        n: row.scrypt_n,
        r: row.scrypt_r,
        p: row.scrypt_p,
        keyLength: row.key_length,
        saltLength: row.salt_length,
      },
    }));
  }

  async ingest(
    tenantId: string,
    credentialId: string,
    command: OfflineSaleCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineSaleResponse> {
    const rows = await this.rpc("record_offline_sale", {
      p_tenant_id: tenantId,
      p_credential_id: credentialId,
      p_command: command,
      p_canonical: canonicalCommand,
      p_fingerprint: commandFingerprint,
      p_signature: signature,
    });
    const result = IngestionRow.parse(Array.isArray(rows) ? rows[0] : rows);
    const [
      { data: orderData, error: orderError },
      { data: lineData, error: lineError },
      { data: paymentData, error: paymentError },
    ] = await Promise.all([
      this.client
        .from("orders")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", result.order_id)
        .single(),
      this.client
        .from("order_lines")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("order_id", result.order_id)
        .order("line_number"),
      // Load EVERY captured tender for the order (a split sale has more than one), ordered by tender
      // sequence. Never a single-row/method assumption: a card/instapay/wallet tender is stored by
      // record_offline_sale's capture_payments branch and must be reported with its true method.
      this.client
        .from("payments")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("order_id", result.order_id)
        .order("tender_sequence", { ascending: true }),
    ]);
    if (orderError) throw mapError(orderError);
    if (lineError) throw mapError(lineError);
    if (paymentError) throw mapError(paymentError);
    const order = orderData as Record<string, unknown>;
    const orderResult = {
      id: String(order.id),
      orderNumber: String(order.order_number),
      channel: "pos" as const,
      status: "placed" as const,
      brandId: String(order.brand_id),
      branchId: String(order.branch_id),
      registerId: String(order.register_id),
      currency: String(order.currency),
      totalMinor: Number(order.total_minor),
      actorMembershipId: String(order.actor_membership_id),
      placedAt: iso(String(order.placed_at)),
      cancelledAt: null,
      cancelledByMembershipId: null,
      cancellationReason: null,
      notes: order.notes == null ? null : String(order.notes),
      createdAt: iso(String(order.created_at)),
      updatedAt: iso(String(order.updated_at)),
      lines: (lineData ?? []).map((line) => ({
        id: String(line.id),
        lineNumber: Number(line.line_number),
        variantId: String(line.variant_id),
        quantity: Number(line.quantity),
        unitPriceMinor: Number(line.unit_price_minor),
        lineTotalMinor: Number(line.line_total_minor),
        productName: String(line.product_name_snapshot),
        variantName: line.variant_name_snapshot == null ? null : String(line.variant_name_snapshot),
        sku: String(line.sku_snapshot),
        optionSummary:
          line.option_summary_snapshot == null ? null : String(line.option_summary_snapshot),
      })),
    };
    const mapPayment = (p: Record<string, unknown>): IngestOfflineSaleResponse["payment"] => ({
      id: String(p.id),
      orderId: String(p.order_id),
      // The stored method is authoritative — preserve it exactly (cash/card/instapay/wallet). The
      // response schema re-validates it, so an unexpected method fails closed rather than masquerading.
      method: String(p.method) as IngestOfflineSaleResponse["payment"]["method"],
      // ADR-042 §4.7: an offline non-cash tender is 'pending' (awaiting provider confirmation), never
      // reported as captured. Any other stored status fails closed in the response schema.
      status: String(p.status) as IngestOfflineSaleResponse["payment"]["status"],
      confirmation: "cashier_recorded" as const,
      currency: String(p.currency),
      amountMinor: Number(p.amount_minor),
      cashReceivedMinor: p.cash_received_minor == null ? null : Number(p.cash_received_minor),
      changeMinor: p.change_minor == null ? null : Number(p.change_minor),
      capturedByMembershipId: String(p.captured_by_membership_id),
      capturedAt: p.captured_at == null ? null : iso(String(p.captured_at)),
      createdAt: iso(String(p.created_at)),
      updatedAt: iso(String(p.updated_at)),
    });
    const payments = ((paymentData ?? []) as Array<Record<string, unknown>>).map(mapPayment);
    // The primary payment is the one record_offline_sale returned (cash-or-first); fall back to the first.
    const paymentResult =
      payments.find((candidate) => candidate.id === result.payment_id) ?? payments[0];
    if (!paymentResult)
      throw new Error("Offline sale ingestion returned an order with no captured payment.");
    let fulfillment: IngestOfflineSaleResponse["fulfillment"] = null;
    if (result.fulfillment_id) {
      const [
        { data: fulfillmentData, error: fulfillmentError },
        { data: fulfillmentLines, error: fulfillmentLinesError },
      ] = await Promise.all([
        this.client
          .from("fulfillments")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("id", result.fulfillment_id)
          .single(),
        this.client
          .from("fulfillment_lines")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("fulfillment_id", result.fulfillment_id)
          .order("line_number"),
      ]);
      if (fulfillmentError) throw mapError(fulfillmentError);
      if (fulfillmentLinesError) throw mapError(fulfillmentLinesError);
      const f = fulfillmentData as Record<string, unknown>;
      fulfillment = {
        id: String(f.id),
        orderId: String(f.order_id),
        inventoryLocationId: String(f.inventory_location_id),
        inventoryOperationId: String(f.inventory_operation_id),
        actorMembershipId: String(f.actor_membership_id),
        fulfilledAt: iso(String(f.fulfilled_at)),
        createdAt: iso(String(f.created_at)),
        lines: (fulfillmentLines ?? []).map((line) => ({
          id: String(line.id),
          lineNumber: Number(line.line_number),
          orderLineId: String(line.order_line_id),
          variantId: String(line.variant_id),
          quantity: Number(line.quantity),
        })),
      };
    }
    let reconciliation: IngestOfflineSaleResponse["reconciliation"] = null;
    if (result.reconciliation_id) {
      const { data, error } = await this.client
        .from("offline_reconciliations")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", result.reconciliation_id)
        .single();
      if (error) throw mapError(error);
      const row = data as Record<string, unknown>;
      reconciliation = {
        id: String(row.id),
        reason: String(row.reason) as
          "insufficient_stock_at_ingestion" | "device_revoked_at_ingestion",
        status: "open",
        createdAt: iso(String(row.created_at)),
        updatedAt: iso(String(row.updated_at)),
      };
    }
    return {
      syncStatus: result.sync_status,
      ingestionId: result.ingestion_id,
      localSaleId: command.localSaleId,
      receivedAt: iso(result.received_at),
      order: orderResult,
      payment: paymentResult,
      payments,
      fulfillment,
      reconciliation,
    };
  }

  async ingestPayment(
    tenantId: string,
    credentialId: string,
    command: OfflineCustomerPaymentCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineCustomerPaymentResponse> {
    const args = {
      p_tenant_id: tenantId,
      p_credential_id: credentialId,
      p_command: command,
      p_canonical: canonicalCommand,
      p_fingerprint: commandFingerprint,
      p_signature: signature,
    };
    // ADR-042 §13.5: a command already preserved as a conflict replays that conflict (never re-applied).
    const preserved = await this.replayPreservedConflict(tenantId, command.syncCommandId, args);
    if (preserved) return { ...preserved, localPaymentId: command.localPaymentId };
    const { data, error } = await this.client
      .schema(PRIVATE_SCHEMA)
      .rpc("record_offline_customer_payment", args);
    if (error?.code === "CA409") {
      const conflict = await this.preserveConflict("customer_payment", "CA409", args);
      return { ...conflict, localPaymentId: command.localPaymentId };
    }
    if (error) throw mapError(error);
    const result = PaymentIngestionRow.parse(Array.isArray(data) ? data[0] : data);
    return {
      syncStatus: result.sync_status,
      ingestionId: result.ingestion_id,
      localPaymentId: command.localPaymentId,
      receivedAt: iso(result.received_at),
      payment: {
        id: result.payment.id,
        customerId: result.payment.customerId,
        currency: result.payment.currency,
        amountMinor: result.payment.amountMinor,
        paidAt: iso(result.payment.paidAt),
        outstandingMinor: result.payment.outstandingMinor,
      },
    };
  }

  async ingestAttendance(
    tenantId: string,
    credentialId: string,
    command: OfflineAttendanceCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineAttendanceResponse> {
    const args = {
      p_tenant_id: tenantId,
      p_credential_id: credentialId,
      p_command: command,
      p_canonical: canonicalCommand,
      p_fingerprint: commandFingerprint,
      p_signature: signature,
    };
    const preserved = await this.replayPreservedConflict(tenantId, command.syncCommandId, args);
    if (preserved) return { ...preserved, localEventId: command.localEventId };
    const { data, error } = await this.client
      .schema(PRIVATE_SCHEMA)
      .rpc("record_offline_attendance", args);
    if (error?.code === "AT409" || error?.code === "AT404") {
      const conflict = await this.preserveConflict("attendance", error.code, args);
      return { ...conflict, localEventId: command.localEventId };
    }
    if (error) throw mapError(error);
    const result = AttendanceIngestionRow.parse(Array.isArray(data) ? data[0] : data);
    return {
      syncStatus: result.sync_status,
      ingestionId: result.ingestion_id,
      localEventId: command.localEventId,
      receivedAt: iso(result.received_at),
      event: {
        membershipId: result.membership_id,
        eventType: result.event_type,
        eventAt: iso(result.event_at),
        adjudication: result.adjudication_status,
      },
    };
  }

  /** ADR-042 §13.5: exact replay of a command previously preserved as a sync conflict, if any. */
  private async replayPreservedConflict(
    tenantId: string,
    syncCommandId: string,
    args: Record<string, unknown>,
  ): Promise<ConflictRecorded | null> {
    const { data, error } = await this.client
      .from("offline_conflict_ingestions")
      .select("command_kind,refusal_code")
      .eq("tenant_id", tenantId)
      .eq("sync_command_id", syncCommandId)
      .limit(1);
    if (error) throw mapError(error);
    const row = (data ?? [])[0] as { command_kind: string; refusal_code: string } | undefined;
    if (!row) return null;
    // The SQL function re-checks the fingerprint (different content => ID409) and returns the original.
    return this.preserveConflict(
      row.command_kind as "customer_payment" | "attendance",
      row.refusal_code as "CA409" | "AT409" | "AT404",
      args,
    );
  }

  private async preserveConflict(
    kind: "customer_payment" | "attendance",
    refusalCode: "CA409" | "AT409" | "AT404",
    args: Record<string, unknown>,
  ): Promise<ConflictRecorded> {
    const rows = await this.rpc("record_offline_conflict", {
      ...args,
      p_kind: kind,
      p_refusal_code: refusalCode,
    });
    const row = ConflictIngestionRow.parse(Array.isArray(rows) ? rows[0] : rows);
    return {
      syncStatus: "conflict_recorded",
      ingestionId: row.conflict_ingestion_id,
      receivedAt: iso(row.received_at),
      conflict: {
        id: row.conflict_id,
        kind: kind === "customer_payment" ? "customer_debt" : "attendance",
        reasonCode: row.reason_code,
      },
    };
  }

  async listSyncConflicts(
    proof: AuthorizedOperationContext,
    tenantId: string,
    filter: { registerId?: string; kind?: string; status?: string; limit: number },
  ): Promise<ListPosSyncConflictsResponse> {
    assertAuthorizedOperationProof(proof);
    let query = this.client
      .from("pos_sync_conflicts")
      .select(
        "id,kind,reason_code,status,branch_id,inventory_location_id,device_id,register_id,sync_command_id,local_reference,order_id,payment_id,customer_id,promotion_id,membership_id,variant_id,quantity,amount_minor,currency,local_evidence,server_evidence,local_event_at,detected_at",
      )
      .eq("tenant_id", tenantId);
    if (filter.registerId) query = query.eq("register_id", filter.registerId);
    if (filter.kind) query = query.eq("kind", filter.kind);
    if (filter.status) query = query.eq("status", filter.status);
    const { data, error } = await query
      .order("detected_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(filter.limit);
    if (error) throw mapError(error);
    const count = async (status: "open" | "informational") => {
      let head = this.client
        .from("pos_sync_conflicts")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", status);
      if (filter.registerId) head = head.eq("register_id", filter.registerId);
      const result = await head;
      if (result.error) throw mapError(result.error);
      return result.count ?? 0;
    };
    const [open, informational] = await Promise.all([count("open"), count("informational")]);
    const items = z
      .array(SyncConflictRow)
      .parse(data ?? [])
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        reasonCode: row.reason_code,
        status: row.status,
        branchId: row.branch_id,
        inventoryLocationId: row.inventory_location_id,
        deviceId: row.device_id,
        registerId: row.register_id,
        syncCommandId: row.sync_command_id,
        localReference: row.local_reference,
        references: {
          orderId: row.order_id,
          paymentId: row.payment_id,
          customerId: row.customer_id,
          promotionId: row.promotion_id,
          membershipId: row.membership_id,
          variantId: row.variant_id,
        },
        quantity: row.quantity === null ? null : Number(row.quantity),
        amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
        currency: row.currency,
        localEvidence: row.local_evidence,
        serverEvidence: row.server_evidence,
        localEventAt: row.local_event_at === null ? null : iso(row.local_event_at),
        detectedAt: iso(row.detected_at),
      }));
    return { generatedAt: new Date().toISOString(), summary: { open, informational }, items };
  }

  async getIntentOperations(
    tenantId: string,
    registerId: string,
  ): Promise<OfflineIntentOperation[]> {
    const data = await this.rpc("get_intent_operations", {
      p_tenant_id: tenantId,
      p_register_id: registerId,
    });
    // Unknown values (a newer DB vocabulary than this server) are dropped, never trusted.
    const values = Array.isArray(data) ? data : [];
    return values.flatMap((value) => {
      const parsed = OfflineIntentOperationSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async ingestIntent(
    tenantId: string,
    credentialId: string,
    command: OfflineIntentCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineIntentResponse> {
    const rows = await this.rpc("record_offline_intent", {
      p_tenant_id: tenantId,
      p_credential_id: credentialId,
      p_command: command,
      p_canonical: canonicalCommand,
      p_fingerprint: commandFingerprint,
      p_signature: signature,
    });
    const result = IntentIngestionRow.parse(Array.isArray(rows) ? rows[0] : rows);
    return {
      syncStatus: result.sync_status,
      ingestionId: result.ingestion_id,
      localIntentId: command.localIntentId,
      receivedAt: iso(result.received_at),
      intent: {
        operation: result.operation,
        disposition: result.disposition,
        code: result.disposition_code,
        policyVersion: result.policy_version,
        decidedAt: iso(result.decided_at),
        // Only the allowlisted safe evidence keys survive (strip); never raw client payload.
        detail: OfflineIntentDispositionDetailSchema.parse(result.disposition_detail ?? {}),
      },
    };
  }

  async issueReturnGrant(
    proof: AuthorizedOperationContext,
    tenantId: string,
    membershipId: string,
    deviceId: string,
    registerId: string,
    orderId: string,
    idempotencyKey: string,
  ): Promise<OfflineReturnGrantResponse> {
    assertAuthorizedOperationProof(proof);
    const rows = await this.rpc("issue_return_grant", {
      p_tenant_id: tenantId,
      p_device_id: deviceId,
      p_register_id: registerId,
      p_operator_membership_id: membershipId,
      p_order_id: orderId,
      p_idempotency_key: idempotencyKey,
    });
    const grant = ReturnGrantRow.parse(Array.isArray(rows) ? rows[0] : rows);
    return {
      returnGrantId: grant.id,
      snapshotId: grant.snapshot_id,
      schemaVersion: grant.schema_version,
      minimumClientVersion: grant.minimum_client_version,
      tenantId: grant.tenant_id,
      deviceId: grant.device_id,
      registerId: grant.register_id,
      branchId: grant.branch_id,
      inventoryLocationId: grant.inventory_location_id,
      operatorMembershipId: grant.operator_membership_id,
      orderId: grant.order_id,
      currency: grant.currency,
      issuedAt: iso(grant.issued_at),
      expiresAt: iso(grant.expires_at),
      maxRefundableMinor: grant.max_refundable_minor,
      requiresAdminCredentials: grant.requires_pos_admin_credentials ?? false,
      allowedReasons: grant.eligibility_snapshot.policy.allowedReasons ?? null,
      lines: grant.eligibility_snapshot.lines.map((line) => ({
        orderLineId: line.orderLineId,
        lineNumber: line.lineNumber,
        variantId: line.variantId,
        eligibleQuantity: line.eligibleQuantity,
        unitPriceMinor: line.unitPriceMinor,
      })),
    };
  }

  async ingestReturn(
    tenantId: string,
    credentialId: string,
    command: OfflineReturnCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineReturnResponse> {
    const rows = await this.rpc("record_offline_return", {
      p_tenant_id: tenantId,
      p_credential_id: credentialId,
      p_command: command,
      p_canonical: canonicalCommand,
      p_fingerprint: commandFingerprint,
      p_signature: signature,
    });
    const result = ReturnIngestionRow.parse(Array.isArray(rows) ? rows[0] : rows);
    const held = result.sync_status === "needs_reconciliation";
    let reconciliation: IngestOfflineReturnResponse["reconciliation"] = null;
    if (result.reconciliation_id) {
      // Read the held reason from the authoritative reconciliation row, mirroring the offline-sale path.
      const { data, error } = await this.client
        .from("offline_return_reconciliations")
        .select("id,reason")
        .eq("tenant_id", tenantId)
        .eq("id", result.reconciliation_id)
        .single();
      if (error) throw mapError(error);
      const row = data as Record<string, unknown>;
      reconciliation = {
        id: String(row.id),
        reason: String(row.reason) as
          "eligibility_drift_at_ingestion" | "device_revoked_at_ingestion",
        status: "open",
      };
    }
    return {
      syncStatus: result.sync_status,
      ingestionId: result.ingestion_id,
      localReturnId: command.localReturnId,
      receivedAt: iso(result.received_at),
      returnId: result.return_id,
      refund:
        held || result.refund_id === null || result.refund_amount_minor === null
          ? null
          : {
              id: result.refund_id,
              status: "pending",
              amountMinor: result.refund_amount_minor,
              currency: result.refund_currency ?? command.currency,
            },
      reconciliation,
    };
  }
}

export interface OfflinePosRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}
export function createSupabaseOfflinePosRepository(
  configuration: OfflinePosRepositoryConfiguration,
): SupabaseOfflinePosRepository {
  return new SupabaseOfflinePosRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    }),
  );
}
