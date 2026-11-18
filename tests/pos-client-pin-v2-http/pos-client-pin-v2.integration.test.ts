// Offline PIN v2 CROSS-REPO acceptance over the REAL HTTP server (Next.js API + disposable PostgreSQL), driven
// through the POS repo's COMPILED main-process modules (vendored, packed SDK) with a real SQLite file and the
// real sealed enrollment store.
//
//   K1  the retired manager-set (KEK-sealed) PIN endpoint refuses with OFFLINE_PIN_REENROLLMENT_REQUIRED.
//   (Same-PIN model, shifted-cafe as is: the offline unlock PIN IS the online sign-in PIN; the main process
//   enrols right after a successful sign-in with the credential the server just accepted.)
//   K2  enrollment online: server records an enrollment with NO PIN material; the till seals locally;
//       offline unlock works only after the next bootstrap authorises that exact enrollment.
//   K3  lost connectivity during enrollment: nothing sealed, nothing usable.
//   K4  wrong PIN x5 locks the username; the lock survives a restart.
//   K5  superseded version (server issued v2, device still holds v1): rejected and pruned at bootstrap.
//   K6  revoked (forgotten PIN) via the API: rejected and pruned at the next bootstrap.
//   K7  the lease ends: offline unlock unavailable.
//   K8  step-up: a wrong sign-in PIN, ANOTHER account's valid credential or a missing proof enrol nothing;
//       the credential is not stored anywhere server-side.
//   K9  lockout copy in the OS-sealed file: deleting the SQLite lockout row does not reset the lock.
//
// Launched exclusively by `pnpm test:pos:offline:pin-v2-client`. Requires `pnpm build:main` in the POS repo.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCommerceClient } from "../../packages/sdk/src/index";

const baseUrl = process.env.POS_TEST_API_BASE_URL;
const clerkToken = process.env.POS_TEST_CLERK_TOKEN;
const supabaseUrl = process.env.POS_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.POS_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !clerkToken || !supabaseUrl || !serviceRoleKey)
  throw new Error("Offline PIN v2 acceptance requires the isolated harness environment.");

const TENANT = "2a000001-0000-4000-8000-000000000001";
const REGISTER = "2a000005-0000-4000-8000-000000000001";
const POS_FULL = "2a000012-0000-4000-8000-000000000001";
// Test-only online POS sign-in PIN provisioned by the harness for THIS run's disposable DB. Same PIN offline.
const PIN = "4821";
const SIGN_IN = { username: "pos.full", pin: PIN, membershipId: POS_FULL } as const;
const noPinValue = (row: Record<string, unknown>) =>
  Object.values(row).every((value) => String(value) !== PIN);

const posRepo = path.resolve(
  process.env.POS_REPO_DIR ?? path.join(__dirname, "..", "..", "..", "clothing-commerce-pos"),
);
const posDist = path.join(posRepo, "dist-electron", "main", "offline");
if (!existsSync(path.join(posDist, "offline-pin-enroller.js")))
  throw new Error(`POS main-process build not found at ${posDist}. Run \`pnpm build:main\` first.`);

type Db = {
  connection: { prepare(sql: string): { get(...p: unknown[]): unknown } };
  close(): void;
};
const load = createRequire(__filename);
const m = {
  database: load(path.join(posDist, "database.js")) as {
    LocalDatabase: new (file: string) => Db;
    localDatabasePath(userData: string): string;
  },
  deviceKey: load(path.join(posDist, "device-key.js")) as {
    DeviceKeyStore: new (userData: string, storage: unknown) => unknown;
  },
  authority: load(path.join(posDist, "authority-store.js")) as {
    OfflineAuthorityStore: new (database: Db) => unknown;
  },
  roster: load(path.join(posDist, "override-roster.js")) as {
    OverrideRosterStore: new (file: string, storage: unknown, now?: () => Date) => unknown;
    overrideRosterPath(userData: string): string;
  },
  bootstrap: load(path.join(posDist, "bootstrap.js")) as {
    OfflineBootstrapService: new (
      apiBaseUrl: string,
      authority: unknown,
      keys: unknown,
      now: (() => Date) | undefined,
      roster: unknown,
    ) => { bootstrap(input: Record<string, string>): Promise<unknown> };
  },
  enrollment: load(path.join(posDist, "offline-pin-enrollment.js")) as {
    OfflinePinEnrollmentStore: new (
      file: string,
      storage: unknown,
      now?: () => Date,
    ) => {
      enrolledMemberships(): string[];
    };
    offlinePinEnrollmentPath(userData: string): string;
  },
  enroller: load(path.join(posDist, "offline-pin-enroller.js")) as {
    OfflinePinEnroller: new (
      database: Db,
      store: unknown,
      apiBaseUrl: string,
    ) => {
      enroll(input: {
        tenantId: string;
        accessToken: string;
        username: string;
        pin: string;
        membershipId: string;
      }): Promise<Record<string, unknown>>;
    };
  },
  staff: load(path.join(posDist, "staff-roster.js")) as {
    StaffRosterStore: new (
      database: Db,
      now: () => Date,
      store: unknown,
    ) => {
      verifyPin(input: { username: string; pin: string }): { ok: boolean; reason?: string };
      pruneToAuthorized(): void;
    };
  },
};

const testStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from([...plain].reverse().join(""), "utf8"),
  decryptString: (data: Buffer) => [...data.toString("utf8")].reverse().join(""),
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (plain: string) => Buffer.from([...plain].reverse().join(""), "utf8"),
  decryptStringAsync: async (data: Buffer) => ({
    result: [...data.toString("utf8")].reverse().join(""),
    shouldReEncrypt: false,
  }),
};
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const tenant = createCommerceClient({ baseUrl, getToken: async () => clerkToken }).withTenant(
  TENANT,
);

let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);
let userData: string;
let database: Db;
let keys: unknown;
let store: { enrolledMemberships(): string[] };
let staff: ReturnType<typeof makeStaff>;
function makeStaff() {
  return new m.staff.StaffRosterStore(database, now, store);
}
function openTill() {
  database = new m.database.LocalDatabase(m.database.localDatabasePath(userData));
  keys = new m.deviceKey.DeviceKeyStore(userData, testStorage);
  store = new m.enrollment.OfflinePinEnrollmentStore(
    m.enrollment.offlinePinEnrollmentPath(userData),
    testStorage,
    now,
  );
  staff = makeStaff();
}
async function bootstrap() {
  offsetMs += 10_000;
  await new m.bootstrap.OfflineBootstrapService(
    baseUrl!,
    new m.authority.OfflineAuthorityStore(database),
    keys,
    now,
    new m.roster.OverrideRosterStore(m.roster.overrideRosterPath(userData), testStorage, now),
  ).bootstrap({
    tenantId: TENANT,
    registerId: REGISTER,
    displayName: "pin-v2",
    accessToken: clerkToken!,
  });
  staff.pruneToAuthorized(); // what OfflineRuntime.bootstrap does after a successful bootstrap
}
const deviceId = () =>
  String(
    (database.connection.prepare("SELECT device_id FROM device_state").get() as Row).device_id,
  );
type Row = Record<string, unknown>;
async function enrollments() {
  const { data, error } = await admin
    .from("staff_offline_pin_enrollments")
    .select("*")
    .eq("tenant_id", TENANT)
    .order("verifier_version");
  if (error) throw error;
  return (data ?? []) as Row[];
}

beforeAll(async () => {
  userData = mkdtempSync(path.join(os.tmpdir(), "pos-pin-v2-"));
  openTill();
  await bootstrap();
});
afterAll(() => {
  database?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

describe.sequential("offline PIN v2 over the real HTTP server", () => {
  it("K1 — the retired manager-set (KEK-sealed) PIN endpoint refuses and stores nothing", async () => {
    await expect(
      tenant.setStaffOfflinePin({ idempotencyKey: randomUUID(), membershipId: POS_FULL, pin: PIN }),
    ).rejects.toMatchObject({ status: 409, code: "OFFLINE_PIN_REENROLLMENT_REQUIRED" });
    const { data } = await admin
      .from("staff_offline_pin_credentials")
      .select("membership_id")
      .eq("tenant_id", TENANT);
    expect(data ?? []).toEqual([]);
  });

  it("K2 — self-enrollment online records no PIN material; unlock works only after the next bootstrap", async () => {
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: false });
    const enroller = new m.enroller.OfflinePinEnroller(database, store, baseUrl!);
    await expect(
      enroller.enroll({ tenantId: TENANT, accessToken: clerkToken!, ...SIGN_IN, pin: "123" }),
    ).rejects.toThrow(/OFFLINE_PIN_FAILED/);
    const result = await enroller.enroll({
      tenantId: TENANT,
      accessToken: clerkToken!,
      ...SIGN_IN,
    });
    expect(result).toMatchObject({ verifierVersion: 1, effective: "after_next_bootstrap" });
    const [row] = await enrollments();
    expect(row).toMatchObject({
      membership_id: POS_FULL,
      device_id: deviceId(),
      register_id: REGISTER,
      verifier_version: 1,
      revoked_at: null,
    });
    expect(noPinValue(row!)).toBe(true);
    expect(Object.keys(row!).some((k) => /salt|hash|cipher|verifier_(?!version)/.test(k))).toBe(
      false,
    );
    // Not yet authorised on this device (authorization arrives with the next bootstrap).
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: false });
    await bootstrap();
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({
      ok: true,
      operator: { membershipId: POS_FULL, username: "pos.full" },
    });
  });

  it("K3 — lost connectivity during enrollment: nothing sealed and nothing changes", async () => {
    const before = await enrollments();
    const offline = new m.enroller.OfflinePinEnroller(database, store, "http://127.0.0.1:9");
    await expect(
      offline.enroll({ tenantId: TENANT, accessToken: clerkToken!, ...SIGN_IN }),
    ).rejects.toThrow(/OFFLINE_PIN_NETWORK/);
    expect(await enrollments()).toEqual(before);
    // The earlier enrollment (K2) still unlocks; the failed attempt changed nothing.
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: true });
  });

  it("K10 — ADR-043 §5.1: offline sales carry the operating member; the server verifies and attributes it", async () => {
    // The POS's COMPILED sale service + outbox + sync worker, delivering over the real HTTP server.
    const salesModule = load(path.join(posDist, "offline-service.js")) as {
      OfflineSaleService: new (
        database: Db,
        keys: unknown,
        now: () => Date,
        seam: undefined,
        roster: unknown,
      ) => {
        setOperatorResolver(resolver: () => string | null): void;
        getReadiness(): { ready: boolean; reason?: string };
        acceptCashSale(input: Record<string, unknown>): { syncCommandId: string };
      };
    };
    const outboxModule = load(path.join(posDist, "outbox-store.js")) as {
      OutboxStore: new (database: Db, now?: () => Date) => unknown;
    };
    const syncModule = load(path.join(posDist, "sync-worker.js")) as {
      SdkOfflineDeliveryClient: new (apiBaseUrl: string) => unknown;
      OfflineSyncWorker: new (
        outbox: unknown,
        delivery: unknown,
        options: Record<string, unknown>,
      ) => { requestRun(): Promise<void> };
    };
    await bootstrap();
    const sales = new salesModule.OfflineSaleService(
      database,
      keys,
      now,
      undefined,
      new m.roster.OverrideRosterStore(m.roster.overrideRosterPath(userData), testStorage, now),
    );
    expect(sales.getReadiness()).toMatchObject({ ready: true });
    const variant = "2a000007-0000-4000-8000-000000000001"; // fixture variant in the grant catalog
    const POS_NOPAY = "2a000012-0000-4000-8000-000000000002";
    let operator: string | null = null;
    sales.setOperatorResolver(() => operator);
    const sell = () =>
      sales.acceptCashSale({
        lines: [{ variantId: variant, quantity: 1 }],
        cashReceivedMinor: 5_000,
      }).syncCommandId;
    const legacy = sell(); // no operator known: identical to an older till
    operator = POS_FULL; // the online operator (= grant operator) switched to offline selling
    const grantOperator = sell();
    operator = POS_NOPAY; // a member with NO offline enrollment on this device: must not be trusted
    const unverified = sell();

    let workerOffset = 0;
    const workerNow = () => new Date(Date.now() + offsetMs + workerOffset);
    const worker = new syncModule.OfflineSyncWorker(
      new outboxModule.OutboxStore(database, workerNow),
      new syncModule.SdkOfflineDeliveryClient(baseUrl!),
      { now: workerNow },
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await worker.requestRun();
      workerOffset += 30 * 60_000;
    }

    const attribution = async (sync: string) => {
      const { data, error } = await admin
        .from("offline_sale_operator_attributions")
        .select("*")
        .eq("tenant_id", TENANT)
        .eq("sync_command_id", sync);
      if (error) throw error;
      return (data ?? []) as Row[];
    };
    const conflicts = async (sync: string) => {
      const { data, error } = await admin
        .from("pos_sync_conflicts")
        .select("reason_code,kind,membership_id,order_id,local_evidence")
        .eq("tenant_id", TENANT)
        .eq("sync_command_id", sync)
        .like("dedupe_key", "operator:%");
      if (error) throw error;
      return (data ?? []) as Row[];
    };

    expect(await attribution(legacy)).toEqual([
      expect.objectContaining({
        attribution: "grant_operator",
        claimed_membership_id: null,
        attributed_membership_id: POS_FULL,
      }),
    ]);
    expect(await conflicts(legacy)).toEqual([]);

    expect(await attribution(grantOperator)).toEqual([
      expect.objectContaining({
        attribution: "verified_unlock",
        claimed_membership_id: POS_FULL,
        attributed_membership_id: POS_FULL,
      }),
    ]);
    expect(await conflicts(grantOperator)).toEqual([]);

    const [claim] = await attribution(unverified);
    expect(claim).toMatchObject({
      attribution: "unverified_claim",
      claimed_membership_id: POS_NOPAY,
      attributed_membership_id: POS_FULL,
    });
    expect(claim!.order_id).toBeTruthy(); // the sale itself was recorded, never lost
    expect(await conflicts(unverified)).toEqual([
      expect.objectContaining({
        reason_code: "OFFLINE_OPERATOR_UNVERIFIED",
        kind: "sync_integrity",
        membership_id: null,
        local_evidence: expect.objectContaining({ unlockedByMembershipId: POS_NOPAY }),
      }),
    ]);
    // The till's outbox reached a terminal synced state for all three.
    const pending = database.connection
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending','leased','retry_wait')")
      .get() as Row;
    expect(Number(pending.n)).toBe(0);
  });

  it("K4 — five wrong PINs lock the username and the lock survives a restart", () => {
    for (let n = 0; n < 5; n += 1) staff.verifyPin({ username: "pos.full", pin: "000000" });
    database.close();
    openTill();
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toEqual({
      ok: false,
      reason: "THROTTLED",
    });
    offsetMs += 16 * 60_000;
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: true });
  });

  it("K5 — server supersedes v1 (device missed the update): old verifier rejected and pruned at bootstrap", async () => {
    // A re-enrollment recorded server-side WITHOUT sealing on this device (e.g. done from another session).
    const v2 = await tenant.enrollOfflinePin({
      idempotencyKey: randomUUID(),
      deviceId: deviceId(),
      registerId: REGISTER,
      stepUp: { username: SIGN_IN.username, pin: PIN },
    });
    expect(v2.verifierVersion).toBe(2);
    const rows = await enrollments();
    expect(rows.map((r) => [r.verifier_version, r.revoked_reason])).toEqual([
      [1, "superseded"],
      [2, null],
    ]);
    await bootstrap();
    expect(store.enrolledMemberships()).toEqual([]);
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: false });
  });

  it("K6 — revoked through the API (forgotten PIN): rejected and pruned at the next bootstrap", async () => {
    const enroller = new m.enroller.OfflinePinEnroller(database, store, baseUrl!);
    await enroller.enroll({ tenantId: TENANT, accessToken: clerkToken!, ...SIGN_IN });
    await bootstrap();
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: true });
    const revoked = await tenant.revokeOfflinePinEnrollments({
      idempotencyKey: randomUUID(),
      membershipId: POS_FULL,
      reason: "pin_forgotten",
    });
    expect(revoked.revoked).toBe(1);
    await bootstrap();
    expect(store.enrolledMemberships()).toEqual([]);
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: false });
    expect((await enrollments()).every((r) => r.revoked_at !== null)).toBe(true);
  });

  it("K8 — step-up: wrong sign-in PIN, another account's credential or missing proof enrol nothing", async () => {
    const enroller = new m.enroller.OfflinePinEnroller(database, store, baseUrl!);
    const before = await enrollments();
    const sealedBefore = store.enrolledMemberships();
    await expect(
      enroller.enroll({ tenantId: TENANT, accessToken: clerkToken!, ...SIGN_IN, pin: "0000" }),
    ).rejects.toThrow(/OFFLINE_PIN_STEP_UP_FAILED/);
    // A real, valid credential — but of ANOTHER account — cannot enrol the caller (pos.full's session).
    await expect(
      enroller.enroll({
        tenantId: TENANT,
        accessToken: clerkToken!,
        username: "pos.nopay",
        pin: "6390",
        membershipId: POS_FULL,
      }),
    ).rejects.toThrow(/OFFLINE_PIN_STEP_UP_FAILED/);
    // Raw HTTP without any step-up proof is rejected by validation (a token alone is not "fresh").
    await expect(
      tenant.enrollOfflinePin({
        idempotencyKey: randomUUID(),
        deviceId: deviceId(),
        registerId: REGISTER,
      } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(await enrollments()).toEqual(before);
    expect(store.enrolledMemberships()).toEqual(sealedBefore);
    // A successful enrollment stores nothing about the credential server-side, and the SAME PIN unlocks.
    await enroller.enroll({ tenantId: TENANT, accessToken: clerkToken!, ...SIGN_IN });
    expect((await enrollments()).every(noPinValue)).toBe(true);
    await bootstrap();
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: true });
  });

  it("K9 — the lockout copy in the OS-sealed file survives deleting the SQLite lockout row", () => {
    for (let n = 0; n < 5; n += 1) staff.verifyPin({ username: "pos.full", pin: "000000" });
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toEqual({
      ok: false,
      reason: "THROTTLED",
    });
    (database.connection as unknown as { exec(sql: string): void }).exec(
      "DELETE FROM offline_pin_lockout",
    );
    database.close();
    openTill();
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toEqual({
      ok: false,
      reason: "THROTTLED",
    });
    offsetMs += 16 * 60_000;
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: true });
  });

  it("K7 — when the lease ends, offline unlock is unavailable even with a valid enrollment", async () => {
    const enroller = new m.enroller.OfflinePinEnroller(database, store, baseUrl!);
    await enroller.enroll({ tenantId: TENANT, accessToken: clerkToken!, ...SIGN_IN });
    await bootstrap();
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toMatchObject({ ok: true });
    offsetMs += 25 * 60 * 60 * 1_000;
    expect(staff.verifyPin({ username: "pos.full", pin: PIN })).toEqual({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });
});
