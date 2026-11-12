import { createHash, createPublicKey, verify } from "node:crypto";

import type { AuthorizationContext, AuthorizationService } from "../authorization";
import type { OfflinePinConfiguration } from "../config/auth-environment";
import {
  canonicalizeOfflineAttendanceCommand,
  canonicalizeOfflineCustomerPaymentCommand,
  canonicalizeOfflineSaleCommand,
} from "../contracts/offline-signing";
import type {
  EnrollPosDeviceRequest,
  IngestOfflineAttendanceRequest,
  IngestOfflineAttendanceResponse,
  IngestOfflineCustomerPaymentRequest,
  IngestOfflineCustomerPaymentResponse,
  IngestOfflineSaleRequest,
  IngestOfflineSaleResponse,
  OfflineBootstrapResponse,
  OfflineStaffRosterEntry,
  PosDeviceResponse,
  SetStaffOfflinePinRequest,
  SetStaffOfflinePinResponse,
} from "../contracts";
import { PosPermission } from "./model";
import { OfflinePosError } from "./offline-errors";
import {
  DEFAULT_SCRYPT_PARAMS,
  decryptOfflinePin,
  deriveStaffPinVerifier,
  encryptOfflinePin,
} from "./offline-pin-crypto";
import type { OfflinePosRepository } from "./offline-repository";
import type { PosSaleRepository } from "./repository";

const STAFF_MANAGE_PERMISSION = "staff.manage";

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
    // Null when the server has no offline-PIN key: set/rotate then rejects and the bootstrap omits the
    // staff roster, leaving every other offline capability intact.
    private readonly offlinePin: OfflinePinConfiguration | null = null,
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
    const bootstrap = await this.repository.createBootstrap(
      proof,
      context.tenant.id,
      context.membership.id,
      deviceId,
      registerId,
      idempotencyKey,
    );
    const staffRoster = await this.buildStaffRoster(context.tenant.id, registerId, deviceId);
    return staffRoster.length > 0 ? { ...bootstrap, staffRoster } : bootstrap;
  }

  /**
   * Build the offline staff roster for the bootstrapping device: for each authorized seller with a sealed
   * offline PIN, unseal the PIN transiently and compute the DEVICE-BOUND scrypt verifier the POS checks
   * against. Returns [] when the server is not configured for offline PINs. The plaintext PIN exists only
   * inside this function's stack frame and is never persisted or returned.
   */
  private async buildStaffRoster(
    tenantId: string,
    registerId: string,
    deviceId: string,
  ): Promise<OfflineStaffRosterEntry[]> {
    if (this.offlinePin === null) return [];
    const sealed = await this.repository.getStaffRoster(tenantId, registerId);
    return sealed.map((entry) => {
      const pin = decryptOfflinePin(entry.material, this.offlinePin!.kek);
      return {
        membershipId: entry.membershipId,
        username: entry.username,
        displayName: entry.displayName,
        pinVerifier: deriveStaffPinVerifier(pin, deviceId, entry.params),
      };
    });
  }

  /**
   * Set or rotate a staff member's offline-unlock PIN. Authorized by a tenant-wide staff.manage grant (the
   * same grant every staff mutation requires); the RPC additionally enforces the anti-escalation subset
   * check. The PIN is sealed with the server KEK before it ever reaches the database.
   */
  async setOfflinePin(
    context: AuthorizationContext,
    membershipId: string,
    idempotencyKey: string,
    input: SetStaffOfflinePinRequest,
  ): Promise<SetStaffOfflinePinResponse> {
    if (this.offlinePin === null) throw new OfflinePosError("OFFLINE_PIN_NOT_CONFIGURED");
    const proof = await this.authorization.authorize(context, {
      permissionKey: STAFF_MANAGE_PERMISSION,
    });
    const material = encryptOfflinePin(input.pin, this.offlinePin.kek, this.offlinePin.keyVersion);
    return this.repository.setOfflinePin(
      proof,
      context.tenant.id,
      context.membership.id,
      membershipId,
      idempotencyKey,
      material,
      DEFAULT_SCRYPT_PARAMS,
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
}
