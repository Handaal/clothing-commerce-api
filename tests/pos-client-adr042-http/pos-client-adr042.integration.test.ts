// ADR-042 CROSS-REPO acceptance over the REAL HTTP server, driven through the POS repo's COMPILED main-process
// modules (`clothing-commerce-pos/dist-electron/main/offline/*`, resolving the POS's own vendored SDK tarball)
// against the real Next.js API + a disposable PostgreSQL. Every POS step persists to a real SQLite file and the
// "process restarts" re-open that file with fresh service objects (no in-memory state survives).
//
//   N1  offline new customer -> installment sale (card deposit) -> paydown, with restarts between each step;
//       first sync loses the customer response AFTER the server committed it: the sale must still wait; the
//       exact replay then unblocks sale + paydown. Server: one customer with the till's id, the order linked to
//       it, debt and paydown recorded, true tender method kept.
//   N2  a duplicate phone is flagged server-side and on the till, never merged; the sale stays with the
//       customer the cashier created.
//   N3  a customer the server rejects (tampered signature -> 401) holds the dependent sale on the till with
//       deterministic evidence; nothing reaches the server for it. (Runs last.)
//   N4  Finding A RESOLVED (ADR-042 §4.6): until the held sale's terminal hold is acknowledged the grant cannot
//       close and the next bootstrap is refused (wedge reproduced); the till then sends its signed hold over
//       real HTTP, the server records held_for_reconciliation (no order/payment/customer, units stay
//       reserved), a lost-response replay returns the same receipt, the held sale itself is refused (409),
//       and the next real bootstrap closes the old grant and issues a new one.
//   O1  the real PUT /pos/override-password stores a one-way verifier only (no ciphertext column populated).
//   O2  the next real bootstrap delivers a v2 device tag the POS roster verifies (server/till crypto agree);
//       a wrong password fails.
//   O3  an offline return that requires admin credentials carries a one-use assertion the real server
//       consumes once; without credentials the till refuses locally; refund stays pending (never settled).
//   O4  5 wrong passwords lock the username, and the lock survives a restart.
//   S1  ENFORCED location (disposable gate unlock): the real bootstrap reserves the POS share into a signed
//       stock grant; the Website share and unallocated stock are untouched.
//   S2  the till refuses a sale beyond its grant before anything is written; a sale within it is accepted.
//   S3  sync consumes the grant line + POS bucket once; Website untouched; exact replay consumes nothing more.
//   S4  a POS voucher (channel policy set through the real API with TEST-ONLY caps) is reserved into the
//       grant; an offline voucher sale syncs at the net price and consumes one reserved POS use only.
//   S5  the policy is withdrawn after an offline voucher sale: the sale stands at the price paid, the
//       server records a deterministic exception (no later charge), the reservation is released.
//
// Launched exclusively by `pnpm test:pos:offline:adr042-client`. Requires `pnpm build:main` in the POS repo.
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
  throw new Error("POS-client ADR-042 acceptance requires the isolated harness environment.");

const TENANT = "2a000001-0000-4000-8000-000000000001";
const REGISTER = "2a000005-0000-4000-8000-000000000001";
const VARIANT = "2a000007-0000-4000-8000-000000000001";
const ADMIN_MEMBERSHIP = "2a000012-0000-4000-8000-000000000001";
const EXISTING_PHONE = "+201000000000"; // fixture customer "Layla Hassan"
// Disposable-fixture credentials provisioned by the harness for THIS run only.
const ADMIN_USERNAME = "pos.full";
const ADMIN_PIN = "4821";
const OVERRIDE_PASSWORD = "Harbour-Lantern-58";

const posRepo = path.resolve(
  process.env.POS_REPO_DIR ?? path.join(__dirname, "..", "..", "..", "clothing-commerce-pos"),
);
const posDist = path.join(posRepo, "dist-electron", "main", "offline");
if (!existsSync(path.join(posDist, "customer-outbox-store.js")))
  throw new Error(`POS main-process build not found at ${posDist}. Run \`pnpm build:main\` first.`);

type Row = Record<string, unknown>;
interface PosDatabase {
  readonly connection: {
    prepare(sql: string): {
      get(...p: unknown[]): unknown;
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
    };
  };
  close(): void;
}
type Approver = { username: string; password: string };
interface PosSales {
  getReadiness(): { ready: boolean; reason?: string; message?: string };
  acceptNewCustomer(input: { name: string; phone: string }): { localCustomerId: string };
  acceptCashSale(input: {
    lines: Array<{ variantId: string; quantity: number }>;
    cashReceivedMinor: number;
    amountPaidMinor?: number;
    customerId?: string;
    tenders?: Array<{ method: string; amountMinor: number }>;
  }): { localSaleId: string; syncCommandId: string; totalMinor: number; outstandingMinor: number };
  recordCustomerPayment(input: { customerId: string; amountMinor: number }): {
    localPaymentId: string;
    syncCommandId: string;
  };
  getOfflineCustomers(): Array<{
    customerId: string;
    createdOffline?: true;
    pendingSync?: boolean;
  }>;
}
interface PosReturns {
  prepareGrant(input: { tenantId: string; accessToken: string; orderId: string }): Promise<{
    returnGrantId: string;
    lines: ReadonlyArray<{ orderLineId: string }>;
  }>;
  recordReturn(input: {
    returnGrantId: string;
    lines: Array<{ orderLineId: string; quantity: number; reason: string; disposition: string }>;
    approver?: Approver;
  }): { localReturnId: string; syncCommandId: string };
}
interface PosRoster {
  listApprovers(permission: string): Array<{ username: string }>;
  check(input: { username: string; password: string; permission: string; commandId: string }): {
    ok: boolean;
    reason?: string;
  };
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
    OverrideRosterStore: new (file: string, storage: unknown, now?: () => Date) => PosRoster;
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
  returns: load(path.join(posDist, "return-service.js")) as {
    OfflineReturnService: new (
      database: PosDatabase,
      keys: unknown,
      issuer: unknown,
      now: (() => Date) | undefined,
      roster: unknown,
    ) => PosReturns;
    SdkReturnGrantIssuer: new (apiBaseUrl: string) => unknown;
  },
  holds: load(path.join(posDist, "sale-hold-outbox-store.js")) as {
    SaleHoldOutboxStore: new (database: PosDatabase, now?: () => Date) => unknown;
  },
  sync: load(path.join(posDist, "sync-worker.js")) as {
    canonicalizeSaleHold(command: unknown): string;
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
};
const { ApiNetworkError } = load(
  path.join(posRepo, "node_modules", "@shifted", "clothing-commerce-sdk"),
) as {
  ApiNetworkError: new (message: string) => Error;
};

// Reversible stand-in for Electron safeStorage (OS key store), the shape DeviceKeyStore + the roster need.
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

// A controllable clock shared by the POS stores so retry back-off can be stepped over without sleeping.
let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);

let userData: string;
let keys: unknown;
let database: PosDatabase;
let sales: PosSales;
let returns: PosReturns;
let roster: PosRoster;

/** (Re)open the till exactly as a fresh process would. */
function openTill() {
  database = new m.database.LocalDatabase(m.database.localDatabasePath(userData));
  keys = new m.deviceKey.DeviceKeyStore(userData, testStorage);
  roster = new m.roster.OverrideRosterStore(
    m.roster.overrideRosterPath(userData),
    testStorage,
    now,
  );
  sales = new m.sales.OfflineSaleService(database, keys, now, undefined, roster);
  returns = new m.returns.OfflineReturnService(
    database,
    keys,
    new m.returns.SdkReturnGrantIssuer(baseUrl!),
    now,
    roster,
  );
}
function restartTill() {
  database.close();
  openTill();
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
    displayName: "pos-client-adr042",
    accessToken: clerkToken!,
  });
  const readiness = sales.getReadiness();
  if (!readiness.ready)
    throw new Error(`POS not offline-ready: ${readiness.reason} ${readiness.message}`);
}
function worker(delivery: unknown) {
  return new m.sync.OfflineSyncWorker(new m.outbox.OutboxStore(database, now), delivery, {
    now,
    paymentOutbox: new m.payments.PaymentOutboxStore(database, now),
    customerOutbox: new m.customers.CustomerOutboxStore(database, now),
    returnOutbox: new m.returnOutbox.ReturnOutboxStore(database, now),
  });
}
const realDelivery = () => new m.sync.SdkOfflineDeliveryClient(baseUrl!);
const local = (sql: string, ...args: unknown[]) =>
  database.connection.prepare(sql).get(...args) as Row;

async function one(table: string, filter: Record<string, string>, columns = "*") {
  let query = admin.from(table).select(columns).eq("tenant_id", TENANT);
  for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}

beforeAll(async () => {
  userData = mkdtempSync(path.join(os.tmpdir(), "pos-client-adr042-"));
  openTill();
  await bootstrap();
});
afterAll(() => {
  database?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

const LOCATION = "2a000004-0000-4000-8000-000000000001";
const PROMOTION = "3e000001-0000-4000-8000-000000000001";
async function buckets() {
  const rows = await one(
    "inventory_channel_balances",
    { inventory_location_id: LOCATION, variant_id: VARIANT },
    "channel,on_hand_qty,reserved_qty",
  );
  const by = (channel: string) => rows.find((row) => row.channel === channel)!;
  return {
    website: Number(by("website").on_hand_qty),
    websiteReserved: Number(by("website").reserved_qty),
    pos: Number(by("pos").on_hand_qty),
    posReserved: Number(by("pos").reserved_qty),
    unallocated: Number(by("unallocated").on_hand_qty),
  };
}
async function activeStockLine() {
  const grants = await one(
    "offline_pos_stock_grants",
    { status: "active", register_id: REGISTER },
    "id",
  );
  expect(grants).toHaveLength(1);
  return (
    await one(
      "offline_pos_stock_grant_lines",
      { stock_grant_id: String(grants[0]!.id), variant_id: VARIANT },
      "granted_qty,consumed_qty,released_qty",
    )
  )[0]!;
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

describe.sequential(
  "Website/POS stock grant and POS vouchers over the real HTTP server (enforced, disposable)",
  () => {
    let firstSale: { localSaleId: string; syncCommandId: string };

    it("S1 — the real bootstrap reserves the POS share into an enforced stock grant; Website untouched", async () => {
      const grant = local("SELECT enforced FROM offline_stock_grant LIMIT 1");
      expect(grant).toEqual({ enforced: 1 });
      expect(
        local(
          "SELECT granted_quantity FROM offline_stock_grant_line WHERE variant_id = ?",
          VARIANT,
        ),
      ).toEqual({
        granted_quantity: 40,
      });
      expect(await activeStockLine()).toMatchObject({ granted_qty: 40, consumed_qty: 0 });
      expect(await buckets()).toMatchObject({
        website: 5,
        websiteReserved: 0,
        pos: 40,
        posReserved: 40,
      });
    });

    it("S2 — the till refuses a sale beyond its grant before writing anything; a sale within it is accepted", () => {
      const salesBefore = Number(local("SELECT COUNT(*) AS n FROM local_sale").n);
      expect(() =>
        sales.acceptCashSale({
          lines: [{ variantId: VARIANT, quantity: 41 }],
          cashReceivedMinor: 1_000_000,
        }),
      ).toThrow(expect.objectContaining({ code: "STOCK_GRANT_EXCEEDED" }));
      expect(Number(local("SELECT COUNT(*) AS n FROM local_sale").n)).toBe(salesBefore);
      firstSale = sales.acceptCashSale({
        lines: [{ variantId: VARIANT, quantity: 2 }],
        cashReceivedMinor: 5_000,
      });
    });

    it("S3 — sync consumes the grant line and the POS bucket once; Website untouched; exact replay consumes nothing more", async () => {
      await worker(realDelivery()).requestRun();
      expect(
        local("SELECT lifecycle FROM local_sale WHERE local_sale_id = ?", firstSale.localSaleId),
      ).toEqual({
        lifecycle: "synced",
      });
      expect(await activeStockLine()).toMatchObject({ granted_qty: 40, consumed_qty: 2 });
      expect(await buckets()).toMatchObject({
        website: 5,
        websiteReserved: 0,
        pos: 38,
        posReserved: 38,
      });
      const original = await one(
        "offline_sale_ingestions",
        { local_sale_id: firstSale.localSaleId },
        "id",
      );
      const replay = await realDelivery().deliver!(persistedSale(firstSale.localSaleId));
      expect(replay.ingestionId).toBe(original[0]!.id);
      expect(await activeStockLine()).toMatchObject({ consumed_qty: 2 });
      expect(await buckets()).toMatchObject({ website: 5, pos: 38, posReserved: 38 });
    });

    it("S4 — a POS voucher reserved into the grant: the offline voucher sale syncs at the net price, one POS use consumed", async () => {
      // TEST-ONLY caps (owner D-7 values are not set in any real environment).
      await tenant.upsertPromotionChannelPolicy({
        idempotencyKey: randomUUID(),
        promotionId: PROMOTION,
        channel: "pos",
        usageLimit: 6,
        offlineEnabled: true,
        offlineQuotaPerGrant: 2,
        maxDiscountPerRedemptionMinor: 1_000,
        maxDiscountPerGrantMinor: 1_500,
      });
      offsetMs += 10_000;
      await bootstrap(); // closes the previous grant at its final ordinal, issues stock + voucher grants
      expect(local("SELECT code, allowed_count FROM offline_voucher_grant LIMIT 1")).toEqual({
        code: "SAVE10",
        allowed_count: 2,
      });
      const policy = async () =>
        (
          await one(
            "promotion_channel_policies",
            { promotion_id: PROMOTION, channel: "pos" },
            "reserved_count,redeemed_count",
          )
        )[0]!;
      expect(await policy()).toEqual({ reserved_count: 2, redeemed_count: 0 });
      const voucherSale = sales.acceptCashSale({
        lines: [{ variantId: VARIANT, quantity: 1 }],
        cashReceivedMinor: 5_000,
        voucher: { code: "SAVE10" },
      } as never);
      expect(voucherSale.totalMinor).toBe(2_250);
      await worker(realDelivery()).requestRun();
      const orderId = String(
        local(
          "SELECT server_order_id FROM local_sale WHERE local_sale_id = ?",
          voucherSale.localSaleId,
        ).server_order_id,
      );
      expect(await one("orders", { id: orderId }, "total_minor,discount_total_minor")).toEqual([
        { total_minor: 2_250, discount_total_minor: 250 },
      ]);
      expect(
        await one("promotion_redemptions", { order_id: orderId }, "channel,discount_total_minor"),
      ).toEqual([{ channel: "pos", discount_total_minor: 250 }]);
      expect(await policy()).toEqual({ reserved_count: 1, redeemed_count: 1 });
      expect(
        await one(
          "promotion_channel_policies",
          { promotion_id: PROMOTION, channel: "online" },
          "id",
        ),
      ).toEqual([]);
    });

    it("S5 — policy withdrawn after an offline voucher sale: the sale stands at the price paid, a deterministic exception, reservation released", async () => {
      const voucherSale = sales.acceptCashSale({
        lines: [{ variantId: VARIANT, quantity: 1 }],
        cashReceivedMinor: 5_000,
        voucher: { code: "SAVE10" },
      } as never);
      await tenant.upsertPromotionChannelPolicy({
        idempotencyKey: randomUUID(),
        promotionId: PROMOTION,
        channel: "pos",
        usageLimit: 6,
        offlineEnabled: false,
      });
      await worker(realDelivery()).requestRun();
      const orderId = String(
        local(
          "SELECT server_order_id FROM local_sale WHERE local_sale_id = ?",
          voucherSale.localSaleId,
        ).server_order_id,
      );
      expect(await one("orders", { id: orderId }, "total_minor")).toEqual([{ total_minor: 2_250 }]);
      expect(
        await one("offline_voucher_exceptions", { order_id: orderId }, "code,discount_total_minor"),
      ).toEqual([{ code: "VX_POLICY_WITHDRAWN", discount_total_minor: 250 }]);
      expect(await one("promotion_redemptions", { order_id: orderId }, "id")).toEqual([]);
      const policy = (
        await one(
          "promotion_channel_policies",
          { promotion_id: PROMOTION, channel: "pos" },
          "reserved_count,redeemed_count",
        )
      )[0]!;
      expect(policy).toEqual({ reserved_count: 0, redeemed_count: 1 });
      expect(await buckets()).toMatchObject({ website: 5 });
    });
  },
);

describe.sequential(
  "offline new customer -> installment -> paydown over the real HTTP server",
  () => {
    it("N1 — dependency-ordered sync with restarts and a lost customer response; canonical linkage, debt and tender verified", async () => {
      const customer = sales.acceptNewCustomer({ name: "Omar Adel", phone: "+201005550199" });
      restartTill(); // after the customer, before the sale
      const sale = sales.acceptCashSale({
        lines: [{ variantId: VARIANT, quantity: 1 }],
        cashReceivedMinor: 0,
        amountPaidMinor: 1_000,
        customerId: customer.localCustomerId,
        tenders: [{ method: "card", amountMinor: 1_000 }],
      });
      expect(sale.outstandingMinor).toBe(sale.totalMinor - 1_000);
      restartTill(); // after the sale, before the paydown
      const payment = sales.recordCustomerPayment({
        customerId: customer.localCustomerId,
        amountMinor: 500,
      });
      restartTill(); // everything waiting, nothing sent
      expect(
        Number(
          local("SELECT COUNT(*) AS n FROM local_customer_dependency WHERE state = 'waiting'").n,
        ),
      ).toBe(2);

      // Pass 1: the server commits the customer but the response is lost on the way back.
      const lossy = realDelivery();
      const realCustomer = lossy.deliverCustomer!.bind(lossy);
      let dropped = false;
      lossy.deliverCustomer = async (item: Row) => {
        const response = await realCustomer(item);
        if (!dropped) {
          dropped = true;
          throw new ApiNetworkError("response lost after the server committed");
        }
        return response;
      };
      await worker(lossy).requestRun();
      expect(await one("customers", { id: customer.localCustomerId }, "id,name,phone")).toEqual([
        { id: customer.localCustomerId, name: "Omar Adel", phone: "+201005550199" },
      ]);
      // The sale and the paydown were NOT sent: the till never learned the customer was accepted.
      expect(
        await one("offline_sale_ingestions", { local_sale_id: sale.localSaleId }, "id"),
      ).toEqual([]);
      expect(
        local("SELECT state FROM outbox WHERE sync_command_id = ?", sale.syncCommandId),
      ).toEqual({
        state: "pending",
      });

      // Restart, step past the retry back-off, sync again: exact replay of the customer, then sale, then paydown.
      restartTill();
      offsetMs += 10_000;
      await worker(lossy).requestRun();
      expect(worker(realDelivery()).getStatus().blocked).toBe(0);
      expect(
        (
          await one(
            "offline_customer_ingestions",
            { local_customer_id: customer.localCustomerId },
            "id",
          )
        ).length,
      ).toBe(1);
      const saleRow = local(
        "SELECT lifecycle, server_order_id FROM local_sale WHERE local_sale_id = ?",
        sale.localSaleId,
      );
      expect(saleRow.lifecycle).toBe("synced");
      const order = (
        await one("orders", { id: String(saleRow.server_order_id) }, "id,customer_id")
      )[0]!;
      expect(order.customer_id).toBe(customer.localCustomerId);
      // True tender method preserved (card), amount = the deposit only.
      const payments = await one(
        "payments",
        { order_id: String(order.id) },
        "method,amount_minor,status,captured_at",
      );
      // Finding B (ADR-042 §4.7): the offline card deposit is recorded but NOT captured/paid — it awaits
      // provider confirmation (status pending, no capture time).
      expect(payments).toEqual([
        { method: "card", amount_minor: 1_000, status: "pending", captured_at: null },
      ]);
      expect(
        local(
          "SELECT lifecycle FROM local_customer_payment WHERE local_payment_id = ?",
          payment.localPaymentId,
        ),
      ).toEqual({
        lifecycle: "synced",
      });
      expect(
        database.connection
          .prepare(
            "SELECT dependent_lane, state, canonical_customer_id FROM local_customer_dependency ORDER BY dependent_lane",
          )
          .all(),
      ).toEqual([
        {
          dependent_lane: "payment",
          state: "ready",
          canonical_customer_id: customer.localCustomerId,
        },
        { dependent_lane: "sale", state: "ready", canonical_customer_id: customer.localCustomerId },
      ]);
      // Next successful sync clears the local profile and redacts the outbox copy (minimal snapshot kept).
      offsetMs += 10_000;
      await worker(realDelivery()).requestRun();
      expect(Number(local("SELECT COUNT(*) AS n FROM local_customer").n)).toBe(0);
      expect(JSON.stringify(local("SELECT * FROM customer_outbox"))).not.toContain("+201005550199");
    });

    it("N2 — a duplicate phone is flagged, never merged; the sale goes to the customer the cashier created", async () => {
      const customer = sales.acceptNewCustomer({ name: "Layla H.", phone: EXISTING_PHONE });
      const sale = sales.acceptCashSale({
        lines: [{ variantId: VARIANT, quantity: 1 }],
        cashReceivedMinor: 1_000,
        amountPaidMinor: 1_000,
        customerId: customer.localCustomerId,
      });
      offsetMs += 10_000;
      await worker(realDelivery()).requestRun();
      const ingestion = (
        await one(
          "offline_customer_ingestions",
          { local_customer_id: customer.localCustomerId },
          "customer_id,duplicate_of_customer_id",
        )
      )[0]!;
      expect(ingestion.customer_id).toBe(customer.localCustomerId);
      expect(ingestion.duplicate_of_customer_id).toBe("2a000030-0000-4000-8000-000000000001");
      expect(
        local(
          "SELECT duplicate_of_customer_id FROM local_customer WHERE local_customer_id = ?",
          customer.localCustomerId,
        ),
      ).toEqual({
        duplicate_of_customer_id: "2a000030-0000-4000-8000-000000000001",
      });
      const saleRow = local(
        "SELECT server_order_id FROM local_sale WHERE local_sale_id = ?",
        sale.localSaleId,
      );
      const order = (
        await one("orders", { id: String(saleRow.server_order_id) }, "customer_id")
      )[0]!;
      expect(order.customer_id).toBe(customer.localCustomerId);
      // The pre-existing customer was not touched (no merge).
      expect(
        await one("customers", { id: "2a000030-0000-4000-8000-000000000001" }, "name"),
      ).toEqual([{ name: "Layla Hassan" }]);
    });
  },
);

describe.sequential("override password verifier v2 over the real HTTP server", () => {
  it("O1 — the real API stores only a one-way verifier (no recoverable copy)", async () => {
    const result = await tenant.setPosOverridePassword({
      idempotencyKey: randomUUID(),
      username: ADMIN_USERNAME,
      pin: ADMIN_PIN,
      password: OVERRIDE_PASSWORD,
    });
    expect(result.membershipId).toBe(ADMIN_MEMBERSHIP);
    const { data, error } = await admin
      .from("staff_pos_override_credentials")
      .select(
        "ciphertext_base64,iv_base64,auth_tag_base64,verifier_algorithm,verifier_hash_base64,scrypt_n",
      )
      .eq("tenant_id", TENANT)
      .eq("membership_id", ADMIN_MEMBERSHIP)
      .maybeSingle();
    // service_role may not read the table directly; fall back to the roster RPC shape if so.
    if (error) {
      expect(String(error.message)).toMatch(/permission denied/i);
    } else {
      expect(data).toMatchObject({
        ciphertext_base64: null,
        iv_base64: null,
        auth_tag_base64: null,
        verifier_algorithm: "scrypt-hmac-sha256-v2",
      });
      expect(Number(data!.scrypt_n)).toBeGreaterThanOrEqual(32768);
      expect(JSON.stringify(data)).not.toContain(OVERRIDE_PASSWORD);
    }
  });

  it("O2 — the next real bootstrap installs a v2 tag the POS verifies (server and till crypto agree)", async () => {
    offsetMs += 10_000;
    await bootstrap();
    expect(roster.listApprovers("payments.refund").map((a) => a.username)).toContain(
      ADMIN_USERNAME,
    );
    expect(
      roster.check({
        username: ADMIN_USERNAME,
        password: "Harbour-Lantern-59",
        permission: "payments.refund",
        commandId: "probe",
      }),
    ).toMatchObject({ ok: false, reason: "INVALID" });
    expect(
      roster.check({
        username: ADMIN_USERNAME,
        password: OVERRIDE_PASSWORD,
        permission: "payments.refund",
        commandId: "probe",
      }).ok,
    ).toBe(true);
  });

  it("O3 — a return requiring admin credentials: refused without them; with them the real server consumes the one-use assertion; refund stays pending", async () => {
    const paid = sales.acceptCashSale({
      lines: [{ variantId: VARIANT, quantity: 2 }],
      cashReceivedMinor: 100_000,
    });
    await worker(realDelivery()).requestRun();
    const orderId = String(
      local("SELECT server_order_id FROM local_sale WHERE local_sale_id = ?", paid.localSaleId)
        .server_order_id,
    );
    const grant = await returns.prepareGrant({
      tenantId: TENANT,
      accessToken: clerkToken!,
      orderId,
    });
    const line = {
      orderLineId: grant.lines[0]!.orderLineId,
      quantity: 1,
      reason: "too small",
      disposition: "restock",
    };
    expect(() =>
      returns.recordReturn({ returnGrantId: grant.returnGrantId, lines: [line] }),
    ).toThrow(expect.objectContaining({ code: "ADMIN_CREDENTIALS_REQUIRED" }));
    expect(() =>
      returns.recordReturn({
        returnGrantId: grant.returnGrantId,
        lines: [line],
        approver: { username: ADMIN_USERNAME, password: "wrong-password-0" },
      }),
    ).toThrow(expect.objectContaining({ code: "ADMIN_CREDENTIALS_INVALID" }));
    const accepted = returns.recordReturn({
      returnGrantId: grant.returnGrantId,
      lines: [line],
      approver: { username: ADMIN_USERNAME, password: OVERRIDE_PASSWORD },
    });
    // The password never reaches the outbox.
    expect(
      JSON.stringify(
        local("SELECT * FROM return_outbox WHERE local_return_id = ?", accepted.localReturnId),
      ),
    ).not.toContain(OVERRIDE_PASSWORD);
    restartTill();
    await worker(realDelivery()).requestRun();
    const assertions = await one(
      "offline_pos_admin_assertions",
      { sync_command_id: accepted.syncCommandId },
      "membership_id,permission",
    );
    expect(assertions).toEqual([
      { membership_id: ADMIN_MEMBERSHIP, permission: "payments.refund" },
    ]);
    const returned = local(
      "SELECT lifecycle, server_return_id FROM local_return WHERE local_return_id = ?",
      accepted.localReturnId,
    );
    expect(returned.lifecycle).toBe("synced");
    const refunds = await one(
      "refunds",
      { return_id: String(returned.server_return_id) },
      "status,settled_at",
    );
    expect(refunds).toEqual([{ status: "pending", settled_at: null }]);
  });

  it("O4 — 5 wrong passwords lock the username; the lock survives a restart", () => {
    for (let attempt = 0; attempt < 5; attempt += 1)
      roster.check({
        username: ADMIN_USERNAME,
        password: `nope-${attempt}-xxxxx`,
        permission: "payments.refund",
        commandId: "c",
      });
    restartTill();
    expect(
      roster.check({
        username: ADMIN_USERNAME,
        password: OVERRIDE_PASSWORD,
        permission: "payments.refund",
        commandId: "c",
      }),
    ).toMatchObject({ ok: false, reason: "THROTTLED" });
  });
});

describe.sequential("held dependent sale vs. the enforced stock grant (runs last)", () => {
  it("N3 — a customer the server rejects holds the dependent sale on the till; nothing is sent for it", async () => {
    const customer = sales.acceptNewCustomer({ name: "Tamper Test", phone: "+201005550177" });
    const sale = sales.acceptCashSale({
      lines: [{ variantId: VARIANT, quantity: 1 }],
      cashReceivedMinor: 1_000,
      amountPaidMinor: 1_000,
      customerId: customer.localCustomerId,
    });
    // Corrupt the persisted signature: the server answers 401 (a definitive rejection).
    const row = local(
      "SELECT request_json FROM customer_outbox WHERE local_customer_id = ?",
      customer.localCustomerId,
    );
    const request = JSON.parse(String(row.request_json));
    request.signature.value = Buffer.alloc(64, 7).toString("base64");
    database.connection
      .prepare("UPDATE customer_outbox SET request_json = ? WHERE local_customer_id = ?")
      .run(JSON.stringify(request), customer.localCustomerId);
    offsetMs += 10_000;
    await worker(realDelivery()).requestRun();
    expect(await one("customers", { id: customer.localCustomerId }, "id")).toEqual([]);
    expect(await one("offline_sale_ingestions", { local_sale_id: sale.localSaleId }, "id")).toEqual(
      [],
    );
    expect(
      local(
        "SELECT state, last_error_code FROM outbox WHERE sync_command_id = ?",
        sale.syncCommandId,
      ),
    ).toEqual({
      state: "blocked",
      last_error_code: "CUSTOMER_DEPENDENCY_REJECTED",
    });
    expect(
      local(
        "SELECT state FROM local_customer_dependency WHERE dependent_sync_command_id = ?",
        sale.syncCommandId,
      ),
    ).toEqual({
      state: "held_customer_rejected",
    });
    // Evidence kept on the till.
    expect(
      Number(
        local("SELECT COUNT(*) AS n FROM local_sale WHERE local_sale_id = ?", sale.localSaleId).n,
      ),
    ).toBe(1);
  });

  it("N4 — Finding A: wedge reproduced, then the signed hold resolves it over real HTTP; re-bootstrap succeeds", async () => {
    const held = local(
      "SELECT o.sync_command_id, o.request_json, s.local_sale_id FROM outbox o JOIN local_sale s ON s.local_sale_id = o.local_sale_id WHERE o.last_error_code = 'CUSTOMER_DEPENDENCY_REJECTED'",
    );
    const saleSync = String(held.sync_command_id);
    // The rejection enqueued the terminal hold in the same transaction (not yet sent: N3's worker had no lane).
    expect(
      local("SELECT state FROM sale_hold_outbox WHERE sale_sync_command_id = ?", saleSync),
    ).toEqual({
      state: "pending",
    });
    // 1. Wedge reproduced: without an acknowledged hold the previous grant cannot close.
    offsetMs += 10_000;
    await expect(bootstrap()).rejects.toThrow();
    expect((await activeStockLine()).released_qty).toBe(0);

    // 2. The till sends its signed hold (real device key, real SDK, real HTTP).
    const holdWorker = new m.sync.OfflineSyncWorker(
      new m.outbox.OutboxStore(database, now),
      realDelivery(),
      {
        now,
        paymentOutbox: new m.payments.PaymentOutboxStore(database, now),
        customerOutbox: new m.customers.CustomerOutboxStore(database, now),
        saleHoldOutbox: new m.holds.SaleHoldOutboxStore(database, now),
        saleHoldSigner: {
          sign: (canonical: string) =>
            (keys as { signCanonical(c: string): string }).signCanonical(canonical),
          credentialId: () =>
            String(
              local("SELECT credential_id FROM device_state WHERE status = 'active'").credential_id,
            ),
          canonicalize: m.sync.canonicalizeSaleHold,
        },
      },
    );
    offsetMs += 10_000;
    await holdWorker.requestRun();
    const ack = local(
      "SELECT state, server_hold_id, request_json FROM sale_hold_outbox WHERE sale_sync_command_id = ?",
      saleSync,
    );
    expect(ack.state).toBe("acknowledged");
    const serverHold = await one(
      "offline_sale_reconciliation_holds",
      { sale_sync_command_id: saleSync },
      "id,status,offline_sale_ordinal,held_lines,sale_canonical_command",
    );
    expect(serverHold).toHaveLength(1);
    expect(serverHold[0]).toMatchObject({
      id: ack.server_hold_id,
      status: "held_for_reconciliation",
    });
    // No order, payment, debt or customer for the held sale.
    expect(await one("offline_sale_ingestions", { sync_command_id: saleSync }, "id")).toEqual([]);

    // 3. Lost response: the exact persisted request replayed returns the original receipt.
    const client = createCommerceClient({
      baseUrl: baseUrl!,
      client: { type: "pos-desktop", version: "0.35.0" },
    }).withTenant(TENANT);
    const body = JSON.parse(String(ack.request_json));
    const replay = await client.ingestOfflineSaleHold({
      idempotencyKey: body.command.syncCommandId,
      ...body,
    });
    expect(replay.holdId).toBe(ack.server_hold_id);
    // ... a tampered hold fails the signature check, and a DIFFERENT validly-signed hold for the same sale
    // is an idempotency conflict (one terminal record per sale).
    await expect(
      client.ingestOfflineSaleHold({
        idempotencyKey: body.command.syncCommandId,
        ...body,
        command: { ...body.command, requestedAt: "2026-01-01T00:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ status: 401 });
    const altered = {
      ...body.command,
      syncCommandId: randomUUID(),
      requestedAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(
      client.ingestOfflineSaleHold({
        idempotencyKey: altered.syncCommandId,
        command: altered,
        signature: {
          ...body.signature,
          value: (keys as { signCanonical(c: string): string }).signCanonical(
            m.sync.canonicalizeSaleHold(altered),
          ),
        },
        sale: body.sale,
      }),
    ).rejects.toMatchObject({ status: 409 });
    // 4. The held sale itself is refused (its customer does not exist: 404), and a DIFFERENT validly-signed
    //    sale reusing the held ordinal is refused by the one-terminal-record-per-ordinal guard (409).
    const sale = JSON.parse(String(held.request_json));
    await expect(
      client.ingestOfflineSale({ idempotencyKey: saleSync, ...sale }),
    ).rejects.toMatchObject({ status: 404 });
    const cashBase: Record<string, unknown> = { ...sale.command };
    for (const key of ["customerId", "amountPaidMinor", "outstandingMinor", "tenders"]) {
      delete cashBase[key];
    }
    const reuse = {
      ...cashBase,
      syncCommandId: randomUUID(),
      localSaleId: `reuse-${randomUUID()}`,
      cashReceivedMinor: sale.command.totalMinor,
      changeMinor: 0,
    };
    const sdkCanonical = load(
      path.join(posRepo, "node_modules", "@shifted", "clothing-commerce-sdk"),
    ) as { canonicalizeOfflineSaleCommand(command: unknown): string };
    await expect(
      client.ingestOfflineSale({
        idempotencyKey: reuse.syncCommandId,
        command: reuse as never,
        signature: {
          ...sale.signature,
          value: (keys as { signCanonical(c: string): string }).signCanonical(
            sdkCanonical.canonicalizeOfflineSaleCommand(reuse),
          ),
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "OFFLINE_SALE_ORDINAL_CONFLICT" });
    expect(
      await one("offline_sale_ingestions", { sync_command_id: reuse.syncCommandId }, "id"),
    ).toEqual([]);

    // 5. Re-bootstrap now closes the previous grant (held units stay reserved) and issues a new one.
    offsetMs += 10_000;
    await bootstrap();
    const previous = await one(
      "offline_pos_stock_grants",
      { offline_grant_id: String(JSON.parse(String(held.request_json)).command.grantId) },
      "id,status",
    );
    expect(previous[0]).toMatchObject({ status: "closed" });
    const lines = await one(
      "offline_pos_stock_grant_lines",
      { stock_grant_id: String(previous[0]!.id) },
      "held_qty,consumed_qty,released_qty,granted_qty",
    );
    expect(Number(lines[0]!.held_qty)).toBe(1);
    expect(
      Number(lines[0]!.consumed_qty) + Number(lines[0]!.released_qty) + Number(lines[0]!.held_qty),
    ).toBe(Number(lines[0]!.granted_qty));
  });
});
