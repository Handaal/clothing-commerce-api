import { createHash, createPublicKey, verify } from "node:crypto";

import type { AuthorizationContext, AuthorizationService } from "../authorization";
import {
  canonicalizeOfflineAttendanceCommand,
  canonicalizeOfflineCustomerCommand,
  canonicalizeOfflineCustomerPaymentCommand,
  canonicalizeOfflineIntentCommand,
  canonicalizeOfflineReturnCommand,
  canonicalizeOfflineSaleCommand,
  canonicalizeOfflineSaleHoldCommand,
} from "../contracts/offline-signing";
import type {
  EnrollPosDeviceRequest,
  IngestOfflineAttendanceRequest,
  IngestOfflineAttendanceResponse,
  ListPosSyncConflictsResponse,
  ListPosSyncConflictsQuery,
  IngestOfflineCustomerRequest,
  IngestOfflineCustomerResponse,
  IngestOfflineSaleHoldRequest,
  IngestOfflineSaleHoldResponse,
  OfflineOverrideRosterEntry,
  PosOverridePasswordResponse,
  SetPosOverridePasswordRequest,
  IngestOfflineCustomerPaymentRequest,
  IngestOfflineCustomerPaymentResponse,
  IngestOfflineIntentRequest,
  IngestOfflineIntentResponse,
  IngestOfflineReturnRequest,
  IngestOfflineReturnResponse,
  IngestOfflineSaleRequest,
  IngestOfflineSaleResponse,
  OfflineBootstrapResponse,
  OfflineReturnGrantResponse,
  PosDeviceResponse,
  SetStaffOfflinePinRequest,
  EnrollOfflinePinRequest,
  EnrollOfflinePinResponse,
  RevokeOfflinePinEnrollmentsRequest,
  RevokeOfflinePinEnrollmentsResponse,
  SetStaffOfflinePinResponse,
} from "../contracts";
import { PosPermission } from "./model";
import { OfflinePosError } from "./offline-errors";
import type { OfflinePosRepository } from "./offline-repository";
import {
  OVERRIDE_VERIFIER_PARAMS,
  deriveOverrideDeviceVerifier,
  deriveOverrideServerVerifier,
} from "./override-password-crypto";
import type { PosSaleRepository } from "./repository";

const STAFF_MANAGE_PERMISSION = "staff.manage";

/**
 * Re-authenticates a POS account by username + PIN (honouring the sign-in lockout) and returns its
 * membership id, or null when the credentials are wrong. Supplied by the POS auth service.
 */
export type PosPinReauthenticator = (
  username: string,
  pin: string,
) => Promise<{ membershipId: string } | null>;

// A small built-in deny list (ADR-042 §6.3); the length and username/PIN rules do most of the work.
const COMMON_PASSWORDS = new Set([
  "1234567890",
  "0123456789",
  "0987654321",
  "1111111111",
  "password12",
  "password123",
  "password1234",
  "qwertyuiop",
  "qwerty1234",
  "qwerty12345",
  "asdfghjkl1",
  "iloveyou12",
  "letmein123",
  "welcome123",
  "admin12345",
  "abc1234567",
  "abcdefghij",
  "passw0rd12",
  "changeme12",
  "1q2w3e4r5t",
]);

/** ADR-042 §6.3 policy for the separate POS override password. Returns true when acceptable. */
export function isAcceptableOverridePassword(
  password: string,
  username: string,
  pin: string,
): boolean {
  if (password.length < 10 || password.length > 128) return false;
  const lower = password.toLowerCase();
  if (username.trim() !== "" && lower.includes(username.trim().toLowerCase())) return false;
  if (pin !== "" && password.includes(pin)) return false;
  if (COMMON_PASSWORDS.has(lower)) return false;
  if (new Set(password).size < 4) return false;
  return true;
}

function branch(id: string) {
  return { kind: "branch" as const, id };
}
function location(id: string) {
  return { kind: "inventory_location" as const, id };
}

function validatePublicKey(value: string): { fingerprint: string } {
  try {
    const der = Buffer.from(value, "base64");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return { fingerprint: createHash("sha256").update(der).digest("hex") };
  } catch {
    throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
  }
}

/** ADR-042 §13: offline returns are retired (online-only). Unconditional; kept greppable. */
export const OFFLINE_RETURNS_DISABLED = true as const;

export class OfflinePosService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly posRepository: PosSaleRepository,
    private readonly repository: OfflinePosRepository,
    // RETIRED slot (20261115170000): formerly the OFFLINE_PIN_KEK configuration. Ignored; kept only so
    // existing positional call sites compile. Nothing reads or needs the KEK.
    retiredOfflinePinKek: unknown = null,
    private readonly pinReauth: PosPinReauthenticator | null = null,
    // ADR-042 §13.6 (POS_OFFLINE_CACHED_VOUCHERS): default off ⇒ every voucher stays online-only.
    private readonly cachedVouchersEnabled = false,
    // Offline PIN v2 (POS_OFFLINE_PIN_V2): default off ⇒ enrollment refuses (OFFLINE_PIN_DISABLED) and the
    // bootstrap lists no offline unlock authorizations, so offline PIN sign-in is unavailable on every till.
    // The retired KEK (OFFLINE_PIN_KEK) is not a parameter any more: nothing reads it.
    private readonly offlinePinV2Enabled = false,
  ) {
    void retiredOfflinePinKek;
  }

  private async authorizeRegister(context: AuthorizationContext, registerId: string) {
    const register = await this.posRepository.getRegisterContext(context.tenant.id, registerId);
    if (!register) throw new OfflinePosError("DEVICE_NOT_FOUND");
    const permissions = [
      [PosPermission.createOrder, branch(register.branchId)],
      [PosPermission.fulfillOrder, branch(register.branchId)],
      [PosPermission.readOrder, branch(register.branchId)],
      [PosPermission.capturePayment, branch(register.branchId)],
      [PosPermission.issueInventory, location(register.inventoryLocationId)],
    ] as const;
    const proofs = await Promise.all(
      permissions.map(([permissionKey, resource]) =>
        this.authorization.authorize(context, { permissionKey, resources: [resource] }),
      ),
    );
    return proofs[0]!;
  }

  async enrollDevice(
    context: AuthorizationContext,
    input: EnrollPosDeviceRequest,
    idempotencyKey: string,
  ): Promise<PosDeviceResponse> {
    const proof = await this.authorizeRegister(context, input.registerId);
    const { fingerprint } = validatePublicKey(input.publicKey.value);
    return this.repository.enrollDevice(
      proof,
      context.tenant.id,
      context.membership.id,
      input,
      fingerprint,
      idempotencyKey,
    );
  }

  async rotateCredential(
    context: AuthorizationContext,
    deviceId: string,
    registerId: string,
    publicKey: string,
    idempotencyKey: string,
  ): Promise<PosDeviceResponse> {
    const proof = await this.authorizeRegister(context, registerId);
    const { fingerprint } = validatePublicKey(publicKey);
    return this.repository.rotateCredential(
      proof,
      context.tenant.id,
      deviceId,
      publicKey,
      fingerprint,
      idempotencyKey,
    );
  }

  async revokeDevice(
    context: AuthorizationContext,
    deviceId: string,
    registerId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<PosDeviceResponse> {
    const proof = await this.authorizeRegister(context, registerId);
    return this.repository.revokeDevice(proof, context.tenant.id, deviceId, reason, idempotencyKey);
  }

  /**
   * ADR-042 §13.5: the post-sync conflict report. With `registerId` the caller needs the till's register
   * permissions and sees that register only (the POS Sync Conflicts section); without it the caller needs
   * tenant-wide `orders.read` (admin-mobile). Read-only: nothing here approves or mutates a record.
   */
  async listSyncConflicts(
    context: AuthorizationContext,
    query: ListPosSyncConflictsQuery,
  ): Promise<ListPosSyncConflictsResponse> {
    const proof = query.registerId
      ? await this.authorizeRegister(context, query.registerId)
      : await this.authorization.authorize(context, { permissionKey: PosPermission.readOrder });
    if (!this.repository.listSyncConflicts) {
      return {
        generatedAt: new Date().toISOString(),
        summary: { open: 0, informational: 0 },
        items: [],
      };
    }
    return this.repository.listSyncConflicts(proof, context.tenant.id, {
      ...(query.registerId ? { registerId: query.registerId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      limit: query.limit,
    });
  }

  async createBootstrap(
    context: AuthorizationContext,
    deviceId: string,
    registerId: string,
    idempotencyKey: string,
    closePreviousGrant?: { offlineGrantId: string; finalSaleOrdinal: number },
  ): Promise<OfflineBootstrapResponse> {
    const proof = await this.authorizeRegister(context, registerId);
    const issued = await this.repository.createBootstrap(
      proof,
      context.tenant.id,
      context.membership.id,
      deviceId,
      registerId,
      idempotencyKey,
    );
    // ADR-042 §13 (owner decision 2026-11-14 night): online-first POS with bounded emergency offline.
    // Stock is ONE shared pool, so no per-till stock grant is issued; the reserved-quota voucher grants and
    // the admin override roster are superseded too (credential-gated offline checks stay unavailable). `closePreviousGrant` is still accepted from older tills
    // and deliberately ignored: no future sign-in depends on closing a stock grant.
    void closePreviousGrant;
    // ADR-042 §13.6: cached policies of existing vouchers (no reservation). Off unless the server flag is on.
    const voucherPolicies =
      this.cachedVouchersEnabled && this.repository.issueVoucherPolicies
        ? await this.repository.issueVoucherPolicies(context.tenant.id, issued.grantId)
        : [];
    const bootstrap = voucherPolicies.length > 0 ? { ...issued, voucherPolicies } : issued;
    // Offline PIN v2: who may unlock THIS device offline (enrollment id + version only; no PIN material).
    const offlinePinAuthorizations =
      this.offlinePinV2Enabled && this.repository.getOfflinePinAuthorizations
        ? await this.repository.getOfflinePinAuthorizations(context.tenant.id, registerId, deviceId)
        : [];
    const intentOperations = await this.repository.getIntentOperations(
      context.tenant.id,
      registerId,
    );
    const withPolicy = {
      ...bootstrap,
      policy: { ...bootstrap.policy, intentOperations },
    };
    return offlinePinAuthorizations.length > 0
      ? { ...withPolicy, offlinePinAuthorizations }
      : withPolicy;
  }

  /**
   * ADR-042 §6.3 (v2): device-, admin- and version-bound verifier tags of the admins whose credentials the
   * till may check, and a server record of exactly which (admin, permission, verifier version) were issued to
   * this offline grant. No plaintext and no key-recoverable copy is involved: the tag is an HMAC of the stored
   * one-way scrypt verifier (see override-password-crypto.ts). Needs no server KEK.
   */
  private async buildOverrideRoster(
    tenantId: string,
    registerId: string,
    deviceId: string,
    offlineGrantId: string,
    acceptedUntil: string,
  ): Promise<OfflineOverrideRosterEntry[]> {
    if (!this.repository.getOverrideRoster) return [];
    const stored = await this.repository.getOverrideRoster(tenantId, registerId);
    if (stored.length === 0) return [];
    const entries = stored.map((entry) => ({
      membershipId: entry.membershipId,
      username: entry.username,
      displayName: entry.displayName,
      permissions: entry.permissions,
      verifierVersion: entry.verifierVersion,
      verifier: deriveOverrideDeviceVerifier(
        entry.verifier,
        deviceId,
        entry.membershipId,
        entry.verifierVersion,
      ),
      expiresAt: acceptedUntil,
    }));
    await this.repository.recordOverrideIssuances?.(
      tenantId,
      offlineGrantId,
      entries.flatMap((entry) =>
        entry.permissions.map((permission) => ({
          membershipId: entry.membershipId,
          permission,
          verifierVersion: entry.verifierVersion,
        })),
      ),
    );
    return entries;
  }

  /**
   * ADR-042 D-6: set or change MY OWN POS override password. The caller re-authenticates with their POS
   * username + PIN (the same lockout as sign-in applies); the password must meet the override policy. Only a
   * one-way scrypt verifier (v2) reaches the database: never plaintext, never a recoverable encrypted copy.
   */
  async setOverridePassword(
    context: AuthorizationContext,
    idempotencyKey: string,
    input: SetPosOverridePasswordRequest,
  ): Promise<PosOverridePasswordResponse> {
    if (this.pinReauth === null || !this.repository.setOverridePassword) {
      throw new OfflinePosError("OVERRIDE_PASSWORD_NOT_CONFIGURED");
    }
    const account = await this.pinReauth(input.username, input.pin);
    if (account === null || account.membershipId !== context.membership.id) {
      throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    }
    if (!isAcceptableOverridePassword(input.password, input.username, input.pin)) {
      throw new OfflinePosError("OVERRIDE_PASSWORD_REJECTED");
    }
    const verifier = deriveOverrideServerVerifier(input.password, OVERRIDE_VERIFIER_PARAMS);
    return this.repository.setOverridePassword(
      context.tenant.id,
      context.membership.id,
      idempotencyKey,
      verifier,
      OVERRIDE_VERIFIER_PARAMS.saltLength,
    );
  }

  /** Clear another account's override password (staff.manage). It is never read or set by an admin. */
  async clearOverridePassword(
    context: AuthorizationContext,
    membershipId: string,
    idempotencyKey: string,
  ): Promise<PosOverridePasswordResponse> {
    if (!this.repository.clearOverridePassword) {
      throw new OfflinePosError("OVERRIDE_PASSWORD_NOT_CONFIGURED");
    }
    const proof = await this.authorization.authorize(context, {
      permissionKey: STAFF_MANAGE_PERMISSION,
    });
    return this.repository.clearOverridePassword(
      proof,
      context.tenant.id,
      context.membership.id,
      membershipId,
      idempotencyKey,
    );
  }

  /** ADR-042 §8: device-signed new-customer command captured offline. */
  async ingestCustomer(
    tenantId: string,
    input: IngestOfflineCustomerRequest,
  ): Promise<IngestOfflineCustomerResponse> {
    if (!this.repository.ingestCustomer) throw new OfflinePosError("OFFLINE_DISABLED");
    const canonical = canonicalizeOfflineCustomerCommand(input.command);
    await this.verifyDeviceSignature(
      tenantId,
      input.signature.credentialId,
      input.command.deviceId,
      canonical,
      input.signature.value,
    );
    const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
    return this.repository.ingestCustomer(
      tenantId,
      input.signature.credentialId,
      input.command,
      canonical,
      fingerprint,
      input.signature.value,
    );
  }

  /**
   * ADR-042 §4.6 (Finding A): terminal hold for an offline sale whose offline-created customer the server
   * rejected. Both device signatures are verified (the original sale as signed at acceptance, and the hold
   * that names its fingerprint); the RPC checks binding, grant window, ordinal use and that the customer
   * genuinely does not exist, then atomically records held_for_reconciliation and keeps the sale's units
   * reserved. No person approves anything; exact replay returns the original receipt.
   */
  async ingestSaleHold(
    tenantId: string,
    input: IngestOfflineSaleHoldRequest,
  ): Promise<IngestOfflineSaleHoldResponse> {
    if (!this.repository.ingestSaleHold) throw new OfflinePosError("OFFLINE_DISABLED");
    const saleCanonical = canonicalizeOfflineSaleCommand(input.sale.command);
    await this.verifyDeviceSignature(
      tenantId,
      input.sale.signature.credentialId,
      input.sale.command.deviceId,
      saleCanonical,
      input.sale.signature.value,
    );
    const holdCanonical = canonicalizeOfflineSaleHoldCommand(input.command);
    await this.verifyDeviceSignature(
      tenantId,
      input.signature.credentialId,
      input.command.deviceId,
      holdCanonical,
      input.signature.value,
    );
    const saleFingerprint = createHash("sha256").update(saleCanonical, "utf8").digest("hex");
    if (
      input.command.saleCommandFingerprint !== saleFingerprint ||
      input.command.saleSyncCommandId !== input.sale.command.syncCommandId
    ) {
      throw new OfflinePosError("OFFLINE_SALE_HOLD_INVALID");
    }
    return this.repository.ingestSaleHold(
      tenantId,
      {
        credentialId: input.signature.credentialId,
        command: input.command,
        canonical: holdCanonical,
        fingerprint: createHash("sha256").update(holdCanonical, "utf8").digest("hex"),
        signature: input.signature.value,
      },
      {
        credentialId: input.sale.signature.credentialId,
        command: input.sale.command,
        canonical: saleCanonical,
        fingerprint: saleFingerprint,
        signature: input.sale.signature.value,
      },
    );
  }

  /**
   * RETIRED (20261115170000): manager-set offline PINs were sealed under the server KEK so every bootstrap
   * could decrypt them. That model is withdrawn (an exposed KEK + a database dump would reveal every PIN), so
   * this always refuses. Staff enrol their own offline PIN on the till while online (enrollOfflinePin).
   */
  async setOfflinePin(
    context: AuthorizationContext,
    membershipId: string,
    idempotencyKey: string,
    input: SetStaffOfflinePinRequest,
  ): Promise<SetStaffOfflinePinResponse> {
    void context;
    void membershipId;
    void idempotencyKey;
    void input;
    throw new OfflinePosError("OFFLINE_PIN_REENROLLMENT_REQUIRED");
  }

  /**
   * Offline PIN v2: the AUTHENTICATED caller enrols THEMSELVES on one device assigned to the register. The
   * request carries no PIN; the till derives and seals the device-bound verifier in its main process only after
   * this succeeds. Requires the register's seller permissions (the same set offline selling needs).
   */
  async enrollOfflinePin(
    context: AuthorizationContext,
    input: EnrollOfflinePinRequest,
    idempotencyKey: string,
  ): Promise<EnrollOfflinePinResponse> {
    if (!this.offlinePinV2Enabled) throw new OfflinePosError("OFFLINE_PIN_DISABLED");
    const proof = await this.authorizeRegister(context, input.registerId);
    if (!this.repository.enrollOfflinePin) throw new OfflinePosError("OFFLINE_PIN_NOT_CONFIGURED");
    // Freshness (step-up): a merely unexpired access token is NOT enough. The person re-proves their own
    // online POS credential IN THIS REQUEST; the server verifies it with the sign-in verifier and the same
    // persistent lockout as sign-in, and it must resolve to the caller's own membership. Nothing about it is
    // stored. This is the online sign-in PIN (already sent at every connected sign-in) — never the new offline
    // PIN, which never leaves the till.
    if (this.pinReauth === null) throw new OfflinePosError("OFFLINE_PIN_NOT_CONFIGURED");
    const stepUp = await this.pinReauth(input.stepUp.username, input.stepUp.pin);
    if (stepUp === null || stepUp.membershipId !== context.membership.id) {
      throw new OfflinePosError("OFFLINE_PIN_STEP_UP_FAILED");
    }
    const enrolled = await this.repository.enrollOfflinePin(
      proof,
      context.tenant.id,
      context.membership.id,
      input.deviceId,
      input.registerId,
      idempotencyKey,
    );
    return { membershipId: context.membership.id, deviceId: input.deviceId, ...enrolled };
  }

  /**
   * Revoke offline PIN enrollments. Anyone may revoke their OWN; revoking someone else's (or a whole device)
   * needs tenant-wide staff.manage. Takes effect at the device's next online bootstrap and, at the latest,
   * when its current lease ends.
   */
  async revokeOfflinePinEnrollments(
    context: AuthorizationContext,
    input: RevokeOfflinePinEnrollmentsRequest,
  ): Promise<RevokeOfflinePinEnrollmentsResponse> {
    const ownOnly = input.membershipId === context.membership.id;
    const proof = ownOnly
      ? await this.authorization.authorize(context, { permissionKey: PosPermission.readOrder })
      : await this.authorization.authorize(context, { permissionKey: STAFF_MANAGE_PERMISSION });
    if (!this.repository.revokeOfflinePinEnrollments)
      throw new OfflinePosError("OFFLINE_PIN_NOT_CONFIGURED");
    const revoked = await this.repository.revokeOfflinePinEnrollments(
      proof,
      context.tenant.id,
      {
        ...(input.membershipId ? { membershipId: input.membershipId } : {}),
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      },
      input.reason,
    );
    return { revoked };
  }

  async ingest(
    tenantId: string,
    input: IngestOfflineSaleRequest,
  ): Promise<IngestOfflineSaleResponse> {
    const canonical = canonicalizeOfflineSaleCommand(input.command);
    const credential = await this.repository.getCredential(
      tenantId,
      input.signature.credentialId,
      input.command.deviceId,
    );
    if (!credential) throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    try {
      const key = createPublicKey({
        key: Buffer.from(credential.publicKeySpkiBase64, "base64"),
        format: "der",
        type: "spki",
      });
      if (
        !verify(
          null,
          Buffer.from(canonical, "utf8"),
          key,
          Buffer.from(input.signature.value, "base64"),
        )
      ) {
        throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
      }
    } catch (error) {
      if (error instanceof OfflinePosError) throw error;
      throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    }
    const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
    return this.repository.ingest(
      tenantId,
      input.signature.credentialId,
      input.command,
      canonical,
      fingerprint,
      input.signature.value,
    );
  }

  async ingestPayment(
    tenantId: string,
    input: IngestOfflineCustomerPaymentRequest,
  ): Promise<IngestOfflineCustomerPaymentResponse> {
    const canonical = canonicalizeOfflineCustomerPaymentCommand(input.command);
    const credential = await this.repository.getCredential(
      tenantId,
      input.signature.credentialId,
      input.command.deviceId,
    );
    if (!credential) throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    try {
      const key = createPublicKey({
        key: Buffer.from(credential.publicKeySpkiBase64, "base64"),
        format: "der",
        type: "spki",
      });
      if (
        !verify(
          null,
          Buffer.from(canonical, "utf8"),
          key,
          Buffer.from(input.signature.value, "base64"),
        )
      ) {
        throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
      }
    } catch (error) {
      if (error instanceof OfflinePosError) throw error;
      throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    }
    const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
    return this.repository.ingestPayment(
      tenantId,
      input.signature.credentialId,
      input.command,
      canonical,
      fingerprint,
      input.signature.value,
    );
  }

  /**
   * Ingest a provisional offline operation intent. Same device-signature verification as every other
   * offline lane; the RPC enforces grant binding/window/credential, the register's opt-in list, and
   * dependency ordering, then AUTOMATICALLY disposes the intent in the same transaction: a typed handler
   * applies the authorized effect (applied) or the server rejects / marks a conflict / fails closed on a
   * missing handler policy. No human approval step exists; exact replay returns the original disposition.
   */
  async ingestIntent(
    tenantId: string,
    input: IngestOfflineIntentRequest,
  ): Promise<IngestOfflineIntentResponse> {
    const canonical = canonicalizeOfflineIntentCommand(input.command);
    await this.verifyDeviceSignature(
      tenantId,
      input.signature.credentialId,
      input.command.deviceId,
      canonical,
      input.signature.value,
    );
    const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
    return this.repository.ingestIntent(
      tenantId,
      input.signature.credentialId,
      input.command,
      canonical,
      fingerprint,
      input.signature.value,
    );
  }

  private async verifyDeviceSignature(
    tenantId: string,
    credentialId: string,
    deviceId: string,
    canonical: string,
    signatureBase64: string,
  ): Promise<void> {
    const credential = await this.repository.getCredential(tenantId, credentialId, deviceId);
    if (!credential) throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    let valid = false;
    try {
      const key = createPublicKey({
        key: Buffer.from(credential.publicKeySpkiBase64, "base64"),
        format: "der",
        type: "spki",
      });
      valid = verify(
        null,
        Buffer.from(canonical, "utf8"),
        key,
        Buffer.from(signatureBase64, "base64"),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
  }

  async ingestAttendance(
    tenantId: string,
    input: IngestOfflineAttendanceRequest,
  ): Promise<IngestOfflineAttendanceResponse> {
    const canonical = canonicalizeOfflineAttendanceCommand(input.command);
    const credential = await this.repository.getCredential(
      tenantId,
      input.signature.credentialId,
      input.command.deviceId,
    );
    if (!credential) throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    try {
      const key = createPublicKey({
        key: Buffer.from(credential.publicKeySpkiBase64, "base64"),
        format: "der",
        type: "spki",
      });
      if (
        !verify(
          null,
          Buffer.from(canonical, "utf8"),
          key,
          Buffer.from(input.signature.value, "base64"),
        )
      ) {
        throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
      }
    } catch (error) {
      if (error instanceof OfflinePosError) throw error;
      throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    }
    const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
    return this.repository.ingestAttendance(
      tenantId,
      input.signature.credentialId,
      input.command,
      canonical,
      fingerprint,
      input.signature.value,
    );
  }

  /**
   * Issue a bounded offline RETURN grant for one original order while ONLINE. Authorized by the same
   * register permission set as device enrollment/bootstrap. The grant freezes server-authoritative
   * eligibility; the till may later offer only grant-pre-authorized lines/amounts while disconnected.
   */
  async issueReturnGrant(
    context: AuthorizationContext,
    deviceId: string,
    registerId: string,
    orderId: string,
    idempotencyKey: string,
  ): Promise<OfflineReturnGrantResponse> {
    // ADR-042 §13: returns are online-only. Refused before authorization side effects or any DB call.
    void [context, deviceId, registerId, orderId, idempotencyKey];
    if (OFFLINE_RETURNS_DISABLED) throw new OfflinePosError("OFFLINE_RETURNS_DISABLED");
    const proof = await this.authorizeRegister(context, registerId);
    return this.repository.issueReturnGrant(
      proof,
      context.tenant.id,
      context.membership.id,
      deviceId,
      registerId,
      orderId,
      idempotencyKey,
    );
  }

  async ingestReturn(
    tenantId: string,
    input: IngestOfflineReturnRequest,
  ): Promise<IngestOfflineReturnResponse> {
    // ADR-042 §13: a stale till may still send a queued offline return. Fail closed with a deterministic
    // online-required error: no return, refund, inventory or payment side effect, no DB call.
    if (OFFLINE_RETURNS_DISABLED) throw new OfflinePosError("OFFLINE_RETURNS_DISABLED");
    const canonical = canonicalizeOfflineReturnCommand(input.command);
    const credential = await this.repository.getCredential(
      tenantId,
      input.signature.credentialId,
      input.command.deviceId,
    );
    if (!credential) throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    try {
      const key = createPublicKey({
        key: Buffer.from(credential.publicKeySpkiBase64, "base64"),
        format: "der",
        type: "spki",
      });
      if (
        !verify(
          null,
          Buffer.from(canonical, "utf8"),
          key,
          Buffer.from(input.signature.value, "base64"),
        )
      ) {
        throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
      }
    } catch (error) {
      if (error instanceof OfflinePosError) throw error;
      throw new OfflinePosError("OFFLINE_SIGNATURE_INVALID");
    }
    const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
    return this.repository.ingestReturn(
      tenantId,
      input.signature.credentialId,
      input.command,
      canonical,
      fingerprint,
      input.signature.value,
    );
  }
}
