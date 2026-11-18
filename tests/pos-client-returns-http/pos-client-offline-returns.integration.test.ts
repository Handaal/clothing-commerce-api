// Phase 5 — CROSS-REPO acceptance: the REAL POS client lane against the REAL API server.
//
// The server-side return contract is proven by tests/offline-pos-http-integration (R0–R8) with commands
// built inside this repo. This suite closes the remaining gap: it loads the POS repo's COMPILED main-process
// modules (`clothing-commerce-pos/dist-electron/main/offline/*`, which resolve the POS's own vendored SDK
// tarball) and drives them over HTTP against the real Next.js API + disposable PostgreSQL:
//
//   POS OfflineBootstrapService  → real device enrollment + offline bootstrap (POS-generated Ed25519 key)
//   POS OfflineSaleService       → a real returnable order, synced by the POS sync worker
//   POS OfflineReturnService     → real return grant (issueOfflineReturnGrant + getOrder), offline capture
//   POS OfflineSyncWorker        → real ingestOfflineReturn with the POS-persisted signed request
//
// Launched exclusively by `pnpm test:pos:offline:returns-client` (the isolated HTTP runner with
// `--dir tests/pos-client-returns-http`). Requires a sibling POS checkout built with `pnpm build:main`
// (override its location with POS_REPO_DIR).
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
  throw new Error(
    "POS-client offline-returns acceptance requires the isolated harness environment.",
  );

const TENANT = "2a000001-0000-4000-8000-000000000001";
const REGISTER = "2a000005-0000-4000-8000-000000000001";
const VARIANT = "2a000007-0000-4000-8000-000000000001";

const posRepo = path.resolve(
  process.env.POS_REPO_DIR ?? path.join(__dirname, "..", "..", "..", "clothing-commerce-pos"),
);
const posDist = path.join(posRepo, "dist-electron", "main", "offline");
if (!existsSync(path.join(posDist, "return-service.js")))
  throw new Error(
    `POS main-process build not found at ${posDist}. Run \`pnpm build:main\` in the POS repo first.`,
  );

// ---- Minimal typed views of the compiled POS modules (CommonJS, loaded natively, not via Vite) ----
interface PosDatabase {
  readonly connection: {
    prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  };
  close(): void;
}
interface PosReturnState {
  readonly pending: number;
  readonly recent: ReadonlyArray<{
    localReturnId: string;
    lifecycle: string;
    serverReturnId: string | null;
    refund: { amountMinor: number; currency: string; status: string } | null;
    reconciliationReason: string | null;
  }>;
}
interface PosGrantView {
  returnGrantId: string;
  orderId: string;
  lines: ReadonlyArray<{ orderLineId: string; grantedQuantity: number; remainingQuantity: number }>;
}
interface PosReturnService {
  prepareGrant(input: {
    tenantId: string;
    accessToken: string;
    orderId: string;
  }): Promise<PosGrantView>;
  recordReturn(input: {
    returnGrantId: string;
    lines: Array<{
      orderLineId: string;
      quantity: number;
      reason: string;
      disposition: "restock" | "non_restock";
    }>;
  }): { localReturnId: string; syncCommandId: string };
  getLocalReturns(): PosReturnState;
}
interface PosWorkItem {
  syncCommandId: string;
  localReturnId: string;
  tenantId: string;
  idempotencyKey: string;
  canonicalCommand: string;
  payloadHash: string;
  requestJson: string;
  credentialId: string;
  attempts: number;
  leaseId: string;
  leaseExpiresAt: string;
}
interface PosDelivery {
  deliverReturn(item: PosWorkItem): Promise<{
    syncStatus: string;
    ingestionId: string;
    returnId: string | null;
  }>;
}

const load = createRequire(__filename);
const pos = {
  database: load(path.join(posDist, "database.js")) as {
    LocalDatabase: new (file: string) => PosDatabase;
    localDatabasePath(userData: string): string;
  },
  deviceKey: load(path.join(posDist, "device-key.js")) as {
    DeviceKeyStore: new (
      userData: string,
      storage: unknown,
    ) => {
      initializeIfPresent(): Promise<void>;
    };
  },
  authority: load(path.join(posDist, "authority-store.js")) as {
    OfflineAuthorityStore: new (database: PosDatabase) => unknown;
  },
  bootstrap: load(path.join(posDist, "bootstrap.js")) as {
    OfflineBootstrapService: new (
      apiBaseUrl: string,
      authority: unknown,
      keys: unknown,
    ) => {
      bootstrap(input: {
        tenantId: string;
        registerId: string;
        displayName: string;
        accessToken: string;
      }): Promise<{ deviceId: string; grantId: string }>;
    };
  },
  sales: load(path.join(posDist, "offline-service.js")) as {
    OfflineSaleService: new (
      database: PosDatabase,
      keys: unknown,
    ) => {
      getReadiness(): { ready: boolean; reason?: string; message?: string };
      acceptCashSale(input: {
        lines: Array<{ variantId: string; quantity: number }>;
        cashReceivedMinor: number;
      }): { localSaleId: string; totalMinor: number };
    };
  },
  outbox: load(path.join(posDist, "outbox-store.js")) as {
    OutboxStore: new (database: PosDatabase) => unknown;
  },
  returnOutbox: load(path.join(posDist, "return-outbox-store.js")) as {
    ReturnOutboxStore: new (database: PosDatabase) => unknown;
  },
  returns: load(path.join(posDist, "return-service.js")) as {
    OfflineReturnService: new (
      database: PosDatabase,
      keys: unknown,
      issuer: unknown,
    ) => PosReturnService;
    SdkReturnGrantIssuer: new (apiBaseUrl: string) => unknown;
  },
  sync: load(path.join(posDist, "sync-worker.js")) as {
    SdkOfflineDeliveryClient: new (apiBaseUrl: string) => PosDelivery;
    OfflineSyncWorker: new (
      outbox: unknown,
      delivery: PosDelivery,
      options: { returnOutbox: unknown },
    ) => {
      requestRun(): Promise<void>;
      getStatus(): { blocked: number; lastError: string | null };
    };
  },
};

// Reversible stand-in for Electron safeStorage (sync + async), exactly the shape DeviceKeyStore needs.
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
const tenant = createCommerceClient({
  baseUrl,
  getToken: async () => clerkToken,
}).withTenant(TENANT);

async function onHand(locationId: string): Promise<number> {
  const { data, error } = await admin
    .from("inventory_balances")
    .select("on_hand_quantity")
    .eq("tenant_id", TENANT)
    .eq("variant_id", VARIANT)
    .eq("inventory_location_id", locationId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.on_hand_quantity) : 0;
}
async function storedRefund(returnId: string) {
  const { data, error } = await admin
    .from("refunds")
    .select("status,amount_minor,settled_at")
    .eq("tenant_id", TENANT)
    .eq("return_id", returnId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        status: String(data.status),
        amountMinor: Number(data.amount_minor),
        settledAt: data.settled_at == null ? null : String(data.settled_at),
      }
    : null;
}
async function countFor(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await admin
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT)
    .eq(column, value);
  if (error) throw error;
  return count ?? 0;
}

let userData: string;
let database: PosDatabase;
let sales: InstanceType<typeof pos.sales.OfflineSaleService>;
let returns: PosReturnService;
let delivery: PosDelivery;
let worker: InstanceType<typeof pos.sync.OfflineSyncWorker>;
let locationId: string;
let unitPrice: number;

async function posSale(quantity: number): Promise<string> {
  const accepted = sales.acceptCashSale({
    lines: [{ variantId: VARIANT, quantity }],
    cashReceivedMinor: 100_000_000,
  });
  await worker.requestRun();
  const row = database.connection
    .prepare("SELECT lifecycle, server_order_id FROM local_sale WHERE local_sale_id = ?")
    .get(accepted.localSaleId) as { lifecycle: string; server_order_id: string | null };
  expect(row.lifecycle).toBe("synced");
  expect(row.server_order_id).toBeTruthy();
  unitPrice = accepted.totalMinor / quantity;
  return row.server_order_id!;
}
function persistedItem(localReturnId: string): PosWorkItem {
  const row = database.connection
    .prepare(
      `SELECT o.sync_command_id, o.local_return_id, g.tenant_id, o.idempotency_key,
        o.canonical_command, o.payload_hash, o.request_json, o.credential_id, o.attempts
       FROM return_outbox o
       JOIN local_return r ON r.local_return_id = o.local_return_id
       JOIN offline_return_grant g ON g.return_grant_id = r.return_grant_id
       WHERE o.local_return_id = ?`,
    )
    .get(localReturnId) as Record<string, string | number>;
  return {
    syncCommandId: String(row.sync_command_id),
    localReturnId: String(row.local_return_id),
    tenantId: String(row.tenant_id),
    idempotencyKey: String(row.idempotency_key),
    canonicalCommand: String(row.canonical_command),
    payloadHash: String(row.payload_hash),
    requestJson: String(row.request_json),
    credentialId: String(row.credential_id),
    attempts: Number(row.attempts),
    leaseId: "replay",
    leaseExpiresAt: new Date().toISOString(),
  };
}
function localReturn(localReturnId: string) {
  return returns.getLocalReturns().recent.find((item) => item.localReturnId === localReturnId)!;
}

beforeAll(async () => {
  userData = mkdtempSync(path.join(os.tmpdir(), "pos-client-returns-"));
  database = new pos.database.LocalDatabase(pos.database.localDatabasePath(userData));
  const keys = new pos.deviceKey.DeviceKeyStore(userData, testStorage);
  const authority = new pos.authority.OfflineAuthorityStore(database);
  // REAL enrollment + offline bootstrap through the POS bootstrap service (POS-generated device key).
  await new pos.bootstrap.OfflineBootstrapService(baseUrl, authority, keys).bootstrap({
    tenantId: TENANT,
    registerId: REGISTER,
    displayName: "pos-client-returns",
    accessToken: clerkToken,
  });
  sales = new pos.sales.OfflineSaleService(database, keys);
  const readiness = sales.getReadiness();
  if (!readiness.ready)
    throw new Error(`POS not offline-ready: ${readiness.reason} ${readiness.message}`);
  locationId = (
    database.connection
      .prepare("SELECT inventory_location_id FROM offline_grant LIMIT 1")
      .get() as {
      inventory_location_id: string;
    }
  ).inventory_location_id;
  returns = new pos.returns.OfflineReturnService(
    database,
    keys,
    new pos.returns.SdkReturnGrantIssuer(baseUrl),
  );
  delivery = new pos.sync.SdkOfflineDeliveryClient(baseUrl);
  worker = new pos.sync.OfflineSyncWorker(new pos.outbox.OutboxStore(database), delivery, {
    returnOutbox: new pos.returnOutbox.ReturnOutboxStore(database),
  });
});

afterAll(() => {
  database?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

describe.sequential("POS client offline-returns lane over the real HTTP server", () => {
  let syncedServerReturnId: string;
  let syncedLocalReturnId: string;

  it("P1 — POS-fetched grant + POS-signed offline return syncs to a canonical Return with a PENDING refund; stock untouched", async () => {
    const orderId = await posSale(2);
    const grant = await returns.prepareGrant({
      tenantId: TENANT,
      accessToken: clerkToken,
      orderId,
    });
    expect(grant.orderId).toBe(orderId);
    expect(grant.lines).toHaveLength(1);
    expect(grant.lines[0]!.grantedQuantity).toBe(2);
    expect(grant.lines[0]!.remainingQuantity).toBe(2);

    const stockBefore = await onHand(locationId);
    const ingestionsBefore = await countFor("offline_return_ingestions", "order_id", orderId);
    // Captured "offline": durable + signed locally, no network involved in recordReturn.
    const accepted = returns.recordReturn({
      returnGrantId: grant.returnGrantId,
      lines: [
        {
          orderLineId: grant.lines[0]!.orderLineId,
          quantity: 1,
          reason: "too small",
          disposition: "restock",
        },
      ],
    });
    expect(localReturn(accepted.localReturnId).lifecycle).toBe("accepted_pending_sync");
    expect(localReturn(accepted.localReturnId).refund).toBeNull();

    await worker.requestRun();
    expect(worker.getStatus().blocked).toBe(0);
    const local = localReturn(accepted.localReturnId);
    expect(local.lifecycle).toBe("synced");
    expect(local.serverReturnId).toBeTruthy();
    expect(local.refund).toEqual({
      id: expect.any(String),
      amountMinor: unitPrice,
      currency: expect.any(String),
      status: "pending",
    });
    // Canonical DB: refund PENDING and unsettled, amount computed by the server; one ingestion; stock as-is.
    const refund = await storedRefund(local.serverReturnId!);
    expect(refund).toEqual({ status: "pending", amountMinor: unitPrice, settledAt: null });
    expect(await countFor("offline_return_ingestions", "order_id", orderId)).toBe(
      ingestionsBefore + 1,
    );
    expect(await onHand(locationId)).toBe(stockBefore);
    syncedServerReturnId = local.serverReturnId!;
    syncedLocalReturnId = accepted.localReturnId;
  });

  it("P2 — replaying the exact POS-persisted request is idempotent (same ingestion, same Return)", async () => {
    const item = persistedItem(syncedLocalReturnId);
    const before = await countFor("offline_return_ingestions", "tenant_id", TENANT);
    const replay = await delivery.deliverReturn(item);
    expect(replay.syncStatus).toBe("synced");
    expect(replay.returnId).toBe(syncedServerReturnId);
    expect(await countFor("offline_return_ingestions", "tenant_id", TENANT)).toBe(before);
  });

  it("P3 — eligibility drift (a concurrent connected return) → needs_reconciliation, refund withheld", async () => {
    const orderId = await posSale(1);
    const grant = await returns.prepareGrant({
      tenantId: TENANT,
      accessToken: clerkToken,
      orderId,
    });
    const orderLineId = grant.lines[0]!.orderLineId;
    // Elsewhere, while this till is "offline", the unit is returned through the connected path.
    await tenant.createReturn({
      orderId,
      idempotencyKey: `pos-client-concurrent-${randomUUID()}`,
      inventoryLocationId: null,
      refundMode: "pending",
      settlementReference: null,
      lines: [
        { orderLineId, quantity: 1, reason: "returned elsewhere", disposition: "non_restock" },
      ],
    });
    const refundsBefore = await countFor("refunds", "order_id", orderId);
    expect(refundsBefore).toBe(1); // the connected return's pending refund
    // The till still holds the frozen grant and captures the same unit offline.
    const accepted = returns.recordReturn({
      returnGrantId: grant.returnGrantId,
      lines: [{ orderLineId, quantity: 1, reason: "too big", disposition: "non_restock" }],
    });
    await worker.requestRun();
    const local = localReturn(accepted.localReturnId);
    expect(local.lifecycle).toBe("needs_reconciliation");
    expect(local.refund).toBeNull();
    expect(local.serverReturnId).toBeNull();
    expect(local.reconciliationReason).toBe("eligibility_drift_at_ingestion");
    expect(await countFor("offline_return_reconciliations", "order_id", orderId)).toBe(1);
    // The withheld offline return created no canonical Return and no refund.
    expect(await countFor("refunds", "order_id", orderId)).toBe(refundsBefore);
  });

  it("P4 — the synced offline refund is settled ONLY through the connected attestation path", async () => {
    expect((await storedRefund(syncedServerReturnId))!.settledAt).toBeNull();
    const settled = await tenant.settleRefund({
      returnId: syncedServerReturnId,
      idempotencyKey: `pos-client-settle-${randomUUID()}`,
      settlementReference: "Cash handed back after reconnect",
    });
    expect(settled.refund.status).toBe("succeeded");
    const refund = await storedRefund(syncedServerReturnId);
    expect(refund!.status).toBe("succeeded");
    expect(refund!.settledAt).not.toBeNull();
  });
});
