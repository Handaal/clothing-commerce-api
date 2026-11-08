import { scryptSync } from "node:crypto";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationService } from "../../src/authorization";
import {
  DEFAULT_SCRYPT_PARAMS,
  OfflinePosService,
  decryptOfflinePin,
  encryptOfflinePin,
  type OfflinePosRepository,
  type SealedRosterEntry,
} from "../../src/pos";
import { PosPermission } from "../../src/pos/model";
import type { PosSaleRepository } from "../../src/pos/repository";
import { contextWith, grant, ids, StubResourceRepository } from "../inventory/fakes";

const branch = "40000000-0000-4000-8000-000000000001";
const register = "30000000-0000-4000-8000-000000000001";
const device = "20000000-0000-4000-8000-000000000001";
const targetMembership = "80000000-0000-4000-8000-0000000000bb";
const KEK = randomBytes(32);

const SELL_PERMISSIONS = [
  PosPermission.createOrder,
  PosPermission.fulfillOrder,
  PosPermission.readOrder,
  PosPermission.capturePayment,
  PosPermission.issueInventory,
];

// A tenant-wide grant with the full POS selling set + staff.manage covers both the register authorization
// and the set-PIN authorization. The branch + location resolve to this tenant.
function sellerContext() {
  return contextWith([grant([...SELL_PERMISSIONS, "staff.manage"])]);
}

function resourceMap() {
  return new Map<string, string[]>([
    [`branch:${branch}`, [ids.tenant]],
    [`inventory_location:${ids.locationActive}`, [ids.tenant]],
  ]);
}

function authorization() {
  return new AuthorizationService(new StubResourceRepository(resourceMap()));
}

const registerContext = {
  branchId: branch,
  inventoryLocationId: ids.locationActive,
} as unknown as Awaited<ReturnType<PosSaleRepository["getRegisterContext"]>>;

const posRepository = {
  getRegisterContext: vi.fn(async () => registerContext),
} as unknown as PosSaleRepository;

function sealedEntry(pin: string): SealedRosterEntry {
  return {
    membershipId: targetMembership,
    username: "dana",
    displayName: "Dana Cashier",
    material: encryptOfflinePin(pin, KEK),
    params: DEFAULT_SCRYPT_PARAMS,
  };
}

/** POS-side re-derivation of the device-bound verifier, from the spec. */
function posVerifies(
  verifier: {
    saltBase64: string;
    hashBase64: string;
    n: number;
    r: number;
    p: number;
    keyLength: number;
  },
  pin: string,
  deviceId: string,
): boolean {
  const material = Buffer.concat([
    Buffer.from(verifier.saltBase64, "base64"),
    Buffer.from(deviceId, "utf8"),
  ]);
  return (
    scryptSync(pin, material, verifier.keyLength, {
      N: verifier.n,
      r: verifier.r,
      p: verifier.p,
      maxmem: 256 * 1024 * 1024,
    }).toString("base64") === verifier.hashBase64
  );
}

describe("OfflinePosService — offline PIN roster at bootstrap", () => {
  it("emits a staff roster whose verifier the POS KDF validates, device-bound to the bootstrapping device", async () => {
    const repository = {
      createBootstrap: vi.fn(async () => ({ grantId: "g", catalog: [] }) as never),
      getStaffRoster: vi.fn(async () => [sealedEntry("4821")]),
    } as unknown as OfflinePosRepository;

    const service = new OfflinePosService(authorization(), posRepository, repository, {
      kek: KEK,
      keyVersion: 1,
    });
    const result = await service.createBootstrap(sellerContext(), device, register, "boot-key");

    expect(result.staffRoster).toHaveLength(1);
    const entry = result.staffRoster![0]!;
    expect(entry).toMatchObject({
      membershipId: targetMembership,
      username: "dana",
      displayName: "Dana Cashier",
    });
    expect(posVerifies(entry.pinVerifier, "4821", device)).toBe(true);
    // Device-binding: the identical PIN would not verify for a different device id.
    expect(posVerifies(entry.pinVerifier, "4821", "another-device")).toBe(false);
  });

  it("omits the roster entirely when no authorized seller has a PIN set", async () => {
    const repository = {
      createBootstrap: vi.fn(async () => ({ grantId: "g", catalog: [] }) as never),
      getStaffRoster: vi.fn(async () => []),
    } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(authorization(), posRepository, repository, {
      kek: KEK,
      keyVersion: 1,
    });
    const result = await service.createBootstrap(sellerContext(), device, register, "boot-key");
    expect(result.staffRoster).toBeUndefined();
  });

  it("omits the roster (and never queries it) when the server has no offline-PIN key", async () => {
    const getStaffRoster = vi.fn(async () => [sealedEntry("4821")]);
    const repository = {
      createBootstrap: vi.fn(async () => ({ grantId: "g", catalog: [] }) as never),
      getStaffRoster,
    } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(authorization(), posRepository, repository, null);
    const result = await service.createBootstrap(sellerContext(), device, register, "boot-key");
    expect(result.staffRoster).toBeUndefined();
    expect(getStaffRoster).not.toHaveBeenCalled();
  });
});

describe("OfflinePosService — setOfflinePin", () => {
  it("seals the PIN before it reaches the repository and authorizes staff.manage", async () => {
    const setOfflinePin = vi.fn<OfflinePosRepository["setOfflinePin"]>(async () => ({
      membershipId: targetMembership,
      keyVersion: 1,
      updatedAt: "2026-10-24T00:00:00Z",
    }));
    const repository = { setOfflinePin } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(authorization(), posRepository, repository, {
      kek: KEK,
      keyVersion: 1,
    });

    await service.setOfflinePin(sellerContext(), targetMembership, "set-key", { pin: "4821" });

    expect(setOfflinePin).toHaveBeenCalledTimes(1);
    const material = setOfflinePin.mock.calls[0]![5];
    // The repository receives sealed material, not the plaintext, and it decrypts back to the PIN.
    expect(JSON.stringify(material)).not.toContain("4821");
    expect(decryptOfflinePin(material, KEK)).toBe("4821");
  });

  it("denies without a tenant-wide staff.manage grant and never touches the repository", async () => {
    const setOfflinePin = vi.fn();
    const repository = { setOfflinePin } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(authorization(), posRepository, repository, {
      kek: KEK,
      keyVersion: 1,
    });
    await expect(
      service.setOfflinePin(contextWith([grant(["staff.read"])]), targetMembership, "set-key", {
        pin: "4821",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(setOfflinePin).not.toHaveBeenCalled();
  });

  it("rejects with OFFLINE_PIN_NOT_CONFIGURED when the server has no key", async () => {
    const setOfflinePin = vi.fn();
    const repository = { setOfflinePin } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(authorization(), posRepository, repository, null);
    await expect(
      service.setOfflinePin(sellerContext(), targetMembership, "set-key", { pin: "4821" }),
    ).rejects.toMatchObject({ code: "OFFLINE_PIN_NOT_CONFIGURED" });
    expect(setOfflinePin).not.toHaveBeenCalled();
  });
});
