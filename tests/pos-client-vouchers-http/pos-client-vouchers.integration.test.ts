// ADR-042 §13.6 CROSS-REPO acceptance — offline redemption of EXISTING vouchers from a CACHED policy, over the
// REAL HTTP server (Next.js API + disposable PostgreSQL), driven through the POS repo's COMPILED main-process
// modules (which resolve the POS's vendored, PACKED SDK tarball) on a real SQLite file. The Website leg uses the
// real storefront checkout route. Network isolation is applied to the POS client ONLY: its delivery client is
// replaced by one that fails with ApiNetworkError, while the Website client keeps calling the server.
//
//   V1  bootstrap issues cached policies (no counter moves); a credential-gated voucher is never issued.
//   V2  offline valid voucher -> sync: exactly one ordinary POS redemption, order net = tender.
//   V3  till local ceiling; Website consumes the remaining SHARED limit while the POS is offline; the POS sales
//       sync intact at the cashier price with VX_USAGE_EXHAUSTED conflicts (observed vs server remaining);
//       Website online redemption still enforced (third checkout refused).
//   V4  exact replay of a synced conflicted sale returns the original result, nothing duplicated.
//   V5  out-of-order delivery + lost response after commit: exactly one ingestion/redemption per sale.
//   V6  policy changed / code revoked / voucher expired after caching -> deterministic conflicts, sale intact.
//   V7  tampered snapshot digest and a forged credential-gated policy -> VX_SNAPSHOT_INVALID, no redemption.
//   V8  conflicts in the POS (register) and admin (tenant) report; no approval/edit surface exists.
//   V9  expired lease: the till refuses before writing anything.
//
// Launched exclusively by `pnpm test:pos:offline:vouchers-client`. Requires `pnpm build:main` in the POS repo.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  throw new Error("POS-client voucher acceptance requires the isolated harness environment.");

const TENANT = "2a000001-0000-4000-8000-000000000001";
const BRAND = "2a000002-0000-4000-8000-000000000001";
const REGISTER = "2a000005-0000-4000-8000-000000000001";
const VARIANT = "2a000007-0000-4000-8000-000000000001";
const PRICE = 2_500;
const P = (n: number) => `3f000001-0000-4000-8000-00000000000${n}`;
const C = (n: number) => `3f000002-0000-4000-8000-00000000000${n}`;
const posRepo = path.resolve(
  process.env.POS_REPO_DIR ?? path.join(__dirname, "..", "..", "..", "clothing-commerce-pos"),
);
const posDist = path.join(posRepo, "dist-electron", "main", "offline");
if (!existsSync(path.join(posDist, "voucher-policy.js")))
  throw new Error(`POS main-process build not found at ${posDist}. Run \`pnpm build:main\` first.`);

type Row = Record<string, unknown>;
interface PosDatabase {
  readonly connection: {
    prepare(sql: string): {
      get(...p: unknown[]): unknown;
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
    };
    exec(sql: string): void;
  };
  close(): void;
}
interface PosSales {
  getReadiness(): { ready: boolean; reason?: string; message?: string };
  acceptCashSale(input: {
    lines: Array<{ variantId: string; quantity: number }>;
    cashReceivedMinor: number;
    voucher?: { code: string };
  }): { localSaleId: string; syncCommandId: string; totalMinor: number };
}

const load = createRequire(__filename);
const m = {
  database: load(path.join(posDist, "database.js")) as {
    LocalDatabase: new (file: string) => PosDatabase;
    localDatabasePath(userData: string): string;
  },
  deviceKey: load(path.join(posDist, "device-key.js")) as {
    DeviceKeyStore: new (userData: string, storage: unknown) => unknown;
  },
  authority: load(path.join(posDist, "authority-store.js")) as {
    OfflineAuthorityStore: new (database: PosDatabase) => unknown;
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
    ) => {
      bootstrap(input: {
        tenantId: string;
        registerId: string;
        displayName: string;
        accessToken: string;
      }): Promise<unknown>;
    };
  },
  sales: load(path.join(posDist, "offline-service.js")) as {
    OfflineSaleService: new (
      database: PosDatabase,
      keys: unknown,
      now: (() => Date) | undefined,
      seam: undefined,
      roster: unknown,
    ) => PosSales;
  },
  outbox: load(path.join(posDist, "outbox-store.js")) as {
    OutboxStore: new (database: PosDatabase, now?: () => Date) => unknown;
  },
  payments: load(path.join(posDist, "payment-outbox-store.js")) as {
    PaymentOutboxStore: new (database: PosDatabase, now?: () => Date) => unknown;
  },
  customers: load(path.join(posDist, "customer-outbox-store.js")) as {
    CustomerOutboxStore: new (database: PosDatabase, now?: () => Date) => unknown;
  },
  returnOutbox: load(path.join(posDist, "return-outbox-store.js")) as {
    ReturnOutboxStore: new (database: PosDatabase, now?: () => Date) => unknown;
  },
  sync: load(path.join(posDist, "sync-worker.js")) as {
    SdkOfflineDeliveryClient: new (
      apiBaseUrl: string,
    ) => Record<string, (item: Row) => Promise<Row>>;
    OfflineSyncWorker: new (
      outbox: unknown,
      delivery: unknown,
      options: Record<string, unknown>,
    ) => {
      requestRun(): Promise<void>;
      getStatus(): { blocked: number; lastError: string | null };
    };
  },
  policy: load(path.join(posDist, "voucher-policy.js")) as {
    voucherPolicyIntegrity(row: Row, binding: { snapshotId: string; grantId: string }): string;
    voucherCodeFingerprint(tenantId: string, code: string): string;
  },
};
const { ApiNetworkError, ApiHttpError } = load(
  path.join(posRepo, "node_modules", "@shifted", "clothing-commerce-sdk"),
) as {
  ApiNetworkError: new (message: string) => Error;
  ApiHttpError: new (...args: never[]) => Error;
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
const website = createCommerceClient({ baseUrl });

let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);
let userData: string;
let keys: unknown;
let roster: unknown;
let database: PosDatabase;
let sales: PosSales;

function openTill() {
  database = new m.database.LocalDatabase(m.database.localDatabasePath(userData));
  keys = new m.deviceKey.DeviceKeyStore(userData, testStorage);
  roster = new m.roster.OverrideRosterStore(
    m.roster.overrideRosterPath(userData),
    testStorage,
    now,
  );
  sales = new m.sales.OfflineSaleService(database, keys, now, undefined, roster);
}
async function bootstrap() {
  await new m.bootstrap.OfflineBootstrapService(
    baseUrl!,
    new m.authority.OfflineAuthorityStore(database),
    keys,
    now,
    roster,
  ).bootstrap({
    tenantId: TENANT,
    registerId: REGISTER,
    displayName: "pos-client-vouchers",
    accessToken: clerkToken!,
  });
  const readiness = sales.getReadiness();
  if (!readiness.ready) throw new Error(`POS not offline-ready: ${readiness.reason}`);
}
// The SYNC WORKER runs on its own clock, far enough ahead that any retry back-off is already due. The till's
// sales keep the base clock, so their acceptedAt never drifts ahead of the server (the server refuses an
// acceptedAt more than 5 minutes in its future: OG410).
let workerAheadMs = 0;
const workerNow = () => new Date(Date.now() + offsetMs + workerAheadMs);
function worker(delivery: unknown) {
  return new m.sync.OfflineSyncWorker(new m.outbox.OutboxStore(database, workerNow), delivery, {
    now: workerNow,
    paymentOutbox: new m.payments.PaymentOutboxStore(database, workerNow),
    customerOutbox: new m.customers.CustomerOutboxStore(database, workerNow),
    returnOutbox: new m.returnOutbox.ReturnOutboxStore(database, workerNow),
  });
}
const realDelivery = () => new m.sync.SdkOfflineDeliveryClient(baseUrl!);
/** POS network isolation: every call fails before reaching the server. */
let isolatedCalls = 0;
const isolatedDelivery = () =>
  new Proxy(
    {},
    {
      get: () => async () => {
        isolatedCalls += 1;
        throw new ApiNetworkError("POS network isolated by the acceptance test");
      },
    },
  );
/** The server commits the sale, then the response is lost on the way back. */
const lossyDelivery = () => {
  const real = realDelivery();
  return new Proxy(real, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (prop === "deliver")
        return async (item: Row) => {
          await (value as (i: Row) => Promise<Row>).call(target, item);
          throw new ApiNetworkError("response lost after commit");
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
async function syncNow() {
  workerAheadMs += 30 * 60_000; // past any retry back-off, on the worker clock only
  await worker(realDelivery()).requestRun();
}
const local = (sql: string, ...args: unknown[]) =>
  database.connection.prepare(sql).get(...args) as Row;
async function rows(table: string, filter: Record<string, string>, columns = "*") {
  let query = admin.from(table).select(columns).eq("tenant_id", TENANT);
  for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}
function persistedSale(localSaleId: string): Row {
  const row = local(
    `SELECT o.sync_command_id, o.local_sale_id, g.tenant_id, o.idempotency_key, o.canonical_command,
      o.payload_hash, o.request_json, o.credential_id, o.attempts
     FROM outbox o JOIN local_sale s ON s.local_sale_id = o.local_sale_id
     JOIN offline_grant g ON g.grant_id = s.grant_id WHERE o.local_sale_id = ?`,
    localSaleId,
  );
  return {
    syncCommandId: row.sync_command_id,
    localSaleId: row.local_sale_id,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    canonicalCommand: row.canonical_command,
    payloadHash: row.payload_hash,
    requestJson: row.request_json,
    credentialId: row.credential_id,
    attempts: Number(row.attempts),
    leaseId: "replay",
    leaseExpiresAt: new Date().toISOString(),
  };
}
const sellVoucher = (code: string) =>
  sales.acceptCashSale({
    lines: [{ variantId: VARIANT, quantity: 1 }],
    cashReceivedMinor: PRICE,
    voucher: { code },
  });
const serverOrderOf = (localSaleId: string) =>
  String(
    local("SELECT server_order_id FROM local_sale WHERE local_sale_id = ?", localSaleId)
      .server_order_id,
  );
const lifecycleOf = (localSaleId: string) =>
  local("SELECT lifecycle FROM local_sale WHERE local_sale_id = ?", localSaleId).lifecycle;
async function checkout(code: string | null, expectedTotalMinor: number) {
  return website.checkout({
    idempotencyKey: randomUUID(),
    tenantId: TENANT,
    brandId: BRAND,
    lines: [{ variantId: VARIANT, quantity: 1 }],
    customer: { name: "Guest", phone: "+201001234567", email: null },
    delivery: {
      recipientName: "Recipient",
      phone: "+201001234567",
      line1: "10 Example Street",
      line2: null,
      city: "Cairo",
      region: null,
      postalCode: null,
      countryCode: "EG",
      notes: null,
    },
    paymentMethod: "cash_on_delivery",
    expectedTotalMinor,
    expectedCurrency: "USD",
    promotionCode: code,
  });
}
async function voucherException(orderId: string) {
  return (await rows("offline_voucher_exceptions", { order_id: orderId }))[0];
}

beforeAll(async () => {
  userData = mkdtempSync(path.join(os.tmpdir(), "pos-client-vouchers-"));
  openTill();
  for (const n of [1, 2, 3, 4, 5, 6])
    await tenant.upsertPromotionChannelPolicy({
      idempotencyKey: randomUUID(),
      promotionId: P(n),
      channel: "pos",
      usageLimit: null,
      offlineEnabled: true,
      requiresAdminCredentials: n === 6,
    });
  await bootstrap();
});
afterAll(() => {
  database?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

describe.sequential(
  "ADR-042 §13.6 cached-policy offline vouchers over the real HTTP server",
  () => {
    const conflicted: string[] = [];

    it("V1 — bootstrap caches policies without reserving anything; the credential-gated voucher is never issued", async () => {
      expect(Number(local("SELECT COUNT(*) AS n FROM offline_voucher_policy").n)).toBe(5);
      expect(
        local(
          "SELECT observed_remaining FROM offline_voucher_policy WHERE code_fingerprint = ?",
          m.policy.voucherCodeFingerprint(TENANT, "SAVE10"),
        ),
      ).toEqual({ observed_remaining: 3 });
      const grantId = String(
        local("SELECT grant_id FROM catalog_snapshot WHERE state = 'active'").grant_id,
      );
      const issued = await rows(
        "offline_voucher_policy_issuances",
        { offline_grant_id: grantId },
        "promotion_id",
      );
      expect(issued.map((r) => r.promotion_id).sort()).toEqual([P(1), P(2), P(3), P(4), P(5)]);
      for (const policy of await rows(
        "promotion_channel_policies",
        { channel: "pos" },
        "reserved_count,redeemed_count",
      ))
        expect(policy).toEqual({ reserved_count: 0, redeemed_count: 0 });
      expect(() => sellVoucher("ADMINONLY")).toThrow(
        expect.objectContaining({ code: "VOUCHER_NOT_AVAILABLE" }),
      );
    });

    it("V2 — an offline valid voucher syncs as exactly one ordinary POS redemption at the cashier price", async () => {
      const sale = sellVoucher("save10");
      expect(sale.totalMinor).toBe(2_250);
      await worker(isolatedDelivery()).requestRun();
      expect(lifecycleOf(sale.localSaleId)).toBe("accepted_pending_sync");
      expect(
        await rows("offline_sale_ingestions", { local_sale_id: sale.localSaleId }, "id"),
      ).toEqual([]);
      await syncNow();
      expect(lifecycleOf(sale.localSaleId)).toBe("synced");
      const orderId = serverOrderOf(sale.localSaleId);
      expect(await rows("orders", { id: orderId }, "total_minor,discount_total_minor")).toEqual([
        { total_minor: 2_250, discount_total_minor: 250 },
      ]);
      expect(await rows("payments", { order_id: orderId }, "amount_minor")).toEqual([
        { amount_minor: 2_250 },
      ]);
      expect(
        await rows(
          "promotion_redemptions",
          { order_id: orderId },
          "channel,promotion_id,discount_total_minor",
        ),
      ).toEqual([{ channel: "pos", promotion_id: P(1), discount_total_minor: 250 }]);
      expect(await rows("order_adjustments", { order_id: orderId }, "promotion_id")).toEqual([
        { promotion_id: P(1) },
      ]);
      expect(await voucherException(orderId)).toBeUndefined();
      expect(await rows("pos_sync_conflicts", { order_id: orderId }, "id")).toEqual([]);
      expect(await rows("promotion_codes", { id: C(1) }, "redemption_count")).toEqual([
        { redemption_count: 1 },
      ]);
    });

    it("V3 — Website consumes the shared limit while the POS is offline: POS sales stay intact and sync as conflicts", async () => {
      offsetMs += 10_000;
      await bootstrap();
      expect(
        local(
          "SELECT observed_remaining FROM offline_voucher_policy p JOIN catalog_snapshot s ON s.snapshot_id = p.snapshot_id WHERE s.state = 'active' AND p.code_fingerprint = ?",
          m.policy.voucherCodeFingerprint(TENANT, "SAVE10"),
        ),
      ).toEqual({ observed_remaining: 2 });

      // POS disconnected from here on.
      const a = sellVoucher("SAVE10");
      const b = sellVoucher("SAVE10");
      const before = Number(local("SELECT COUNT(*) AS n FROM local_sale").n);
      expect(() => sellVoucher("SAVE10")).toThrow(
        expect.objectContaining({ code: "VOUCHER_LOCAL_LIMIT_REACHED" }),
      );
      expect(Number(local("SELECT COUNT(*) AS n FROM local_sale").n)).toBe(before);
      isolatedCalls = 0;
      await worker(isolatedDelivery()).requestRun();
      expect(isolatedCalls).toBeGreaterThan(0);
      expect(await rows("offline_sale_ingestions", { local_sale_id: a.localSaleId }, "id")).toEqual(
        [],
      );

      // The Website stays online and uses the SAME shared code limit (3 total, 1 already used by V2).
      const first = await checkout("SAVE10", 2_250);
      const second = await checkout("SAVE10", 2_250);
      expect([first.discountTotalMinor, second.discountTotalMinor]).toEqual([250, 250]);
      await expect(checkout("SAVE10", 2_250)).rejects.toBeInstanceOf(Error);
      expect(await rows("promotion_codes", { id: C(1) }, "redemption_count")).toEqual([
        { redemption_count: 3 },
      ]);

      // Reconnect.
      await syncNow();
      for (const [sale, observed] of [
        [a, 2],
        [b, 1],
      ] as const) {
        expect(lifecycleOf(sale.localSaleId)).toBe("synced");
        expect(
          local(
            "SELECT total_minor, discount_total_minor FROM local_sale WHERE local_sale_id = ?",
            sale.localSaleId,
          ),
        ).toEqual({
          total_minor: 2_250,
          discount_total_minor: 250,
        });
        const orderId = serverOrderOf(sale.localSaleId);
        conflicted.push(sale.localSaleId);
        expect(await rows("orders", { id: orderId }, "total_minor,discount_total_minor")).toEqual([
          { total_minor: 2_250, discount_total_minor: 250 },
        ]);
        expect(await rows("payments", { order_id: orderId }, "amount_minor")).toEqual([
          { amount_minor: 2_250 },
        ]);
        expect(await rows("promotion_redemptions", { order_id: orderId }, "id")).toEqual([]);
        expect(await rows("order_adjustments", { order_id: orderId }, "id")).toEqual([]);
        const exception = await voucherException(orderId);
        expect(exception).toMatchObject({
          code: "VX_USAGE_EXHAUSTED",
          discount_total_minor: 250,
          observed_remaining: observed,
          server_remaining: 0,
          local_sale_id: sale.localSaleId,
          promotion_id: P(1),
          code_id: C(1),
        });
        expect((exception!.evidence as Row).redemptionsSinceFetchByChannel).toEqual({ online: 2 });
        const [conflict] = await rows("pos_sync_conflicts", { order_id: orderId });
        expect(conflict).toMatchObject({
          kind: "voucher",
          reason_code: "VX_USAGE_EXHAUSTED",
          status: "open",
          register_id: REGISTER,
          local_reference: sale.localSaleId,
          amount_minor: 250,
          currency: "USD",
        });
        expect(conflict!.local_evidence).toMatchObject({ observedRemaining: observed });
        expect(conflict!.server_evidence).toMatchObject({
          serverRemaining: 0,
          saleStandsAtPricePaid: true,
          redemptionRecorded: false,
          redemptionApproved: false,
          discountAttributedToPromotion: false,
        });
      }
      expect(await rows("promotion_codes", { id: C(1) }, "redemption_count")).toEqual([
        { redemption_count: 3 },
      ]);
    });

    it("V4 — exact replay of a synced conflicted sale returns the original result and duplicates nothing", async () => {
      const localSaleId = conflicted[0]!;
      const orderId = serverOrderOf(localSaleId);
      const original = await rows("offline_sale_ingestions", { local_sale_id: localSaleId }, "id");
      const counts = async () => ({
        exceptions: (await rows("offline_voucher_exceptions", { order_id: orderId }, "id")).length,
        conflicts: (await rows("pos_sync_conflicts", { order_id: orderId }, "id")).length,
        payments: (await rows("payments", { order_id: orderId }, "id")).length,
        redemptions: (await rows("promotion_redemptions", { promotion_id: P(1) }, "id")).length,
      });
      const before = await counts();
      const replay = await realDelivery().deliver!(persistedSale(localSaleId));
      expect(replay.ingestionId).toBe(original[0]!.id);
      expect(await counts()).toEqual(before);
      expect(before).toEqual({ exceptions: 1, conflicts: 1, payments: 1, redemptions: 3 });
    });

    it("V5 — out-of-order delivery and a lost response after commit: one ingestion and one redemption per sale", async () => {
      const a = sellVoucher("TAKE5");
      const b = sellVoucher("TAKE5");
      // B reaches the server first.
      await realDelivery().deliver!(persistedSale(b.localSaleId));
      // A commits on the server but the response is lost; the till keeps it pending.
      workerAheadMs += 30 * 60_000;
      await worker(lossyDelivery()).requestRun();
      expect(lifecycleOf(a.localSaleId)).toBe("accepted_pending_sync");
      expect(
        await rows("offline_sale_ingestions", { local_sale_id: a.localSaleId }, "id"),
      ).toHaveLength(1);
      await syncNow();
      for (const sale of [a, b]) {
        expect(lifecycleOf(sale.localSaleId)).toBe("synced");
        expect(
          await rows("offline_sale_ingestions", { local_sale_id: sale.localSaleId }, "id"),
        ).toHaveLength(1);
        const orderId = serverOrderOf(sale.localSaleId);
        expect(
          await rows("promotion_redemptions", { order_id: orderId }, "discount_total_minor"),
        ).toEqual([{ discount_total_minor: 500 }]);
        expect(await voucherException(orderId)).toBeUndefined();
      }
    });

    it("V6 — policy changed, code revoked, voucher expired after caching: deterministic conflicts, sale intact", async () => {
      const policy = sellVoucher("POLICY5");
      const revoke = sellVoucher("REVOKE5");
      const expire = sellVoucher("EXPIRE5");
      for (const sale of [policy, revoke, expire]) expect(sale.totalMinor).toBe(2_375);
      // Online management changes while the till is offline (narrowing the cap bumps the policy version).
      await tenant.upsertPromotionChannelPolicy({
        idempotencyKey: randomUUID(),
        promotionId: P(3),
        channel: "pos",
        usageLimit: null,
        offlineEnabled: true,
        maxDiscountPerRedemptionMinor: 100,
      });
      await tenant.setPromotionCodeStatus({
        idempotencyKey: randomUUID(),
        codeId: C(4),
        status: "disabled",
      });
      const acceptedAt = String(
        local("SELECT accepted_at FROM local_sale WHERE local_sale_id = ?", expire.localSaleId)
          .accepted_at,
      );
      await tenant.updatePromotion({
        idempotencyKey: randomUUID(),
        promotionId: P(5),
        endsAt: new Date(Date.parse(acceptedAt) - 60_000).toISOString(),
      });
      await syncNow();
      for (const [sale, code] of [
        [policy, "VX_POLICY_CHANGED"],
        [revoke, "VX_REVOKED"],
        [expire, "VX_EXPIRED"],
      ] as const) {
        expect(lifecycleOf(sale.localSaleId)).toBe("synced");
        const orderId = serverOrderOf(sale.localSaleId);
        expect(await rows("orders", { id: orderId }, "total_minor")).toEqual([
          { total_minor: 2_375 },
        ]);
        expect(await rows("payments", { order_id: orderId }, "amount_minor")).toEqual([
          { amount_minor: 2_375 },
        ]);
        expect(await rows("promotion_redemptions", { order_id: orderId }, "id")).toEqual([]);
        expect(await voucherException(orderId)).toMatchObject({ code, discount_total_minor: 125 });
        expect(await rows("pos_sync_conflicts", { order_id: orderId }, "reason_code")).toEqual([
          { reason_code: code },
        ]);
      }
      const changed = await voucherException(serverOrderOf(policy.localSaleId));
      expect(changed!.local_channel_policy_version).toBe(1);
      // Adding a cap where there was none does NOT bump the channel-policy version (pre-existing upsert rule from
      // 20261114170000 treats "no cap" as 0); the policy digest still detects it, which is what reconciliation uses.
      expect(changed!.server_channel_policy_version).toBe(1);
      expect(changed!.local_policy_digest).not.toBe(changed!.server_policy_digest);
    });

    it("V7 — a tampered snapshot digest and a forged credential-gated policy reconcile as VX_SNAPSHOT_INVALID", async () => {
      const active = local(
        "SELECT snapshot_id, grant_id FROM catalog_snapshot WHERE state = 'active'",
      );
      const snapshot = String(active.snapshot_id);
      // A fully compromised till knows its own snapshot/lease binding and can recompute the local hash.
      const binding = { snapshotId: snapshot, grantId: String(active.grant_id) };
      database.connection.exec("DROP TRIGGER immutable_offline_voucher_policy");
      // A malicious till rewrites its cached digest AND recomputes the local integrity hash.
      const take5 = local(
        "SELECT * FROM offline_voucher_policy WHERE snapshot_id = ? AND code_fingerprint = ?",
        snapshot,
        m.policy.voucherCodeFingerprint(TENANT, "TAKE5"),
      );
      const forgedDigest = { ...take5, policy_digest: "c".repeat(64) };
      database.connection
        .prepare(
          "UPDATE offline_voucher_policy SET policy_digest = ?, integrity_sha256 = ? WHERE snapshot_id = ? AND policy_issuance_id = ?",
        )
        .run(
          forgedDigest.policy_digest,
          m.policy.voucherPolicyIntegrity(forgedDigest, binding),
          snapshot,
          take5.policy_issuance_id,
        );
      // ...and forges a cached policy for the credential-gated voucher the server never issued.
      const forgedAdmin: Row = {
        ...take5,
        policy_issuance_id: randomUUID(),
        promotion_id: P(6),
        code_id: C(6),
        code_fingerprint: m.policy.voucherCodeFingerprint(TENANT, "ADMINONLY"),
        terms_json: JSON.stringify({
          ...JSON.parse(String(take5.terms_json)),
          promotionId: P(6),
          codeId: C(6),
        }),
      };
      database.connection
        .prepare(
          `INSERT INTO offline_voucher_policy(snapshot_id, policy_issuance_id, promotion_id, code_id, code_fingerprint,
          channel_policy_version, policy_digest, calculation_version, observed_remaining,
          max_discount_per_redemption_minor, requires_admin_credentials, fetched_at, expires_at, terms_json, integrity_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot,
          forgedAdmin.policy_issuance_id,
          forgedAdmin.promotion_id,
          forgedAdmin.code_id,
          forgedAdmin.code_fingerprint,
          forgedAdmin.channel_policy_version,
          forgedAdmin.policy_digest,
          forgedAdmin.calculation_version,
          forgedAdmin.observed_remaining,
          forgedAdmin.max_discount_per_redemption_minor,
          0,
          forgedAdmin.fetched_at,
          forgedAdmin.expires_at,
          forgedAdmin.terms_json,
          m.policy.voucherPolicyIntegrity(forgedAdmin, binding),
        );
      const tampered = sellVoucher("TAKE5");
      const forged = sellVoucher("ADMINONLY");
      await syncNow();
      for (const sale of [tampered, forged]) {
        expect(lifecycleOf(sale.localSaleId)).toBe("synced");
        const orderId = serverOrderOf(sale.localSaleId);
        expect(await rows("orders", { id: orderId }, "total_minor")).toEqual([
          { total_minor: 2_000 },
        ]);
        expect(await rows("promotion_redemptions", { order_id: orderId }, "id")).toEqual([]);
        expect(await voucherException(orderId)).toMatchObject({ code: "VX_SNAPSHOT_INVALID" });
      }
      expect(await rows("promotion_redemptions", { promotion_id: P(6) }, "id")).toEqual([]);
    });

    it("V8 — conflicts appear in the POS (register) and admin (tenant) reports; no approval or edit surface exists", async () => {
      const posView = await tenant.listPosSyncConflicts({
        registerId: REGISTER,
        kind: "voucher",
        limit: 200,
      });
      const adminView = await tenant.listPosSyncConflicts({ kind: "voucher", limit: 200 });
      for (const view of [posView, adminView]) {
        expect(view.items.length).toBe(7);
        expect(new Set(view.items.map((item) => item.reasonCode))).toEqual(
          new Set([
            "VX_USAGE_EXHAUSTED",
            "VX_POLICY_CHANGED",
            "VX_REVOKED",
            "VX_EXPIRED",
            "VX_SNAPSHOT_INVALID",
          ]),
        );
        for (const item of view.items) {
          expect(item.references.orderId).toBeTruthy();
          expect(JSON.stringify(item)).not.toMatch(/"(?:name|phone|email)"/);
        }
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await fetch(`${baseUrl}/api/v1/pos/sync-conflicts`, {
          method,
          headers: { authorization: `Bearer ${clerkToken}`, "x-tenant-id": TENANT },
        });
        expect(response.status, method).toBe(405);
      }
      const spec = JSON.parse(
        readFileSync(path.join(__dirname, "..", "..", "openapi", "openapi.json"), "utf8"),
      ) as {
        paths: Record<string, Record<string, unknown>>;
      };
      const conflictPaths = Object.keys(spec.paths).filter((p) => p.includes("sync-conflicts"));
      expect(conflictPaths).toEqual(["/api/v1/pos/sync-conflicts"]);
      expect(
        Object.keys(spec.paths["/api/v1/pos/sync-conflicts"]!).filter((k) => k !== "options"),
      ).toEqual(["get"]);
      expect(Object.keys(spec.paths).some((p) => /approv/i.test(p))).toBe(false);
    });

    it("V9 — after the lease expires the till refuses a voucher sale before writing anything", () => {
      const before = Number(local("SELECT COUNT(*) AS n FROM local_sale").n);
      offsetMs += 25 * 60 * 60 * 1_000;
      expect(() => sellVoucher("TAKE5")).toThrow();
      expect(Number(local("SELECT COUNT(*) AS n FROM local_sale").n)).toBe(before);
    });
  },
);

void ApiHttpError;
