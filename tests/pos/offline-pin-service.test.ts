import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationService } from "../../src/authorization";
import {
  DEFAULT_SCRYPT_PARAMS,
  OfflinePosService,
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

// Offline PIN v2 (20261115170000): the KEK-sealed roster is retired. Bootstrap NEVER reads or decrypts sealed
// PINs (even with a KEK configured); it sends only the device's enrollment authorizations.
describe("OfflinePosService — offline PIN authorizations at bootstrap (v2)", () => {
  it("never reads or decrypts a sealed PIN, even with a KEK configured, and sends no staffRoster", async () => {
    const getStaffRoster = vi.fn(async () => [sealedEntry("4821")]);
    const repository = {
      createBootstrap: vi.fn(async () => ({ grantId: "g", catalog: [], policy: {} }) as never),
      getIntentOperations: vi.fn(async () => ["inventory.receive" as const]),
      getStaffRoster,
      getOfflinePinAuthorizations: vi.fn(async () => []),
    } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(authorization(), posRepository, repository, {
      kek: KEK,
      keyVersion: 1,
    });
    const result = await service.createBootstrap(sellerContext(), device, register, "boot-key");
    expect(result.policy.intentOperations).toEqual(["inventory.receive"]);
    expect(getStaffRoster).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("staffRoster");
    expect(result).not.toHaveProperty("offlinePinAuthorizations");
  });

  it("sends this device's enrollment authorizations (ids + versions only, no PIN material)", async () => {
    const authorization0 = {
      membershipId: targetMembership,
      username: "dana",
      displayName: "Dana Cashier",
      enrollmentId: "90000000-0000-4000-8000-000000000001",
      verifierVersion: 2,
    };
    const getOfflinePinAuthorizations = vi.fn(async () => [authorization0]);
    const repository = {
      createBootstrap: vi.fn(async () => ({ grantId: "g", catalog: [], policy: {} }) as never),
      getIntentOperations: vi.fn(async () => []),
      getOfflinePinAuthorizations,
    } as unknown as OfflinePosRepository;
    const off = new OfflinePosService(authorization(), posRepository, repository, null);
    const withoutFlag = await off.createBootstrap(sellerContext(), device, register, "boot-key");
    // POS_OFFLINE_PIN_V2 off (default): no authorization is listed, so offline PIN unlock is unavailable.
    expect(withoutFlag).not.toHaveProperty("offlinePinAuthorizations");
    expect(getOfflinePinAuthorizations).not.toHaveBeenCalled();
    const service = new OfflinePosService(
      authorization(),
      posRepository,
      repository,
      null,
      null,
      false,
      true,
    );
    const result = await service.createBootstrap(sellerContext(), device, register, "boot-key");
    expect(getOfflinePinAuthorizations).toHaveBeenCalledWith(ids.tenant, register, device);
    expect(result.offlinePinAuthorizations).toEqual([authorization0]);
    expect(JSON.stringify(result.offlinePinAuthorizations)).not.toMatch(/salt|hash|cipher|pin"/i);
  });
});

// ADR-042 §13: one shared stock pool. Bootstrap never issues a per-till stock grant, even if the repository
// could, and a stale till's closePreviousGrant is accepted but ignored (no sign-in depends on it).
describe("OfflinePosService — no per-till stock grant at bootstrap (ADR-042 §13)", () => {
  it("never calls stock-grant issuance and returns no stockGrant", async () => {
    const issueStockGrant = vi.fn(async () => ({ stockGrantId: "x" }));
    const repository = {
      createBootstrap: vi.fn(async () => ({ grantId: "g", catalog: [], policy: {} }) as never),
      getIntentOperations: vi.fn(async () => []),
      getStaffRoster: vi.fn(async () => []),
      issueStockGrant,
    } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(authorization(), posRepository, repository, null);
    const close = { offlineGrantId: "50000000-0000-4000-8000-000000000000", finalSaleOrdinal: 4 };
    const result = await service.createBootstrap(
      sellerContext(),
      device,
      register,
      "boot-key",
      close,
    );
    expect(issueStockGrant).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("stockGrant");
  });
});

describe("OfflinePosService — manager-set (sealed) PINs are retired", () => {
  it("refuses with OFFLINE_PIN_REENROLLMENT_REQUIRED and never seals or stores anything", async () => {
    const setOfflinePin = vi.fn();
    const repository = { setOfflinePin } as unknown as OfflinePosRepository;
    for (const config of [{ kek: KEK, keyVersion: 1 }, null]) {
      const service = new OfflinePosService(authorization(), posRepository, repository, config);
      await expect(
        service.setOfflinePin(sellerContext(), targetMembership, "set-key", { pin: "4821" }),
      ).rejects.toMatchObject({ code: "OFFLINE_PIN_REENROLLMENT_REQUIRED" });
    }
    expect(setOfflinePin).not.toHaveBeenCalled();
  });
});

describe("OfflinePosService — offline PIN self-enrollment (v2)", () => {
  const enrolled = {
    enrollmentId: "90000000-0000-4000-8000-000000000002",
    verifierVersion: 1,
    enrolledAt: "2026-11-15T10:00:00.000Z",
  };

  const STEP_UP = { username: "dana", pin: "online-pin-1" };

  it("flag off (default): refuses enrollment before any authorization, re-auth or repository call", async () => {
    const enrollOfflinePin = vi.fn(async () => enrolled);
    const reauth = vi.fn(async () => ({ membershipId: "x" }));
    const repository = { enrollOfflinePin } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(authorization(), posRepository, repository, null, reauth);
    await expect(
      service.enrollOfflinePin(
        sellerContext(),
        { deviceId: device, registerId: register, stepUp: STEP_UP },
        "enroll-key",
      ),
    ).rejects.toMatchObject({ code: "OFFLINE_PIN_DISABLED" });
    expect(reauth).not.toHaveBeenCalled();
    expect(enrollOfflinePin).not.toHaveBeenCalled();
  });

  it("enrols the CALLER after register authorization AND a fresh server-verified step-up; no offline PIN in the request", async () => {
    const enrollOfflinePin = vi.fn(async () => enrolled);
    const repository = { enrollOfflinePin } as unknown as OfflinePosRepository;
    const context = sellerContext();
    const reauth = vi.fn(async () => ({ membershipId: context.membership.id }));
    const service = new OfflinePosService(
      authorization(),
      posRepository,
      repository,
      null,
      reauth,
      false,
      true,
    );
    const result = await service.enrollOfflinePin(
      context,
      { deviceId: device, registerId: register, stepUp: STEP_UP },
      "enroll-key",
    );
    expect(reauth).toHaveBeenCalledWith("dana", "online-pin-1");
    expect(enrollOfflinePin).toHaveBeenCalledWith(
      expect.anything(),
      ids.tenant,
      context.membership.id,
      device,
      register,
      "enroll-key",
    );
    // The repository never receives the step-up credential (nothing about it is stored).
    expect(JSON.stringify(enrollOfflinePin.mock.calls)).not.toContain("online-pin-1");
    expect(result).toEqual({ membershipId: context.membership.id, deviceId: device, ...enrolled });
  });

  it("a wrong step-up credential, or one that resolves to ANOTHER account, enrols nothing", async () => {
    const enrollOfflinePin = vi.fn(async () => enrolled);
    const repository = { enrollOfflinePin } as unknown as OfflinePosRepository;
    for (const reauth of [
      vi.fn(async () => null),
      vi.fn(async () => ({ membershipId: targetMembership })),
    ]) {
      const service = new OfflinePosService(
        authorization(),
        posRepository,
        repository,
        null,
        reauth,
        false,
        true,
      );
      await expect(
        service.enrollOfflinePin(
          sellerContext(),
          { deviceId: device, registerId: register, stepUp: STEP_UP },
          "enroll-key",
        ),
      ).rejects.toMatchObject({ code: "OFFLINE_PIN_STEP_UP_FAILED" });
    }
    expect(enrollOfflinePin).not.toHaveBeenCalled();
  });

  it("denies enrollment without the register's seller permissions and never re-authenticates or touches the repository", async () => {
    const enrollOfflinePin = vi.fn();
    const reauth = vi.fn(async () => ({ membershipId: "x" }));
    const repository = { enrollOfflinePin } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(
      authorization(),
      posRepository,
      repository,
      null,
      reauth,
      false,
      true,
    );
    await expect(
      service.enrollOfflinePin(
        contextWith([grant(["staff.read"])]),
        { deviceId: device, registerId: register, stepUp: STEP_UP },
        "enroll-key",
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(reauth).not.toHaveBeenCalled();
    expect(enrollOfflinePin).not.toHaveBeenCalled();
  });

  it("revoking someone else's enrollments needs staff.manage; revoking your own does not", async () => {
    const revokeOfflinePinEnrollments = vi.fn(async () => 1);
    const repository = { revokeOfflinePinEnrollments } as unknown as OfflinePosRepository;
    const service = new OfflinePosService(authorization(), posRepository, repository, null);
    const seller = contextWith([grant(SELL_PERMISSIONS)]);
    await expect(
      service.revokeOfflinePinEnrollments(seller, {
        membershipId: targetMembership,
        reason: "admin_revoked",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      service.revokeOfflinePinEnrollments(seller, {
        membershipId: seller.membership.id,
        reason: "pin_forgotten",
      }),
    ).resolves.toEqual({ revoked: 1 });
    await expect(
      service.revokeOfflinePinEnrollments(sellerContext(), {
        deviceId: device,
        reason: "device_lost",
      }),
    ).resolves.toEqual({ revoked: 1 });
    expect(revokeOfflinePinEnrollments).toHaveBeenCalledTimes(2);
  });
});
