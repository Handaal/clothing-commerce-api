import type { AuthorizedOperationContext } from "../authorization";
import type {
  EnrollPosDeviceRequest,
  IngestOfflineSaleResponse,
  OfflineBootstrapResponse,
  OfflineSaleCommand,
  PosDeviceResponse,
} from "../contracts";

export interface OfflineCredential {
  readonly deviceId: string;
  readonly publicKeySpkiBase64: string;
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
  ingest(
    tenantId: string,
    credentialId: string,
    command: OfflineSaleCommand,
    canonicalCommand: string,
    commandFingerprint: string,
    signature: string,
  ): Promise<IngestOfflineSaleResponse>;
}
