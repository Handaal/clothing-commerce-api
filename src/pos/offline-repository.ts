import type { AuthorizedOperationContext } from "../authorization";
import type {
  EnrollPosDeviceRequest,
  IngestOfflineAttendanceResponse,
  IngestOfflineCustomerPaymentResponse,
  IngestOfflineSaleResponse,
  OfflineAttendanceCommand,
  OfflineBootstrapResponse,
  OfflineCustomerPaymentCommand,
  OfflineSaleCommand,
  PosDeviceResponse,
  SetStaffOfflinePinResponse,
} from "../contracts";
import type { EncryptedOfflinePin, ScryptVerifierParams } from "./offline-pin-crypto";

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
}
