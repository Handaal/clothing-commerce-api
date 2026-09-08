import { createHash, createPublicKey, verify } from "node:crypto";

import type { AuthorizationContext, AuthorizationService } from "../authorization";
import { canonicalizeOfflineSaleCommand } from "../contracts/offline-signing";
import type {
  EnrollPosDeviceRequest,
  IngestOfflineSaleRequest,
  IngestOfflineSaleResponse,
  OfflineBootstrapResponse,
  PosDeviceResponse,
} from "../contracts";
import { PosPermission } from "./model";
import { OfflinePosError } from "./offline-errors";
import type { OfflinePosRepository } from "./offline-repository";
import type { PosSaleRepository } from "./repository";

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

export class OfflinePosService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly posRepository: PosSaleRepository,
    private readonly repository: OfflinePosRepository,
  ) {}

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

  async createBootstrap(
    context: AuthorizationContext,
    deviceId: string,
    registerId: string,
    idempotencyKey: string,
  ): Promise<OfflineBootstrapResponse> {
    const proof = await this.authorizeRegister(context, registerId);
    return this.repository.createBootstrap(
      proof,
      context.tenant.id,
      context.membership.id,
      deviceId,
      registerId,
      idempotencyKey,
    );
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
}
