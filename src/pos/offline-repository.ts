import type { AuthorizedOperationContext } from "../authorization";
import type {
  EnrollPosDeviceRequest,
  IngestOfflineAttendanceResponse,
  IngestOfflineCustomerPaymentResponse,
  IngestOfflineIntentResponse,
  IngestOfflineReturnResponse,
  IngestOfflineSaleResponse,
  OfflineAttendanceCommand,
  OfflineBootstrapResponse,
  OfflineStockGrant,
  OfflineVoucherGrant,
  OfflineVoucherPolicy,
  OfflinePinAuthorization,
  IngestOfflineCustomerResponse,
  IngestOfflineSaleHoldResponse,
  OfflineSaleHoldCommand,
  OfflineCustomerCommand,
  PosOverridePasswordResponse,
  OfflineCustomerPaymentCommand,
  OfflineIntentCommand,
  OfflineIntentOperation,
  OfflineReturnCommand,
  OfflineReturnGrantResponse,
  OfflineSaleCommand,
  PosDeviceResponse,
  SetStaffOfflinePinResponse,
  ListPosSyncConflictsResponse,
} from "../contracts";
import type { EncryptedOfflinePin, ScryptVerifierParams } from "./offline-pin-crypto";
import type { OverrideServerVerifier } from "./override-password-crypto";

export interface OfflineCredential {
  readonly deviceId: string;
  readonly publicKeySpkiBase64: string;
}

/** A roster row as stored: the PIN is still SEALED. The service unseals it transiently to derive the
 * device-bound verifier; the repository never touches plaintext or the KEK. */
export interface SealedRosterEntry {
  readonly membershipId: string;
  readonly username: string;
  readonly displayName: string;
  readonly material: EncryptedOfflinePin;
  readonly params: ScryptVerifierParams;
}

export interface OfflinePosRepository {
  enrollDevice(
    proof: AuthorizedOperationContext,
    tenantId: string,
    membershipId: string,
    input: EnrollPosDeviceRequest,
    fingerprint: string,
    idempotencyKey: string,
  ): Promise<PosDeviceResponse>;
  rotateCredential(
    proof: AuthorizedOperationContext,
    tenantId: string,
    deviceId: string,
    publicKey: string,
    fingerprint: string,
    idempotencyKey: string,
  ): Promise<PosDeviceResponse>;
  revokeDevice(
    proof: AuthorizedOperationContext,
    tenantId: string,
    deviceId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<PosDeviceResponse>;
  createBootstrap(
    proof: AuthorizedOperationContext,
    tenantId: string,
    membershipId: string,
    deviceId: string,
    registerId: string,
    idempotencyKey: string,
  ): Promise<OfflineBootstrapResponse>;
  /**
   * ADR-042 §4: reserve this offline grant's POS stock (null at a legacy location), first closing the
   * register's previous stock grant when the till reports it. Idempotent per offline grant.
   */
  issueStockGrant?(
    tenantId: string,
    offlineGrantId: string,
    closePreviousGrant: { offlineGrantId: string; finalSaleOrdinal: number } | undefined,
  ): Promise<OfflineStockGrant | null>;
  /** ADR-042 §5: reserve offline voucher quota for this offline grant (closing the previous grant's). */
  issueVoucherGrants?(
    tenantId: string,
    offlineGrantId: string,
    closePreviousGrant: { offlineGrantId: string; finalSaleOrdinal: number } | undefined,
  ): Promise<OfflineVoucherGrant[]>;
  /**
   * ADR-042 §13.6: record (once per lease) and return the cached policy of every voucher eligible for offline
   * redemption. Reserves nothing.
   */
  issueVoucherPolicies?(tenantId: string, offlineGrantId: string): Promise<OfflineVoucherPolicy[]>;
  /** ADR-042 §6.3: qualifying admins with a live override password (one-way v2 verifier only). */
  getOverrideRoster?(tenantId: string, registerId: string): Promise<OverrideVerifierEntry[]>;
  /** Record which verifiers the bootstrap issued to this offline grant. */
  recordOverrideIssuances?(
    tenantId: string,
    offlineGrantId: string,
    entries: ReadonlyArray<{ membershipId: string; permission: string; verifierVersion: number }>,
  ): Promise<void>;
  ingestCustomer?(
    tenantId: string,
    credentialId: string,
    command: OfflineCustomerCommand,
    canonical: string,
    fingerprint: string,
    signature: string,
  ): Promise<IngestOfflineCustomerResponse>;
  /** ADR-042 §4.6: record a terminal hold for an offline sale (signatures already verified). */
  ingestSaleHold?(
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
  ): Promise<IngestOfflineSaleHoldResponse>;
  setOverridePassword?(
    tenantId: string,
    membershipId: string,
    idempotencyKey: string,
    verifier: OverrideServerVerifier,
    saltLength: number,
  ): Promise<PosOverridePasswordResponse>;
  clearOverridePassword?(
    proof: AuthorizedOperationContext,
    tenantId: string,
    actorMembershipId: string,
    membershipId: string,
    idempotencyKey: string,
  ): Promise<PosOverridePasswordResponse>;
  getCredential(
    tenantId: string,
    credentialId: string,
    deviceId: string,
  ): Promise<OfflineCredential | null>;
  setOfflinePin(
    proof: AuthorizedOperationContext,
    tenantId: string,
    actorMembershipId: string,
    membershipId: string,
    idempotencyKey: string,
    material: EncryptedOfflinePin,
    params: ScryptVerifierParams,
  ): Promise<SetStaffOfflinePinResponse>;
  getStaffRoster(tenantId: string, registerId: string): Promise<SealedRosterEntry[]>;
  /** Offline PIN v2: enrol the caller on a device (no PIN material). */
  enrollOfflinePin?(
    proof: AuthorizedOperationContext,
    tenantId: string,
    membershipId: string,
    deviceId: string,
    registerId: string,
    idempotencyKey: string,
  ): Promise<{ enrollmentId: string; verifierVersion: number; enrolledAt: string }>;
  revokeOfflinePinEnrollments?(
    proof: AuthorizedOperationContext,
    tenantId: string,
    filter: { membershipId?: string; deviceId?: string },
    reason: string,
  ): Promise<number>;
  getOfflinePinAuthorizations?(
    tenantId: string,
    registerId: string,
    deviceId: string,
  ): Promise<OfflinePinAuthorization[]>;
  ingest(
    tenantId: string,
    credentialId: string,
    command: OfflineSaleCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineSaleResponse>;
  ingestPayment(
    tenantId: string,
    credentialId: string,
    command: OfflineCustomerPaymentCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineCustomerPaymentResponse>;
  ingestAttendance(
    tenantId: string,
    credentialId: string,
    command: OfflineAttendanceCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineAttendanceResponse>;
  issueReturnGrant(
    proof: AuthorizedOperationContext,
    tenantId: string,
    membershipId: string,
    deviceId: string,
    registerId: string,
    orderId: string,
    idempotencyKey: string,
  ): Promise<OfflineReturnGrantResponse>;
  ingestReturn(
    tenantId: string,
    credentialId: string,
    command: OfflineReturnCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineReturnResponse>;
  /** Operations the register policy opts into for provisional offline intents (empty ⇒ none). */
  getIntentOperations(tenantId: string, registerId: string): Promise<OfflineIntentOperation[]>;
  /** ADR-042 §13.5: read-only post-sync conflict report (optional so test fakes need not implement it). */
  listSyncConflicts?(
    proof: AuthorizedOperationContext,
    tenantId: string,
    filter: { registerId?: string; kind?: string; status?: string; limit: number },
  ): Promise<ListPosSyncConflictsResponse>;
  ingestIntent(
    tenantId: string,
    credentialId: string,
    command: OfflineIntentCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineIntentResponse>;
}

/**
 * ADR-042 §6.3 (v2): one qualifying admin's override password as stored — a one-way scrypt verifier. There is
 * no plaintext and no recoverable (encrypted) copy anywhere on the server.
 */
export interface OverrideVerifierEntry {
  membershipId: string;
  username: string;
  displayName: string;
  permissions: Array<"promotions.manage" | "payments.refund">;
  verifierVersion: number;
  verifier: OverrideServerVerifier;
}
