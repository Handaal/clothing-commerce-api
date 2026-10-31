import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { AuthorizationService } from "../../src/authorization";
import { PosTokenVerifier } from "../../src/authentication/pos-token";
import type { PosAuthSigningConfiguration } from "../../src/config/auth-environment";
import { DEFAULT_SCRYPT_PARAMS, deriveOnlinePinVerifier } from "../../src/pos/offline-pin-crypto";
import { PosAuthError } from "../../src/pos/pos-auth-errors";
import type { PosAuthRepository, ResolvedPosLogin } from "../../src/pos/pos-auth-repository";
import { PosAuthService } from "../../src/pos/pos-auth-service";

const SIGNING: PosAuthSigningConfiguration = {
  signingKey: randomBytes(32),
  accessTtlSeconds: 3600,
};

const ACCOUNT = {
  subject: "cred-abc",
  tenantId: "11111111-1111-1111-1111-111111111111",
  membershipId: "22222222-2222-2222-2222-222222222222",
  displayName: "Mariam",
  username: "mariam",
  posRole: "cashier" as const,
  posPermissions: ["orders", "inventory"],
  verifier: deriveOnlinePinVerifier("1234", DEFAULT_SCRYPT_PARAMS),
};

function makeRepo(resolved: ResolvedPosLogin) {
  return {
    begin: vi.fn(async () => resolved),
    record: vi.fn(async () => undefined),
  } as unknown as PosAuthRepository & {
    begin: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
  };
}

const AUTHZ = {} as AuthorizationService;

describe("PosAuthService.login", () => {
  it("rejects when the provider is dormant (no signing key)", async () => {
    const repo = makeRepo({ lockedUntil: null, account: ACCOUNT });
    const service = new PosAuthService(AUTHZ, repo, null);
    await expect(service.login({ username: "mariam", pin: "1234" })).rejects.toMatchObject({
      code: "POS_AUTH_NOT_CONFIGURED",
    });
    expect(repo.begin).not.toHaveBeenCalled();
  });

  it("mints a verifiable token + operator on the correct PIN and clears the throttle", async () => {
    const repo = makeRepo({ lockedUntil: null, account: ACCOUNT });
    const service = new PosAuthService(AUTHZ, repo, SIGNING);

    const result = await service.login({ username: "mariam", pin: "1234" });

    expect(result.operator).toEqual({
      membershipId: ACCOUNT.membershipId,
      tenantId: ACCOUNT.tenantId,
      username: "mariam",
      displayName: "Mariam",
      role: "cashier",
      permissions: ["orders", "inventory"],
    });
    expect(repo.record).toHaveBeenCalledWith("mariam", true);

    // The token must verify under the same signing key and carry the account subject.
    const verified = await new PosTokenVerifier(new Uint8Array(SIGNING.signingKey)).verifyRequest(
      new Request("https://api.test/pos/context", {
        headers: { Authorization: `Bearer ${result.accessToken}` },
      }),
    );
    expect(verified).toEqual({ provider: "pos_pin", subject: "cred-abc" });
  });

  it("collapses a wrong PIN to INVALID_CREDENTIALS and records a failure", async () => {
    const repo = makeRepo({ lockedUntil: null, account: ACCOUNT });
    const service = new PosAuthService(AUTHZ, repo, SIGNING);
    await expect(service.login({ username: "mariam", pin: "9999" })).rejects.toBeInstanceOf(
      PosAuthError,
    );
    expect(repo.record).toHaveBeenCalledWith("mariam", false);
  });

  it("collapses an unknown username to the SAME failure and records it", async () => {
    const repo = makeRepo({ lockedUntil: null, account: null });
    const service = new PosAuthService(AUTHZ, repo, SIGNING);
    await expect(service.login({ username: "ghost", pin: "1234" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(repo.record).toHaveBeenCalledWith("ghost", false);
  });

  it("short-circuits a locked account WITHOUT recording another attempt", async () => {
    const repo = makeRepo({ lockedUntil: new Date(Date.now() + 30_000), account: ACCOUNT });
    const service = new PosAuthService(AUTHZ, repo, SIGNING);
    await expect(service.login({ username: "mariam", pin: "1234" })).rejects.toMatchObject({
      code: "ACCOUNT_LOCKED",
    });
    expect(repo.record).not.toHaveBeenCalled();
  });
});
