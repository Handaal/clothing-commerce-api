// ADR-042 §9 — CROSS-REPO acceptance that the RETIRED generic offline-intent lane stays retired, driven
// through the REAL POS main-process modules over the real HTTP server.
//
// Owner scope (2026-11-14): inventory receive/adjust/count, suppliers, staff, settings, device-revoke and
// review requests are NOT offline operations any more (inventory stock allocation/grants are a separate,
// authorized channel-stock feature; new customers have their own typed command). This suite loads the POS
// repo's COMPILED main-process modules (`clothing-commerce-pos/dist-electron/main/offline/*`, resolving the
// POS's own vendored SDK tarball) and proves, against the real Next.js API + a disposable PostgreSQL:
//
//   R0  the real bootstrap offers the till NO intent kinds; every retired kind is refused locally before
//       anything is signed or stored, and nothing reaches the server;
//   R1  a command persisted by a pre-retirement till build (the grant row is immutable, so no opt-in can be
//       faked locally) is recorded by the server and disposed `rejected / OIX_KIND_OUT_OF_SCOPE` (no stock movement), and the till stores
//       that final disposition (no retry, no action, nothing waits for a person);
//   R2  exact replay of the persisted request returns the original ingestion, no new row, no effect;
//   R3  a legacy device-revoke request is rejected out of scope and does NOT revoke the device;
//   R4  a legacy `customers.create` intent is rejected (the typed command replaces it) and creates no
//       customer.
//
// Launched exclusively by `pnpm test:pos:offline:intents-client`. Requires a sibling POS checkout built
// with `pnpm build:main` (override its location with POS_REPO_DIR).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.POS_TEST_API_BASE_URL;
const clerkToken = process.env.POS_TEST_CLERK_TOKEN;
const supabaseUrl = process.env.POS_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.POS_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !clerkToken || !supabaseUrl || !serviceRoleKey)
  throw new Error(
    "POS-client offline-intents acceptance requires the isolated harness environment.",
  );

const TENANT = "2a000001-0000-4000-8000-000000000001";
const REGISTER = "2a000005-0000-4000-8000-000000000001";
const VARIANT = "2a000007-0000-4000-8000-000000000001";

const posRepo = path.resolve(
  process.env.POS_REPO_DIR ?? path.join(__dirname, "..", "..", "..", "clothing-commerce-pos"),
);
const posDist = path.join(posRepo, "dist-electron", "main", "offline");
if (!existsSync(path.join(posDist, "intent-service.js")))
  throw new Error(
    `POS main-process build with the intent lane not found at ${posDist}. Run \`pnpm build:main\` in the POS repo first.`,
  );

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
interface PosIntentService {
  getEnabledOperations(): string[];
  recordIntent(input: {
    operation: string;
    subjectId: string | null;
    baseVersion: string | null;
    dependsOnSyncCommandId: string | null;
    payload: Record<string, unknown>;
  }): { localIntentId: string; syncCommandId: string };
  getLocalIntents(): {
    pending: number;
    enabledOperations: string[];
    recent: ReadonlyArray<{
      localIntentId: string;
      lifecycle: string;
      outboxState: string;
      disposition: string | null;
      dispositionCode: string | null;
    }>;
  };
}
interface PosIntentWorkItem {
  syncCommandId: string;
  localIntentId: string;
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
  deliverIntent(item: PosIntentWorkItem): Promise<{ ingestionId: string; syncStatus: string }>;
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
    ) => { signCanonical(c: string): string };
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
      }): Promise<unknown>;
    };
  },
  sales: load(path.join(posDist, "offline-service.js")) as {
    OfflineSaleService: new (
      database: PosDatabase,
      keys: unknown,
    ) => { getReadiness(): { ready: boolean; reason?: string; message?: string } };
  },
  outbox: load(path.join(posDist, "outbox-store.js")) as {
    OutboxStore: new (database: PosDatabase) => unknown;
  },
  intentOutbox: load(path.join(posDist, "intent-outbox-store.js")) as {
    IntentOutboxStore: new (database: PosDatabase) => unknown;
  },
  intents: load(path.join(posDist, "intent-service.js")) as {
    OfflineIntentService: new (
      database: PosDatabase,
      keys: unknown,
      readiness: () => unknown,
    ) => PosIntentService;
  },
  review: load(path.join(posDist, "review-service.js")) as {
    OfflineReviewService: new (
      database: PosDatabase,
      intents: PosIntentService,
    ) => {
      list(query?: { lane?: string; status?: string }): Array<{
        syncCommandId: string;
        status: string;
        serverIngestionId: string | null;
        allowedActions: string[];
        evidence: ReadonlyArray<{ key: string; value: string }>;
      }>;
    };
  },
  sync: load(path.join(posDist, "sync-worker.js")) as {
    SdkOfflineDeliveryClient: new (apiBaseUrl: string) => PosDelivery;
    OfflineSyncWorker: new (
      outbox: unknown,
      delivery: PosDelivery,
      options: { intentOutbox: unknown },
    ) => {
      requestRun(): Promise<void>;
      getStatus(): { blocked: number; lastError: string | null };
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
async function serverIntent(syncCommandId: string) {
  const { data, error } = await admin
    .from("offline_operation_intents")
    .select("id,operation,adjudication_status,depends_on_sync_command_id,payload,device_id")
    .eq("tenant_id", TENANT)
    .eq("sync_command_id", syncCommandId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
async function customerCount(): Promise<number> {
  const { count, error } = await admin
    .from("customers")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT);
  if (error) throw error;
  return count ?? 0;
}
function localRows(table: "local_intent" | "intent_outbox"): number {
  return Number(
    (database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  );
}
const RETIRED = [
  "inventory.receive",
  "inventory.adjust",
  "inventory.count",
  "suppliers.purchase_draft",
  "suppliers.goods_receipt",
  "suppliers.payment_intent",
  "staff.attendance_correction_request",
  "staff.role_change_request",
  "settings.change_request",
  "settings.device_revoke_request",
  "customers.create",
  "customers.update",
  "review.resolution_request",
];
async function intentCount(): Promise<number> {
  const { count, error } = await admin
    .from("offline_operation_intents")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT);
  if (error) throw error;
  return count ?? 0;
}

let userData: string;
let database: PosDatabase;
let intents: PosIntentService;
let review: InstanceType<typeof pos.review.OfflineReviewService>;
let delivery: PosDelivery;
let worker: InstanceType<typeof pos.sync.OfflineSyncWorker>;
let deviceKeys: { signCanonical(canonical: string): string };
// The POS's own vendored SDK canonicalizer (same module the till signs with).
const posSdk = createRequire(path.join(posRepo, "package.json"))(
  "@shifted/clothing-commerce-sdk",
) as {
  canonicalizeOfflineIntentCommand(command: unknown): string;
};

/**
 * Persist an intent exactly as a PRE-RETIREMENT POS build did (offline_grant is immutable, so a legacy opt-in
 * cannot be faked): a command canonicalized by the POS's SDK, signed with the real device key, written to the
 * real local_intent + intent_outbox tables with the same columns `OfflineIntentService.recordIntent` used.
 * The real sync worker then delivers it.
 */
function seedLegacyIntent(input: {
  operation: string;
  subjectId: string | null;
  payload: Record<string, unknown>;
}): { localIntentId: string; syncCommandId: string } {
  const authority = database.connection
    .prepare(
      `SELECT g.grant_id, d.device_id, d.credential_id, g.register_id, g.operator_membership_id
       FROM device_state d JOIN catalog_snapshot c ON c.state = 'active'
       JOIN offline_grant g ON g.grant_id = c.grant_id WHERE d.singleton_id = 1`,
    )
    .get() as Record<string, string>;
  const localIntentId = randomUUID();
  const syncCommandId = randomUUID();
  const acceptedAt = new Date().toISOString();
  const command = {
    schemaVersion: 1,
    localIntentId,
    syncCommandId,
    grantId: authority.grant_id,
    deviceId: authority.device_id,
    registerId: authority.register_id,
    operatorMembershipId: authority.operator_membership_id,
    subjectId: input.subjectId,
    baseVersion: null,
    dependsOnSyncCommandId: null,
    acceptedAt,
    operation: input.operation,
    payload: input.payload,
  };
  const canonical = posSdk.canonicalizeOfflineIntentCommand(command);
  const signature = deviceKeys.signCanonical(canonical);
  const request = {
    command,
    signature: { algorithm: "Ed25519", credentialId: authority.credential_id, value: signature },
  };
  database.connection
    .prepare(
      `INSERT INTO local_intent(local_intent_id, grant_id, operator_membership_id, operation, subject_id,
        base_version, depends_on_sync_command_id, payload_json, accepted_at, lifecycle, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'accepted_pending_sync', ?)`,
    )
    .run(
      localIntentId,
      authority.grant_id,
      authority.operator_membership_id,
      input.operation,
      input.subjectId,
      JSON.stringify(input.payload),
      acceptedAt,
      acceptedAt,
    );
  database.connection
    .prepare(
      `INSERT INTO intent_outbox(sync_command_id, local_intent_id, idempotency_key, canonical_command,
        payload_hash, signature_base64, credential_id, request_json, state, next_attempt_at, created_at,
        updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      syncCommandId,
      localIntentId,
      syncCommandId,
      canonical,
      createHash("sha256").update(canonical, "utf8").digest("hex"),
      signature,
      authority.credential_id,
      JSON.stringify(request),
      acceptedAt,
      acceptedAt,
      acceptedAt,
    );
  return { localIntentId, syncCommandId };
}
let locationId: string;

function persistedItem(localIntentId: string): PosIntentWorkItem {
  const row = database.connection
    .prepare(
      `SELECT o.sync_command_id, o.local_intent_id, g.tenant_id, o.idempotency_key,
        o.canonical_command, o.payload_hash, o.request_json, o.credential_id, o.attempts
       FROM intent_outbox o
       JOIN local_intent i ON i.local_intent_id = o.local_intent_id
       JOIN offline_grant g ON g.grant_id = i.grant_id
       WHERE o.local_intent_id = ?`,
    )
    .get(localIntentId) as Record<string, string | number>;
  return {
    syncCommandId: String(row.sync_command_id),
    localIntentId: String(row.local_intent_id),
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

beforeAll(async () => {
  userData = mkdtempSync(path.join(os.tmpdir(), "pos-client-intents-"));
  database = new pos.database.LocalDatabase(pos.database.localDatabasePath(userData));
  const keys = new pos.deviceKey.DeviceKeyStore(userData, testStorage);
  deviceKeys = keys;
  const authority = new pos.authority.OfflineAuthorityStore(database);
  await new pos.bootstrap.OfflineBootstrapService(baseUrl, authority, keys).bootstrap({
    tenantId: TENANT,
    registerId: REGISTER,
    displayName: "pos-client-intents",
    accessToken: clerkToken,
  });
  const sales = new pos.sales.OfflineSaleService(database, keys);
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
  intents = new pos.intents.OfflineIntentService(database, keys, () => sales.getReadiness());
  review = new pos.review.OfflineReviewService(database, intents);
  delivery = new pos.sync.SdkOfflineDeliveryClient(baseUrl);
  worker = new pos.sync.OfflineSyncWorker(new pos.outbox.OutboxStore(database), delivery, {
    intentOutbox: new pos.intentOutbox.IntentOutboxStore(database),
  });
});

afterAll(() => {
  database?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

describe.sequential("ADR-042 §9: retired offline-intent kinds over the real HTTP server", () => {
  let receiveLocalId: string;
  let receiveSyncId: string;

  it("R0 — the real bootstrap offers no intent kinds; every retired kind is refused locally with no record and no server row", async () => {
    expect(intents.getEnabledOperations()).toEqual([]);
    const serverBefore = await intentCount();
    for (const operation of RETIRED) {
      expect(() =>
        intents.recordIntent({
          operation,
          subjectId: null,
          baseVersion: null,
          dependsOnSyncCommandId: null,
          payload: {},
        }),
      ).toThrow(/not enabled/);
    }
    expect(localRows("local_intent")).toBe(0);
    expect(localRows("intent_outbox")).toBe(0);
    // The stored grant (and its empty opt-in list) cannot be edited on the till to re-enable a kind.
    expect(() =>
      database.connection
        .prepare(
          "UPDATE offline_grant SET payload_json = json_set(payload_json, '$.policy.intentOperations', json('[\"inventory.receive\"]'))",
        )
        .run(),
    ).toThrow(/immutable/);
    expect(intents.getEnabledOperations()).toEqual([]);
    await worker.requestRun();
    expect(await intentCount()).toBe(serverBefore);
  });

  it("R1 — a command persisted by a pre-retirement till build can only yield a server-recorded REJECTED / OIX_KIND_OUT_OF_SCOPE: no stock posted, final disposition stored on the till", async () => {
    // The current till offers nothing (R0); only a command persisted by a pre-retirement build can reach sync.
    const stockBefore = await onHand(locationId);
    const accepted = seedLegacyIntent({
      operation: "inventory.receive",
      subjectId: VARIANT,
      payload: { variantId: VARIANT, quantity: 6, supplierDocumentRef: "DN-LEGACY-1", note: null },
    });
    receiveLocalId = accepted.localIntentId;
    receiveSyncId = accepted.syncCommandId;
    await worker.requestRun();
    expect(worker.getStatus().blocked).toBe(0);
    const row = await serverIntent(receiveSyncId);
    expect(row).toMatchObject({ operation: "inventory.receive", adjudication_status: "rejected" });
    expect(await onHand(locationId)).toBe(stockBefore);
    const local = intents
      .getLocalIntents()
      .recent.find((item) => item.localIntentId === receiveLocalId)!;
    expect(local).toMatchObject({
      lifecycle: "received",
      outboxState: "delivered",
      disposition: "rejected",
      dispositionCode: "OIX_KIND_OUT_OF_SCOPE",
    });
    const item = review
      .list({ lane: "intent" })
      .find((entry) => entry.syncCommandId === receiveSyncId)!;
    expect(item.status).toBe("rejected");
    expect(item.serverIngestionId).toBe(row!.id);
    // A final server decision: nothing to retry, override or send to a person.
    expect(item.allowedActions).toEqual([]);
  });

  it("R2 — the exact POS-persisted request replays to the same ingestion: no new row, no stock effect", async () => {
    const before = await intentCount();
    const stockBefore = await onHand(locationId);
    const original = await serverIntent(receiveSyncId);
    const replay = await delivery.deliverIntent(persistedItem(receiveLocalId));
    expect(replay.ingestionId).toBe(original!.id);
    expect(await intentCount()).toBe(before);
    expect(await onHand(locationId)).toBe(stockBefore);
  });

  it("R3 — a legacy device-revoke request is rejected out of scope and does not revoke the device", async () => {
    const revoke = seedLegacyIntent({
      operation: "settings.device_revoke_request",
      subjectId: null,
      // The dangerous legacy shape: the till asking to revoke ITSELF (formerly applied automatically).
      payload: {
        targetDeviceId: (
          database.connection
            .prepare("SELECT device_id FROM device_state WHERE singleton_id = 1")
            .get() as {
            device_id: string;
          }
        ).device_id,
        reason: "legacy",
      },
    });
    await worker.requestRun();
    expect(worker.getStatus().blocked).toBe(0);
    expect(await serverIntent(revoke.syncCommandId)).toMatchObject({
      operation: "settings.device_revoke_request",
      adjudication_status: "rejected",
    });
  });

  it("R4 — a legacy customers.create intent is rejected (typed command replaces it) and creates no customer; R3 did not revoke the device", async () => {
    const customersBefore = await customerCount();
    const legacy = seedLegacyIntent({
      operation: "customers.create",
      subjectId: null,
      payload: {
        localCustomerId: randomUUID(),
        displayName: "Legacy Intent",
        phone: "+201000000999",
      },
    });
    await worker.requestRun();
    // Delivered (not 401): the R3 request did not revoke this device's credential.
    expect(worker.getStatus().blocked).toBe(0);
    const row = await serverIntent(legacy.syncCommandId);
    expect(row).toMatchObject({ operation: "customers.create", adjudication_status: "rejected" });
    expect(await customerCount()).toBe(customersBefore);
    const local = intents.getLocalIntents().recent;
    expect(local.length).toBe(3);
    expect(local.every((entry) => entry.disposition === "rejected")).toBe(true);
    expect(local.every((entry) => entry.dispositionCode === "OIX_KIND_OUT_OF_SCOPE")).toBe(true);
  });
});
