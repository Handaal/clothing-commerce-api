// ADR-043 POS-native accounts — CROSS-REPO acceptance over the REAL HTTP server (Next.js API + disposable
// PostgreSQL), driven through the POS repo's COMPILED main-process session manager (which dynamically imports the
// POS's vendored SDK tarball). No Clerk token is used anywhere on the POS path: sign-in, step-up and account
// management all run on the POS-native (`iss="pos"`) access token.
//
//   H1  online sign-in returns a short-lived scoped session + operator; the token authorises the POS admin API
//   H2  wrong PIN and unknown username fail identically (generic), classified as definitive (no offline fallback)
//   H3  malformed PINs (<4 digits, non-ASCII digits, letters) → 400, never echoed, definitive
//   H4  an oversized request → 413 PAYLOAD_TOO_LARGE (transport ceiling), definitive, never verified
//   H5  a 40-digit PIN (beyond the retired caps) signs in; the same PIN truncated to 8/12/39 digits does not
//   H6  account create + PIN reset through the authorised API with the POS token; old PIN stops working
//   H7  deactivation: sign-in refused immediately and an already-issued token stops authorising
//   H8  last active POS admin cannot be demoted or suspended (409)
//   H9  admin step-up verifies another account WITHOUT replacing the signed-in session
//   H10 throttling: 5 failures lock the username (also for an unknown username — no enumeration)
//
// Launched exclusively by `pnpm test:pos:auth:client`. Requires `pnpm build:main` in the POS repo.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createCommerceClient } from "../../packages/sdk/src/index";

const baseUrl = process.env.POS_TEST_API_BASE_URL;
if (!baseUrl) throw new Error("ADR-043 acceptance requires the isolated harness environment.");

const TENANT = "2a000001-0000-4000-8000-000000000001";
const FULL = {
  username: "pos.full",
  pin: "4821",
  membershipId: "2a000012-0000-4000-8000-000000000001",
};
const NOPAY = {
  username: "pos.nopay",
  pin: "6390",
  membershipId: "2a000012-0000-4000-8000-000000000002",
};
const LONG = { username: "pos.wrongloc", pin: "1357924680".repeat(4) };
const CASHIER_ROLE = "2a000013-0000-4000-8000-000000000002";
const TENANT_SCOPE = "2a000014-0000-4000-8000-000000000001";

const posRepo = path.resolve(
  process.env.POS_REPO_DIR ?? path.join(__dirname, "..", "..", "..", "clothing-commerce-pos"),
);
const managerJs = path.join(posRepo, "dist-electron", "main", "pos-session", "manager.js");
if (!existsSync(managerJs))
  throw new Error(
    `POS main-process build not found at ${managerJs}. Run \`pnpm build:main\` first.`,
  );

type LoginResult =
  | { ok: true; session: { operator: Record<string, unknown>; expiresAt: string } }
  | { ok: false; reason: string };
type Manager = {
  login(username: string, pin: string): Promise<LoginResult>;
  verifyCredentials(
    username: string,
    pin: string,
  ): Promise<{ ok: true; role: string } | { ok: false; reason: string }>;
  getSession(): { operator: Record<string, unknown>; expiresAt: string } | null;
  getToken(): string | null;
  logout(): void;
};
const load = createRequire(__filename);
const { PosSessionManager, classifyPosAuthFailure } = load(managerJs) as {
  PosSessionManager: new (apiBaseUrl: string, store: unknown) => Manager;
  classifyPosAuthFailure: (error: unknown) => string;
};

/** In-memory session store (OS key store "unavailable" ⇒ never written to disk). */
function memoryStore() {
  let session: {
    accessToken: string;
    expiresAt: string;
    operator: Record<string, unknown>;
  } | null = null;
  return {
    save: (value: typeof session) => (session = value),
    clear: () => (session = null),
    getToken: () => session?.accessToken ?? null,
    getSnapshot: () =>
      session ? { operator: session.operator, expiresAt: session.expiresAt } : null,
  };
}
const newManager = () => new PosSessionManager(baseUrl, memoryStore());

async function rawLogin(body: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/v1/pos/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text ? (JSON.parse(text) as { error?: { code: string; message: string } }) : {},
  };
}

function adminClient(token: string) {
  return createCommerceClient({
    baseUrl: baseUrl!,
    client: { type: "pos-desktop", version: "acceptance" },
    getToken: async () => token,
  }).withTenant(TENANT);
}

async function signedIn(account: { username: string; pin: string }) {
  const manager = newManager();
  const result = await manager.login(account.username, account.pin);
  if (!result.ok) throw new Error(`sign-in failed for ${account.username}: ${result.reason}`);
  return { manager, token: manager.getToken()! };
}

describe("ADR-043 POS-native accounts over real HTTP", () => {
  it("H1 online sign-in returns a scoped short-lived session and the token authorises the POS admin API", async () => {
    const manager = newManager();
    const result = await manager.login(FULL.username, FULL.pin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.operator).toMatchObject({
      membershipId: FULL.membershipId,
      tenantId: TENANT,
      username: "pos.full",
      role: "admin",
    });
    const ttlMs = Date.parse(result.session.expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(12 * 60 * 60 * 1000 + 60_000);
    expect(JSON.stringify(result)).not.toContain(FULL.pin);

    const list = await adminClient(manager.getToken()!).listPosLogins();
    const usernames = list.items.map((item) => item.username).sort();
    expect(usernames).toEqual(expect.arrayContaining(["pos.full", "pos.nopay", "pos.wrongloc"]));
    const serialized = JSON.stringify(list);
    expect(serialized).not.toMatch(/hash|salt|verifier|"pin"/i);
  });

  it("H2 wrong PIN and unknown username fail identically and are definitive", async () => {
    const wrong = await rawLogin(JSON.stringify({ username: "pos.nopay", pin: "0000" }));
    const unknown = await rawLogin(JSON.stringify({ username: "nobody.here", pin: "0000" }));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error?.code).toBe("INVALID_CREDENTIALS");
    expect(unknown.json.error).toMatchObject({
      code: wrong.json.error?.code,
      message: wrong.json.error?.message,
    });
    const manager = newManager();
    expect(await manager.login("pos.nopay", "0000")).toEqual({
      ok: false,
      reason: "INVALID_CREDENTIALS",
    });
    expect(await manager.login("nobody.here", "0000")).toEqual({
      ok: false,
      reason: "INVALID_CREDENTIALS",
    });
    expect(manager.getToken()).toBeNull();
  });

  it("H3 malformed PINs are rejected (400), not echoed, and classified as definitive", async () => {
    for (const pin of ["123", "12a4", "١٢٣٤", "1234 "]) {
      const response = await rawLogin(JSON.stringify({ username: "pos.full", pin }));
      expect(response.status, pin).toBe(400);
      expect(response.text).not.toContain(pin.trim() === "" ? "§" : pin);
    }
    expect(classifyPosAuthFailure({ name: "ApiHttpError", status: 400 })).toBe(
      "INVALID_CREDENTIALS",
    );
  });

  it("H4 an oversized request is refused at the transport ceiling (413) before any verification", async () => {
    const response = await rawLogin(
      JSON.stringify({ username: "pos.full", pin: "4".repeat(20 * 1024) }),
    );
    expect(response.status).toBe(413);
    expect(response.json.error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(classifyPosAuthFailure({ name: "ApiHttpError", status: 413 })).toBe(
      "INVALID_CREDENTIALS",
    );
    // The username was not charged a failed attempt: the correct PIN still works immediately.
    expect((await newManager().login(FULL.username, FULL.pin)).ok).toBe(true);
  });

  it("H5 a 40-digit PIN signs in; truncations of it do not (no hidden cap, no truncation)", async () => {
    expect((await newManager().login(LONG.username, LONG.pin)).ok).toBe(true);
    for (const truncated of [LONG.pin.slice(0, 8), LONG.pin.slice(0, 12)]) {
      expect(await newManager().login(LONG.username, truncated)).toEqual({
        ok: false,
        reason: "INVALID_CREDENTIALS",
      });
    }
    expect((await newManager().login(LONG.username, LONG.pin)).ok).toBe(true); // success clears the counter
  });

  it("H6 create + PIN reset through the authorised API using the POS token (no Clerk)", async () => {
    const { token } = await signedIn(FULL);
    const admin = adminClient(token);
    const username = `acc.${randomUUID().slice(0, 8)}`;
    const firstPin = "24680135792468013579246801"; // 26 digits
    const created = await admin.createPosLogin({
      idempotencyKey: randomUUID(),
      username,
      pin: firstPin,
      displayName: "Acceptance Cashier",
      roleId: CASHIER_ROLE,
      accessScopeId: TENANT_SCOPE,
      posRole: "cashier",
      posPermissions: [],
    });
    expect(JSON.stringify(created)).not.toContain(firstPin);
    expect((await newManager().login(username, firstPin)).ok).toBe(true);

    await expect(
      admin.createPosLogin({
        idempotencyKey: randomUUID(),
        username: `bad.${randomUUID().slice(0, 6)}`,
        pin: "123",
        displayName: "Too Short",
        roleId: CASHIER_ROLE,
        accessScopeId: TENANT_SCOPE,
        posRole: "cashier",
        posPermissions: [],
      }),
    ).rejects.toMatchObject({ status: 400 });

    const membershipId = (created as { membershipId: string }).membershipId;
    await admin.setPosLoginPin({ membershipId, idempotencyKey: randomUUID(), pin: "97531" });
    expect(await newManager().login(username, firstPin)).toEqual({
      ok: false,
      reason: "INVALID_CREDENTIALS",
    });
    expect((await newManager().login(username, "97531")).ok).toBe(true);
  });

  it("H7 deactivation refuses sign-in immediately and kills an already-issued token", async () => {
    const { token: cashierToken } = await signedIn(NOPAY);
    const before = await fetch(`${baseUrl}/api/v1/me/tenants`, {
      headers: { Authorization: `Bearer ${cashierToken}` },
    });
    expect(before.status).toBe(200);
    expect(await before.text()).toContain(TENANT);

    const { token } = await signedIn(FULL);
    await adminClient(token).updateStaffStatus({
      membershipId: NOPAY.membershipId,
      idempotencyKey: randomUUID(),
      status: "suspended",
      reason: "ADR-043 acceptance",
    });
    expect(await newManager().login(NOPAY.username, NOPAY.pin)).toEqual({
      ok: false,
      reason: "INVALID_CREDENTIALS",
    });
    const after = await fetch(`${baseUrl}/api/v1/me/tenants`, {
      headers: { Authorization: `Bearer ${cashierToken}` },
    });
    const afterText = await after.text();
    expect(after.status === 200 && afterText.includes(TENANT)).toBe(false);

    await adminClient(token).updateStaffStatus({
      membershipId: NOPAY.membershipId,
      idempotencyKey: randomUUID(),
      status: "active",
      reason: "ADR-043 acceptance restore",
    });
    expect((await newManager().login(NOPAY.username, NOPAY.pin)).ok).toBe(true);
  });

  it("H8 the last active POS admin cannot be demoted or suspended", async () => {
    const { token } = await signedIn(FULL);
    const admin = adminClient(token);
    await expect(
      admin.updatePosLogin({
        membershipId: FULL.membershipId,
        idempotencyKey: randomUUID(),
        posRole: "cashier",
        posPermissions: [],
      }),
    ).rejects.toMatchObject({ status: 409, code: "LAST_POS_ADMIN" });
    await expect(
      admin.updateStaffStatus({
        membershipId: FULL.membershipId,
        idempotencyKey: randomUUID(),
        status: "suspended",
        reason: "ADR-043 acceptance",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await newManager().login(FULL.username, FULL.pin)).ok).toBe(true);
  });

  it("H9 admin step-up verifies another account without replacing the signed-in session", async () => {
    const { manager } = await signedIn(NOPAY);
    const tokenBefore = manager.getToken();
    await expect(manager.verifyCredentials(FULL.username, FULL.pin)).resolves.toEqual({
      ok: true,
      role: "admin",
    });
    await expect(manager.verifyCredentials(FULL.username, "0000")).resolves.toEqual({
      ok: false,
      reason: "INVALID_CREDENTIALS",
    });
    expect(manager.getSession()?.operator.username).toBe("pos.nopay");
    expect(manager.getToken()).toBe(tokenBefore);
  });

  it("H10 five failures lock the username — for unknown usernames too (no enumeration)", async () => {
    const target = `ghost.${randomUUID().slice(0, 6)}`;
    const codes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await rawLogin(JSON.stringify({ username: target, pin: "0000" }));
      codes.push(response.json.error?.code ?? String(response.status));
    }
    expect(codes.slice(0, 5)).toEqual(Array(5).fill("INVALID_CREDENTIALS"));
    expect(codes[5]).toBe("ACCOUNT_LOCKED");
    expect(
      classifyPosAuthFailure({ name: "ApiHttpError", status: 429, code: "ACCOUNT_LOCKED" }),
    ).toBe("INVALID_CREDENTIALS");
  });
});
