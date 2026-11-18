// EMERGENCY OFFLINE STOCK-SHORTFALL acceptance over the REAL HTTP server (Next.js API + disposable PostgreSQL),
// driven through the POS repo's COMPILED main-process modules (vendored, packed SDK) on a real SQLite file. The
// Website leg uses the real public storefront checkout route. Owner's final stock model: ONE shared Website/POS
// pool, Website online during a POS outage, no split, no per-till grant, post-sync conflict reporting.
//
// Network isolation applies to the POS client ONLY (its delivery client fails with ApiNetworkError); the Website
// client keeps calling the server. SQL is used READ-ONLY for the final assertions; the one canonical write that has
// no HTTP route (Website order fulfilment, fulfillments_private.record_fulfillment) is labelled as such.
//
// Launched exclusively by `pnpm test:pos:offline:shortfall-client`. Requires `pnpm build:main` in the POS repo.
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
  throw new Error("Shortfall acceptance requires the isolated harness environment.");

const TENANT = "2a000001-0000-4000-8000-000000000001";
const BRAND = "2a000002-0000-4000-8000-000000000001";
const REGISTER = "2a000005-0000-4000-8000-000000000001";
const LOCATION = "2a000004-0000-4000-8000-000000000001";
const SHORT = "2a000007-0000-4000-8000-0000000000b1"; // fresh isolated variant, canonical stock 2
const PLENTY = "2a000007-0000-4000-8000-000000000001"; // regression variant with ample stock
const PRICE = 2_500;
const CHECKOUT_KEY = `shortfall-web-${randomUUID()}`;

const posRepo = path.resolve(
  process.env.POS_REPO_DIR ?? path.join(__dirname, "..", "..", "..", "clothing-commerce-pos"),
);
const posDist = path.join(posRepo, "dist-electron", "main", "offline");
if (!existsSync(path.join(posDist, "offline-service.js")))
  throw new Error(`POS main-process build not found at ${posDist}. Run \`pnpm build:main\` first.`);

type Row = Record<string, unknown>;
interface PosDatabase {
  readonly connection: {
    prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  };
  close(): void;
}
interface PosSales {
  getReadiness(): { ready: boolean; reason?: string };
  acceptCashSale(input: {
    lines: Array<{ variantId: string; quantity: number }>;
    cashReceivedMinor: number;
    tenders?: Array<{ method: string; amountMinor: number }>;
  }): { localSaleId: string; syncCommandId: string; totalMinor: number; localReceiptId: string };
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
    ) => { bootstrap(input: Record<string, string>): Promise<unknown> };
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
    ) => { requestRun(): Promise<void> };
  },
};
const { ApiNetworkError } = load(
  path.join(posRepo, "node_modules", "@shifted", "clothing-commerce-sdk"),
) as {
  ApiNetworkError: new (message: string) => Error;
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
let workerAheadMs = 0;
const workerNow = () => new Date(Date.now() + offsetMs + workerAheadMs);
let userData: string;
let keys: unknown;
let database: PosDatabase;
let sales: PosSales;
function openTill() {
  database = new m.database.LocalDatabase(m.database.localDatabasePath(userData));
  keys = new m.deviceKey.DeviceKeyStore(userData, testStorage);
  sales = new m.sales.OfflineSaleService(
    database,
    keys,
    now,
    undefined,
    new m.roster.OverrideRosterStore(m.roster.overrideRosterPath(userData), testStorage, now),
  );
}
async function bootstrap() {
  await new m.bootstrap.OfflineBootstrapService(
    baseUrl!,
    new m.authority.OfflineAuthorityStore(database),
    keys,
    now,
    new m.roster.OverrideRosterStore(m.roster.overrideRosterPath(userData), testStorage, now),
  ).bootstrap({
    tenantId: TENANT,
    registerId: REGISTER,
    displayName: "shortfall",
    accessToken: clerkToken!,
  });
  if (!sales.getReadiness().ready) throw new Error("POS not offline-ready");
}
function worker(delivery: unknown) {
  return new m.sync.OfflineSyncWorker(new m.outbox.OutboxStore(database, workerNow), delivery, {
    now: workerNow,
    paymentOutbox: new m.payments.PaymentOutboxStore(database, workerNow),
    customerOutbox: new m.customers.CustomerOutboxStore(database, workerNow),
    returnOutbox: new m.returnOutbox.ReturnOutboxStore(database, workerNow),
  });
}
const realDelivery = () => new m.sync.SdkOfflineDeliveryClient(baseUrl!);
let isolatedCalls = 0;
const isolatedDelivery = () =>
  new Proxy(
    {},
    {
      get: () => async () => {
        isolatedCalls += 1;
        throw new ApiNetworkError("POS network isolated");
      },
    },
  );
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
async function syncWith(delivery: unknown) {
  workerAheadMs += 30 * 60_000;
  await worker(delivery).requestRun();
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
async function balance(variant: string) {
  const [b] = await rows(
    "inventory_balances",
    { variant_id: variant, inventory_location_id: LOCATION },
    "on_hand_quantity,version",
  );
  const moves = await rows(
    "inventory_movements",
    { variant_id: variant, inventory_location_id: LOCATION },
    "quantity_delta",
  );
  return {
    onHand: Number(b!.on_hand_quantity),
    version: Number(b!.version),
    ledger: moves.reduce((sum, mv) => sum + Number(mv.quantity_delta), 0),
    movements: moves.length,
  };
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
const lifecycleOf = (id: string) =>
  local("SELECT lifecycle FROM local_sale WHERE local_sale_id = ?", id).lifecycle;
const serverOrderOf = (id: string) =>
  String(
    local("SELECT server_order_id FROM local_sale WHERE local_sale_id = ?", id).server_order_id,
  );

beforeAll(() => {
  userData = mkdtempSync(path.join(os.tmpdir(), "pos-shortfall-"));
  openTill();
});
afterAll(() => {
  database?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

describe.sequential("emergency offline stock shortfall over the real HTTP server", () => {
  let posSale: {
    localSaleId: string;
    syncCommandId: string;
    totalMinor: number;
    localReceiptId: string;
  };
  let websiteOrderId: string;
  let snapshotAsOf: string;
  let receiptBefore: Row;

  it("1-2 — fresh isolated product with canonical stock 2; the POS fetches a snapshot of 2 while online", async () => {
    expect(await balance(SHORT)).toMatchObject({ onHand: 2, ledger: 2 });
    expect(await rows("stock_reservations", { variant_id: SHORT }, "id")).toEqual([]);
    await bootstrap();
    const cached = local(
      `SELECT i.on_hand AS on_hand_quantity, i.version, i.as_of FROM inventory_snapshot i JOIN catalog_snapshot c ON c.snapshot_id = i.snapshot_id AND c.state = 'active' WHERE i.variant_id = ?`,
      SHORT,
    );
    expect(Number(cached.on_hand_quantity)).toBe(2);
    snapshotAsOf = String(cached.as_of);
  });

  it("3-4 — POS disconnected; the Website sells the 2 units through the real checkout HTTP route (ATS 2 -> 0)", async () => {
    isolatedCalls = 0;
    await worker(isolatedDelivery()).requestRun(); // POS cannot reach the server
    const result = await website.checkout({
      idempotencyKey: CHECKOUT_KEY,
      tenantId: TENANT,
      brandId: BRAND,
      lines: [{ variantId: SHORT, quantity: 2 }],
      customer: { name: "Web Guest", phone: "+201001112233", email: null },
      delivery: {
        recipientName: "Web Guest",
        phone: "+201001112233",
        line1: "1 Example St",
        line2: null,
        city: "Cairo",
        region: null,
        postalCode: null,
        countryCode: "EG",
        notes: null,
      },
      paymentMethod: "cash_on_delivery",
      expectedTotalMinor: 2 * PRICE,
      expectedCurrency: "USD",
      promotionCode: null,
    });
    expect(result).toMatchObject({ channel: "online", status: "placed", totalMinor: 5_000 });
    const [op] = await rows("checkout_operations", { normalized_key: CHECKOUT_KEY }, "order_id");
    websiteOrderId = String(op!.order_id);
    const reservations = await rows(
      "stock_reservations",
      { variant_id: SHORT },
      "order_id,quantity,consumed_quantity,status",
    );
    expect(reservations).toEqual([
      { order_id: websiteOrderId, quantity: 2, consumed_quantity: 0, status: "active" },
    ]);
    // A third Website unit is refused: shared available-to-sell is now 0.
    await expect(
      website.checkout({
        idempotencyKey: `shortfall-web-extra-${randomUUID()}`,
        tenantId: TENANT,
        brandId: BRAND,
        lines: [{ variantId: SHORT, quantity: 1 }],
        customer: { name: "Late", phone: "+201001112244", email: null },
        delivery: {
          recipientName: "Late",
          phone: "+201001112244",
          line1: "2 Example St",
          line2: null,
          city: "Cairo",
          region: null,
          postalCode: null,
          countryCode: "EG",
          notes: null,
        },
        paymentMethod: "cash_on_delivery",
        expectedTotalMinor: PRICE,
        expectedCurrency: "USD",
        promotionCode: null,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    // POS isolation evidence is asserted in step 5 (its outbox is empty until it records a sale).
  });

  it("5 — still offline, the POS completes a 2-unit sale from its snapshot (split tender), durable across a restart", async () => {
    posSale = sales.acceptCashSale({
      lines: [{ variantId: SHORT, quantity: 2 }],
      cashReceivedMinor: 0,
      tenders: [
        { method: "card", amountMinor: 3_000 },
        { method: "instapay", amountMinor: 2_000 },
      ],
    });
    expect(posSale.totalMinor).toBe(5_000);
    // Same-till local estimate is now exhausted: a further unit is refused before anything is written.
    const before = Number(local("SELECT COUNT(*) AS n FROM local_sale").n);
    expect(() =>
      sales.acceptCashSale({
        lines: [{ variantId: SHORT, quantity: 1 }],
        cashReceivedMinor: PRICE,
      }),
    ).toThrow(expect.objectContaining({ code: "PROJECTED_STOCK_INSUFFICIENT" }));
    expect(Number(local("SELECT COUNT(*) AS n FROM local_sale").n)).toBe(before);
    receiptBefore = local(
      `SELECT s.local_receipt_id, s.total_minor, s.lifecycle, o.payload_hash, o.request_json
       FROM local_sale s JOIN outbox o ON o.local_sale_id = s.local_sale_id WHERE s.local_sale_id = ?`,
      posSale.localSaleId,
    );
    isolatedCalls = 0;
    await syncWith(isolatedDelivery());
    expect(isolatedCalls).toBeGreaterThan(0);
    expect(
      await rows("offline_sale_ingestions", { local_sale_id: posSale.localSaleId }, "id"),
    ).toEqual([]);
    // Process restart: nothing in memory survives.
    database.close();
    openTill();
    expect(
      local(
        `SELECT s.local_receipt_id, s.total_minor, s.lifecycle, o.payload_hash, o.request_json
         FROM local_sale s JOIN outbox o ON o.local_sale_id = s.local_sale_id WHERE s.local_sale_id = ?`,
        posSale.localSaleId,
      ),
    ).toEqual(receiptBefore);
    const tenders = JSON.parse(String(receiptBefore.request_json)).command.tenders;
    expect(tenders).toEqual([
      { method: "card", amountMinor: 3_000 },
      { method: "instapay", amountMinor: 2_000 },
    ]);
  });

  it("6 + 8a — reconnect with a LOST RESPONSE, then sync: the sale is kept once with a shortfall conflict", async () => {
    await syncWith(lossyDelivery());
    expect(lifecycleOf(posSale.localSaleId)).toBe("accepted_pending_sync");
    const committed = await rows(
      "offline_sale_ingestions",
      { local_sale_id: posSale.localSaleId },
      "id,sync_status",
    );
    expect(committed).toHaveLength(1);
    expect(committed[0]!.sync_status).toBe("needs_reconciliation");
    await syncWith(realDelivery());
    expect(lifecycleOf(posSale.localSaleId)).toBe("needs_reconciliation");
    expect(
      await rows("offline_sale_ingestions", { local_sale_id: posSale.localSaleId }, "id"),
    ).toHaveLength(1);
  });

  it("7 — canonical state (read-only SQL): both transactions once, stock valid and nonnegative, full conflict evidence", async () => {
    const posOrderId = serverOrderOf(posSale.localSaleId);
    // Website order exactly once, POS order exactly once.
    expect(
      await rows("checkout_operations", { normalized_key: CHECKOUT_KEY }, "order_id"),
    ).toHaveLength(1);
    expect(await rows("orders", { id: websiteOrderId }, "channel,total_minor")).toEqual([
      { channel: "online", total_minor: 5_000 },
    ]);
    expect(await rows("orders", { id: posOrderId }, "channel,total_minor")).toEqual([
      { channel: "pos", total_minor: 5_000 },
    ]);
    // POS tender preserved exactly (methods + amounts); recorded in the ledger once.
    const posPayments = await rows(
      "payments",
      { order_id: posOrderId },
      "method,amount_minor,status",
    );
    expect(posPayments.map((p) => [p.amount_minor, p.status]).sort()).toEqual([
      [2_000, "captured"],
      [3_000, "captured"],
    ]);
    // Shared stock: untouched by the POS sale, nonnegative, equal to the ledger; Website hold intact.
    const after = await balance(SHORT);
    expect(after).toMatchObject({ onHand: 2, ledger: 2, movements: 1 });
    expect(await rows("fulfillments", { order_id: posOrderId }, "id")).toEqual([]);
    expect(await rows("stock_reservations", { variant_id: SHORT }, "status,quantity")).toEqual([
      { status: "active", quantity: 2 },
    ]);
    expect(await rows("offline_reconciliations", { order_id: posOrderId }, "reason")).toEqual([
      { reason: "insufficient_stock_at_ingestion" },
    ]);
    // No split / grant anywhere.
    expect(await rows("inventory_locations", { id: LOCATION }, "channel_stock_mode")).toEqual([
      { channel_stock_mode: "legacy" },
    ]);
    expect(await rows("inventory_channel_balances", {}, "id")).toEqual([]);
    expect(await rows("offline_pos_stock_grants", {}, "id")).toEqual([]);
    // The conflict.
    const conflicts = await rows("pos_sync_conflicts", { order_id: posOrderId });
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c).toMatchObject({
      kind: "stock_shortfall",
      reason_code: "STOCK_SHORTFALL_AT_SYNC",
      status: "open",
      variant_id: SHORT,
      quantity: 2,
      register_id: REGISTER,
      local_reference: posSale.localSaleId,
      sync_command_id: posSale.syncCommandId,
    });
    expect(c.local_evidence).toMatchObject({
      sku: "SHORT-TEE",
      requestedQuantity: 2,
      cachedOnHand: 2,
      localSaleId: posSale.localSaleId,
    });
    expect(Date.parse(String((c.local_evidence as Row).cachedAsOf))).toBe(Date.parse(snapshotAsOf));
    expect((c.local_evidence as Row).snapshotIssuedAt).toBeTruthy();
    expect(c.server_evidence).toMatchObject({
      canonicalOnHandAtSync: 2,
      committedToOnlineAtSync: 2,
      availableAtSync: 0,
      shortfallQuantity: 2,
      saleRecorded: true,
      stockPostedForSale: false,
      orderFulfilled: false,
    });
    expect((c.server_evidence as Row).canonicalBalanceVersion).toBe(after.version);
    expect((c.server_evidence as Row).serverCheckedAt).toBeTruthy();
    expect((c.server_evidence as Row).activeOnlineReservations).toEqual([
      expect.objectContaining({
        orderId: websiteOrderId,
        orderChannel: "online",
        reservedQuantity: 2,
      }),
    ]);
    expect(JSON.stringify(c)).not.toMatch(/Web Guest|\+2010011122/);
    // Evidence for the acceptance report (ids + conflict payload; no customer PII by construction).
    process.stdout.write(
      `SHORTFALL_EVIDENCE ${JSON.stringify({
        websiteOrderId,
        posOrderId,
        posIngestion: (
          await rows(
            "offline_sale_ingestions",
            { local_sale_id: posSale.localSaleId },
            "id,sync_status",
          )
        )[0],
        stockAfterSync: after,
        conflict: {
          id: c.id,
          kind: c.kind,
          reasonCode: c.reason_code,
          quantity: c.quantity,
          variantId: c.variant_id,
          localEvidence: c.local_evidence,
          serverEvidence: { ...(c.server_evidence as Row), interveningMovements: undefined },
        },
        payloadHash: receiptBefore.payload_hash,
      })}
`,
    );
  });

  it("7b — the Website order is then fulfilled once (no HTTP route exists: canonical fulfilment RPC); stock 0 = ledger", async () => {
    const [line] = await rows("order_lines", { order_id: websiteOrderId }, "id");
    const { error } = await admin.schema("fulfillments_private").rpc("record_fulfillment", {
      p_tenant_id: TENANT,
      p_order_id: websiteOrderId,
      p_inventory_location_id: LOCATION,
      p_actor_membership_id: null,
      p_idempotency_key: `shortfall-fulfil-${websiteOrderId}`,
      p_fulfilled_at: null,
      p_lines: [{ order_line_id: line!.id, quantity: 2 }],
    });
    expect(error).toBeNull();
    expect(await balance(SHORT)).toMatchObject({ onHand: 0, ledger: 0, movements: 2 });
    expect(await rows("stock_reservations", { variant_id: SHORT }, "status")).toEqual([
      { status: "consumed" },
    ]);
    expect(
      await rows("fulfillments", { order_id: serverOrderOf(posSale.localSaleId) }, "id"),
    ).toEqual([]);
  });

  it("8b — exact replay after acknowledgement returns the original and duplicates nothing", async () => {
    const posOrderId = serverOrderOf(posSale.localSaleId);
    const snapshot = async () => ({
      ingestions: (
        await rows("offline_sale_ingestions", { local_sale_id: posSale.localSaleId }, "id")
      ).length,
      payments: (await rows("payments", { order_id: posOrderId }, "id")).length,
      conflicts: (await rows("pos_sync_conflicts", { order_id: posOrderId }, "id")).length,
      reconciliations: (await rows("offline_reconciliations", { order_id: posOrderId }, "id"))
        .length,
      stock: await balance(SHORT),
    });
    const before = await snapshot();
    const original = await rows(
      "offline_sale_ingestions",
      { local_sale_id: posSale.localSaleId },
      "id",
    );
    const replay = await realDelivery().deliver!(persistedSale(posSale.localSaleId));
    expect(replay.ingestionId).toBe(original[0]!.id);
    expect(replay.syncStatus).toBe("needs_reconciliation");
    expect(await snapshot()).toEqual(before);
    expect(before).toMatchObject({ ingestions: 1, payments: 2, conflicts: 1, reconciliations: 1 });
  });

  it("9 — the conflict appears in the POS (register) and admin (tenant) reports; no approval/edit surface", async () => {
    const posOrderId = serverOrderOf(posSale.localSaleId);
    for (const view of [
      await tenant.listPosSyncConflicts({
        registerId: REGISTER,
        kind: "stock_shortfall",
        limit: 100,
      }),
      await tenant.listPosSyncConflicts({ kind: "stock_shortfall", limit: 100 }),
    ]) {
      const item = view.items.find((i) => i.references.orderId === posOrderId);
      expect(item).toMatchObject({
        reasonCode: "STOCK_SHORTFALL_AT_SYNC",
        quantity: 2,
        status: "open",
      });
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(`${baseUrl}/api/v1/pos/sync-conflicts`, {
        method,
        headers: { authorization: `Bearer ${clerkToken}`, "x-tenant-id": TENANT },
      });
      expect(response.status, method).toBe(405);
    }
    expect(await rows("orders", { id: posOrderId }, "total_minor")).toEqual([
      { total_minor: 5_000 },
    ]);
  });

  it("R1 — stale snapshot but stock suffices: syncs with NO conflict; R7 out-of-order delivery is fine", async () => {
    const a = sales.acceptCashSale({
      lines: [{ variantId: PLENTY, quantity: 1 }],
      cashReceivedMinor: PRICE,
    });
    const b = sales.acceptCashSale({
      lines: [{ variantId: PLENTY, quantity: 1 }],
      cashReceivedMinor: PRICE,
    });
    await realDelivery().deliver!(persistedSale(b.localSaleId)); // later sale first
    await syncWith(realDelivery());
    for (const sale of [a, b]) {
      expect(lifecycleOf(sale.localSaleId)).toBe("synced");
      expect(
        await rows("pos_sync_conflicts", { order_id: serverOrderOf(sale.localSaleId) }, "id"),
      ).toEqual([]);
    }
  });

  it("R6 — after the lease ends the till refuses a sale before writing anything", () => {
    const before = Number(local("SELECT COUNT(*) AS n FROM local_sale").n);
    offsetMs += 25 * 60 * 60 * 1_000;
    expect(() =>
      sales.acceptCashSale({
        lines: [{ variantId: PLENTY, quantity: 1 }],
        cashReceivedMinor: PRICE,
      }),
    ).toThrow();
    expect(Number(local("SELECT COUNT(*) AS n FROM local_sale").n)).toBe(before);
  });

  it("F1 — POS_OFFLINE_PIN_V2 is off on this server: offline PIN enrollment is refused and nothing is stored", async () => {
    const device = String(local("SELECT device_id FROM device_state").device_id);
    await expect(
      tenant.enrollOfflinePin({
        idempotencyKey: randomUUID(),
        deviceId: device,
        registerId: REGISTER,
        stepUp: { username: "pos.full", pin: "0000" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "OFFLINE_PIN_DISABLED" });
    expect(await rows("staff_offline_pin_enrollments", { tenant_id: TENANT }, "id")).toEqual([]);
  });
});
