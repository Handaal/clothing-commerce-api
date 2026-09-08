import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import type {
  EnrollPosDeviceRequest,
  IngestOfflineSaleResponse,
  OfflineBootstrapResponse,
  OfflineSaleCommand,
  PosDeviceResponse,
} from "../contracts";
import { OfflinePosError } from "./offline-errors";
import type { OfflineCredential, OfflinePosRepository } from "./offline-repository";

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
  catalog_snapshot: z.array(
    z.object({
      productId: Uuid,
      brandId: Uuid,
      name: z.string(),
      active: z.boolean(),
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

const IngestionRow = z.object({
  ingestion_id: Uuid,
  sync_status: z.enum(["synced", "needs_reconciliation"]),
  order_id: Uuid,
  payment_id: Uuid,
  fulfillment_id: Uuid.nullable(),
  reconciliation_id: Uuid.nullable(),
  received_at: z.string(),
});

export class SupabaseOfflinePosRepository implements OfflinePosRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.client.schema(PRIVATE_SCHEMA).rpc(name, args);
    if (error) throw mapError(error);
    return data;
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
      },
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
      this.client
        .from("payments")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", result.payment_id)
        .single(),
    ]);
    if (orderError) throw mapError(orderError);
    if (lineError) throw mapError(lineError);
    if (paymentError) throw mapError(paymentError);
    const order = orderData as Record<string, unknown>;
    const payment = paymentData as Record<string, unknown>;
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
    const paymentResult = {
      id: String(payment.id),
      orderId: String(payment.order_id),
      method: "cash" as const,
      status: "captured" as const,
      currency: String(payment.currency),
      amountMinor: Number(payment.amount_minor),
      cashReceivedMinor: Number(payment.cash_received_minor),
      changeMinor: Number(payment.change_minor),
      capturedByMembershipId: String(payment.captured_by_membership_id),
      capturedAt: iso(String(payment.captured_at)),
      createdAt: iso(String(payment.created_at)),
      updatedAt: iso(String(payment.updated_at)),
    };
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
      fulfillment,
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
