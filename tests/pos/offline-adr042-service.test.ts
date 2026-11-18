import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationService } from "../../src/authorization";
import { OfflinePosService, type OfflinePosRepository } from "../../src/pos";
import { isAcceptableOverridePassword } from "../../src/pos/offline-service";
import {
  OVERRIDE_VERIFIER_PARAMS,
  deriveOverrideDeviceVerifier,
  deriveOverrideServerVerifier,
  verifyOverrideOnDevice,
  type OverrideServerVerifier,
} from "../../src/pos/override-password-crypto";
import { OfflinePosError } from "../../src/pos/offline-errors";
import { PosPermission } from "../../src/pos/model";
import type { PosSaleRepository } from "../../src/pos/repository";
import { PromotionsService } from "../../src/promotions/service";
import type { PromotionsRepository } from "../../src/promotions/repository";
import { contextWith, grant, ids, StubResourceRepository } from "../inventory/fakes";

const branch = "40000000-0000-4000-8000-000000000001";
const register = "30000000-0000-4000-8000-000000000001";
const device = "20000000-0000-4000-8000-000000000001";
const admin = "80000000-0000-4000-8000-0000000000aa";
const KEK = randomBytes(32);
const SELL = [
  PosPermission.createOrder,
  PosPermission.fulfillOrder,
  PosPermission.readOrder,
  PosPermission.capturePayment,
  PosPermission.issueInventory,
];

function authorization() {
  return new AuthorizationService(
    new StubResourceRepository(
      new Map<string, string[]>([
        [`branch:${branch}`, [ids.tenant]],
        [`inventory_location:${ids.locationActive}`, [ids.tenant]],
      ]),
    ),
  );
}
const posRepository = {
  getRegisterContext: vi.fn(async () => ({
    branchId: branch,
    inventoryLocationId: ids.locationActive,
  })),
} as unknown as PosSaleRepository;

describe("isAcceptableOverridePassword (ADR-042 §6.3 policy)", () => {
  it("accepts a long password unrelated to the username and PIN", () => {
    expect(isAcceptableOverridePassword("Blue-Harbour-71", "dana", "4821")).toBe(true);
  });
  it.each([
    ["short", "Short-9x", "dana", "4821"],
    ["contains username", "my-DANA-password", "dana", "4821"],
    ["contains PIN", "harbour-4821-x", "dana", "4821"],
    ["common", "password123", "dana", "4821"],
    ["too few distinct characters", "aaaaabbbbb", "dana", "4821"],
  ])("rejects a password that is %s", (_label, password, username, pin) => {
    expect(isAcceptableOverridePassword(password, username, pin)).toBe(false);
  });
});

describe("OfflinePosService — override password (ADR-042 D-6)", () => {
  function service(
    repository: Partial<OfflinePosRepository>,
    reauth = vi.fn(async (): Promise<{ membershipId: string } | null> => ({
      membershipId: ids.membership,
    })),
  ) {
    return {
      reauth,
      service: new OfflinePosService(
        authorization(),
        posRepository,
        repository as OfflinePosRepository,
        { kek: KEK, keyVersion: 1 },
        reauth,
      ),
    };
  }

  it("re-authenticates, enforces the policy and stores ONLY a one-way scrypt verifier (no recoverable copy)", async () => {
    const setOverridePassword = vi.fn(async () => ({
      membershipId: ids.membership,
      verifierVersion: 1,
      updatedAt: "2026-11-14T00:00:00.000Z",
    }));
    const { service: svc, reauth } = service({ setOverridePassword });
    const result = await svc.setOverridePassword(
      contextWith([grant(["promotions.manage"])]),
      "k1",
      {
        username: "dana",
        pin: "4821",
        password: "Blue-Harbour-71",
      },
    );
    expect(reauth).toHaveBeenCalledWith("dana", "4821");
    expect(result.verifierVersion).toBe(1);
    const [, , , verifier, saltLength] = setOverridePassword.mock.calls[0] as unknown as [
      string,
      string,
      string,
      OverrideServerVerifier,
      number,
    ];
    const stored = JSON.stringify(setOverridePassword.mock.calls[0]);
    expect(stored).not.toContain("Blue-Harbour-71");
    // Nothing decryptable is handed to the database: no envelope fields at all.
    expect(stored).not.toMatch(/ciphertext|authTag|ivBase64|keyVersion/i);
    expect(verifier.algorithm).toBe("scrypt-hmac-sha256-v2");
    expect(saltLength).toBe(16);
    expect(verifier.n).toBeGreaterThanOrEqual(32768);
    // It is exactly scrypt(password, salt): a one-way function of the password, not an encryption of it.
    const recomputed = scryptSync(
      "Blue-Harbour-71",
      Buffer.from(verifier.saltBase64, "base64"),
      32,
      {
        N: verifier.n,
        r: verifier.r,
        p: verifier.p,
        maxmem: 256 * 1024 * 1024,
      },
    );
    expect(recomputed.toString("base64")).toBe(verifier.hashBase64);
  });

  it("needs no server key (KEK) to set an override password", async () => {
    const setOverridePassword = vi.fn(async () => ({
      membershipId: ids.membership,
      verifierVersion: 1,
      updatedAt: "2026-11-14T00:00:00.000Z",
    }));
    const reauth = vi.fn(async () => ({ membershipId: ids.membership }));
    const svc = new OfflinePosService(
      authorization(),
      posRepository,
      { setOverridePassword } as unknown as OfflinePosRepository,
      null,
      reauth,
    );
    await svc.setOverridePassword(contextWith([grant(["promotions.manage"])]), "k1", {
      username: "dana",
      pin: "4821",
      password: "Blue-Harbour-71",
    });
    expect(setOverridePassword).toHaveBeenCalledTimes(1);
  });

  it("refuses when the PIN belongs to someone else or is wrong", async () => {
    const setOverridePassword = vi.fn();
    const { service: svc } = service(
      { setOverridePassword },
      vi.fn(async () => null),
    );
    await expect(
      svc.setOverridePassword(contextWith([grant(["promotions.manage"])]), "k1", {
        username: "dana",
        pin: "0000",
        password: "Blue-Harbour-71",
      }),
    ).rejects.toBeInstanceOf(OfflinePosError);
    expect(setOverridePassword).not.toHaveBeenCalled();
  });

  it("refuses a weak password with OVERRIDE_PASSWORD_REJECTED", async () => {
    const { service: svc } = service({ setOverridePassword: vi.fn() });
    await expect(
      svc.setOverridePassword(contextWith([grant(["promotions.manage"])]), "k1", {
        username: "dana",
        pin: "4821",
        password: "dana-4821-pass",
      }),
    ).rejects.toMatchObject({ code: "OVERRIDE_PASSWORD_REJECTED" });
  });
});

describe("OfflinePosService — bootstrap vouchers and admin roster (ADR-042 §5/§6.3)", () => {
  // ADR-042 §13: reserved-quota voucher grants are superseded and credential-gated offline redemption stays
  // disabled (the v2 assertion cannot prove password knowledge), so bootstrap carries neither.
  it("issues no voucher grants and no admin override roster (ADR-042 §13)", async () => {
    const recordOverrideIssuances = vi.fn(async () => undefined);
    const issueVoucherGrants = vi.fn(async () => [{ voucherGrantId: "v1" }]);
    const getOverrideRoster = vi.fn(async () => []);
    const repository = {
      createBootstrap: vi.fn(async () => ({
        grantId: "g",
        acceptedUntil: "2026-11-15T00:00:00.000Z",
        catalog: [],
        policy: {},
      })),
      getIntentOperations: vi.fn(async () => []),
      getStaffRoster: vi.fn(async () => []),
      issueVoucherGrants,
      getOverrideRoster,
      recordOverrideIssuances,
    } as unknown as OfflinePosRepository;
    const svc = new OfflinePosService(authorization(), posRepository, repository, {
      kek: KEK,
      keyVersion: 1,
    });
    const result = await svc.createBootstrap(contextWith([grant(SELL)]), device, register, "boot");
    expect(result).not.toHaveProperty("voucherGrants");
    expect(result).not.toHaveProperty("overrideRoster");
    expect(issueVoucherGrants).not.toHaveBeenCalled();
    expect(getOverrideRoster).not.toHaveBeenCalled();
    expect(recordOverrideIssuances).not.toHaveBeenCalled();
  });

  // ADR-042 §13.6: cached voucher policies are issued ONLY when POS_OFFLINE_CACHED_VOUCHERS=enabled.
  function cachedVoucherRepository() {
    const issueVoucherPolicies = vi.fn(async () => [{ policyIssuanceId: "p1" }]);
    const repository = {
      createBootstrap: vi.fn(async () => ({
        grantId: "g",
        acceptedUntil: "2026-11-15T00:00:00.000Z",
        catalog: [],
        policy: {},
      })),
      getIntentOperations: vi.fn(async () => []),
      getStaffRoster: vi.fn(async () => []),
      issueVoucherPolicies,
    } as unknown as OfflinePosRepository;
    return { repository, issueVoucherPolicies };
  }

  it("default (flag off): issues no cached voucher policy — every voucher stays online-only", async () => {
    const { repository, issueVoucherPolicies } = cachedVoucherRepository();
    const svc = new OfflinePosService(authorization(), posRepository, repository, null);
    const result = await svc.createBootstrap(contextWith([grant(SELL)]), device, register, "boot");
    expect(result).not.toHaveProperty("voucherPolicies");
    expect(issueVoucherPolicies).not.toHaveBeenCalled();
  });

  it("flag on: attaches the lease's cached voucher policies (issued once per lease by the repository)", async () => {
    const { repository, issueVoucherPolicies } = cachedVoucherRepository();
    const svc = new OfflinePosService(authorization(), posRepository, repository, null, null, true);
    const result = await svc.createBootstrap(contextWith([grant(SELL)]), device, register, "boot");
    expect(result).toHaveProperty("voucherPolicies", [{ policyIssuanceId: "p1" }]);
    expect(issueVoucherPolicies).toHaveBeenCalledWith(ids.tenant, "g");
  });

  // The device-bound verifier tag itself (still used by the online override-password flow) keeps its binding.
  it("device verifier tags stay bound to device, admin and version", () => {
    const storedVerifier = deriveOverrideServerVerifier(
      "Blue-Harbour-71",
      OVERRIDE_VERIFIER_PARAMS,
    );
    const tag = deriveOverrideDeviceVerifier(storedVerifier, device, admin, 3);
    expect(verifyOverrideOnDevice("Blue-Harbour-71", tag, device, admin, 3)).toBe(true);
    expect(verifyOverrideOnDevice("Blue-Harbour-72", tag, device, admin, 3)).toBe(false);
    expect(
      verifyOverrideOnDevice(
        "Blue-Harbour-71",
        tag,
        "70000000-0000-4000-8000-0000000000ff",
        admin,
        3,
      ),
    ).toBe(false);
    expect(verifyOverrideOnDevice("Blue-Harbour-71", tag, device, admin, 4)).toBe(false);
  });
});

describe("PromotionsService — channel policies (ADR-042 §5)", () => {
  it("refuses offline terms on the online channel", async () => {
    const repository = { upsertChannelPolicy: vi.fn() } as unknown as PromotionsRepository;
    const svc = new PromotionsService(authorization(), repository);
    await expect(
      svc.upsertChannelPolicy(
        contextWith([grant(["promotions.manage"])]),
        "10000000-0000-4000-8000-000000000001",
        "online",
        {
          usageLimit: 5,
          offlineEnabled: true,
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_PROMOTION" });
  });

  it("passes a POS policy with the owner caps through", async () => {
    const upsertChannelPolicy = vi.fn(async () => ({
      promotionId: "p",
      policies: [],
      codeLimits: [],
    }));
    const svc = new PromotionsService(authorization(), {
      upsertChannelPolicy,
    } as unknown as PromotionsRepository);
    await svc.upsertChannelPolicy(
      contextWith([grant(["promotions.manage"])]),
      "10000000-0000-4000-8000-000000000001",
      "pos",
      {
        usageLimit: 20,
        offlineEnabled: true,
        offlineQuotaPerGrant: 5,
        maxDiscountPerRedemptionMinor: 1000,
        maxDiscountPerGrantMinor: 3000,
      },
    );
    expect(upsertChannelPolicy).toHaveBeenCalledWith(
      expect.anything(),
      "10000000-0000-4000-8000-000000000001",
      "pos",
      {
        usageLimit: 20,
        offlineEnabled: true,
        offlineQuotaPerGrant: 5,
        requiresAdminCredentials: false,
        maxDiscountPerRedemptionMinor: 1000,
        maxDiscountPerGrantMinor: 3000,
      },
    );
  });
});

describe("OfflinePosService — online-only returns and the conflict report (ADR-042 §13)", () => {
  const anyReturn = {
    command: { deviceId: device },
    signature: { credentialId: device, value: "x" },
  };

  it("refuses an offline return command before any repository call (no side effect)", async () => {
    const getCredential = vi.fn();
    const ingestReturn = vi.fn();
    const repository = { getCredential, ingestReturn } as unknown as OfflinePosRepository;
    const svc = new OfflinePosService(authorization(), posRepository, repository, null);
    await expect(svc.ingestReturn(ids.tenant, anyReturn as never)).rejects.toMatchObject({
      code: "OFFLINE_RETURNS_DISABLED",
      httpStatus: 409,
    });
    expect(getCredential).not.toHaveBeenCalled();
    expect(ingestReturn).not.toHaveBeenCalled();
  });

  it("refuses to issue an offline return grant", async () => {
    const issueReturnGrant = vi.fn();
    const repository = { issueReturnGrant } as unknown as OfflinePosRepository;
    const svc = new OfflinePosService(authorization(), posRepository, repository, null);
    await expect(
      svc.issueReturnGrant(contextWith([grant(SELL)]), device, register, ids.tenant, "k"),
    ).rejects.toBeInstanceOf(OfflinePosError);
    expect(issueReturnGrant).not.toHaveBeenCalled();
  });

  it("lists one register's conflicts with register permissions, tenant-wide only with orders.read", async () => {
    const listSyncConflicts = vi.fn(async () => ({
      generatedAt: "2026-11-15T00:00:00.000Z",
      summary: { open: 1, informational: 0 },
      items: [],
    }));
    const repository = { listSyncConflicts } as unknown as OfflinePosRepository;
    const svc = new OfflinePosService(authorization(), posRepository, repository, null);
    const result = await svc.listSyncConflicts(contextWith([grant(SELL)]), {
      registerId: register,
      limit: 50,
    });
    expect(result.summary.open).toBe(1);
    expect(listSyncConflicts).toHaveBeenCalledWith(expect.anything(), ids.tenant, {
      registerId: register,
      limit: 50,
    });
    await expect(
      svc.listSyncConflicts(contextWith([grant([PosPermission.createOrder])]), { limit: 50 }),
    ).rejects.toMatchObject({ name: "AuthorizationError" });
    await svc.listSyncConflicts(contextWith([grant([PosPermission.readOrder])]), {
      kind: "stock_shortfall",
      limit: 10,
    });
    expect(listSyncConflicts).toHaveBeenLastCalledWith(expect.anything(), ids.tenant, {
      kind: "stock_shortfall",
      limit: 10,
    });
  });
});
