// Objective C — real MULTI-DEVICE offline stock-allocation, contention, reconciliation, and recovery over
// the running HTTP API against an isolated disposable Postgres. Two DISTINCT enrolled device identities
// (separate Ed25519 keys) bound to the SAME inventory location contend for offline authority; the test
// verifies the ACTUAL approved contract — one active offline device per inventory location
// (offline_pos_private.issue_grant per-location advisory xact lock → OL409) — not an assumed concurrency
// result. It also proves the denied device cannot craft an acceptable sale, cross-channel stock depletion
// reconciles instead of overselling, and the queued command replays exactly once.
//
// Launched by scripts/test-offline-pos-http-isolated.mjs --dir tests/offline-pos-multidevice (its own
// fresh isolated server + DB, so it never shares a database or location lock with the other HTTP suite).
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createCommerceClient, ApiHttpError } from "../../packages/sdk/src/index";
import {
  canonicalizeOfflineSaleCommand,
  OfflineBootstrapResponseSchema,
  type OfflineBootstrapResponse,
  type OfflineSaleCommand,
} from "../../src/contracts";

const baseUrl = process.env.POS_TEST_API_BASE_URL;
const clerkToken = process.env.POS_TEST_CLERK_TOKEN;
const supabaseUrl = process.env.POS_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.POS_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !clerkToken || !supabaseUrl || !serviceRoleKey)
  throw new Error("Multi-device acceptance requires the isolated harness environment.");

const TENANT = "2a000001-0000-4000-8000-000000000001";
const REGISTER_A = "2a000005-0000-4000-8000-000000000001"; // location L1
const REGISTER_B = "2a000005-0000-4000-8000-000000000002"; // same location L1 (seed shares it)
const VARIANT = "2a000007-0000-4000-8000-000000000001";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const tenant = createCommerceClient({
  baseUrl: baseUrl!,
  getToken: async () => clerkToken!,
}).withTenant(TENANT);

async function httpStatusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiHttpError) return error.status;
    throw error;
  }
}
async function orderCount(): Promise<number> {
  const { count, error } = await admin
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT);
  if (error) throw error;
  return count ?? 0;
}
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

interface Device {
  deviceId: string;
  credentialId: string;
  registerId: string;
  keys: { publicKey: KeyObject; privateKey: KeyObject };
}
async function enroll(registerId: string, label: string): Promise<Device> {
  const keys = generateKeyPairSync("ed25519");
  const enrolled = await tenant.enrollPosDevice({
    idempotencyKey: `md-enroll-${label}-${randomUUID()}`,
    registerId,
    installationId: `md-${label}`,
    displayName: `md-${label}`,
    publicKey: {
      algorithm: "Ed25519",
      encoding: "spki_der_base64",
      value: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    },
    clientVersion: "0.5.0",
  });
  return { deviceId: enrolled.deviceId, credentialId: enrolled.credentialId, registerId, keys };
}

// Build a signed offline sale command as a specific device would durably persist it locally.
function buildSignedSale(
  device: Device,
  grant: OfflineBootstrapResponse,
  overrides: Partial<OfflineSaleCommand> = {},
  signingKey: KeyObject = device.keys.privateKey,
  credentialId: string = device.credentialId,
  quantity: number = 1,
) {
  const variant = grant.catalog.flatMap((p) => p.variants).find((v) => v.variantId === VARIANT)!;
  const total = variant.authorizedUnitPriceMinor * quantity;
  const id = randomUUID();
  const command: OfflineSaleCommand = {
    schemaVersion: 1,
    localSaleId: `md-${id}`,
    syncCommandId: id,
    grantId: grant.grantId,
    deviceId: device.deviceId,
    registerId: device.registerId,
    acceptedAt: new Date().toISOString(),
    currency: grant.currency,
    lines: [
      {
        variantId: VARIANT,
        quantity,
        grantedUnitPriceMinor: variant.authorizedUnitPriceMinor,
        priceId: variant.priceId,
      },
    ],
    totalMinor: total,
    cashReceivedMinor: total,
    changeMinor: 0,
    offlineSaleOrdinal: 1,
    cumulativeExposureMinor: total,
    ...overrides,
  };
  return {
    command,
    signature: {
      algorithm: "Ed25519" as const,
      credentialId,
      value: sign(null, Buffer.from(canonicalizeOfflineSaleCommand(command)), signingKey).toString(
        "base64",
      ),
    },
  };
}
function ingest(payload: ReturnType<typeof buildSignedSale>) {
  return tenant.ingestOfflineSale({ idempotencyKey: payload.command.syncCommandId, ...payload });
}

let deviceA: Device;
let deviceB: Device;

beforeAll(async () => {
  deviceA = await enroll(REGISTER_A, "a");
  deviceB = await enroll(REGISTER_B, "b");
});

describe.sequential("Objective C — multi-device offline authority on one location", () => {
  let winner: Device;
  let loser: Device;
  let grant: OfflineBootstrapResponse;

  it("1 — concurrent same-location bootstrap: exactly one grant, one 409 lock denial", async () => {
    // Fire both devices' bootstraps concurrently so the per-location advisory xact lock is genuinely
    // contended (not a sequential check). The contract allows exactly one active device per location.
    const results = await Promise.allSettled([
      tenant.createOfflineBootstrap({
        idempotencyKey: `md-grant-a-${randomUUID()}`,
        deviceId: deviceA.deviceId,
        registerId: REGISTER_A,
      }),
      tenant.createOfflineBootstrap({
        idempotencyKey: `md-grant-b-${randomUUID()}`,
        deviceId: deviceB.deviceId,
        registerId: REGISTER_B,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1); // exactly one grant issued
    expect(rejected).toHaveLength(1); // the other is refused
    const denial = (rejected[0] as PromiseRejectedResult).reason;
    expect(denial).toBeInstanceOf(ApiHttpError);
    expect((denial as ApiHttpError).status).toBe(409); // OL409 location lease conflict

    grant = OfflineBootstrapResponseSchema.parse(
      (fulfilled[0] as PromiseFulfilledResult<OfflineBootstrapResponse>).value,
    );
    const winnerIsA = grant.deviceId === deviceA.deviceId;
    winner = winnerIsA ? deviceA : deviceB;
    loser = winnerIsA ? deviceB : deviceA;
    expect(grant.inventoryLocationId).toBeTruthy();
  });

  it("2 — a sequential retry by the loser is still refused while the winner holds the lease", async () => {
    // Deterministic re-assertion of the invariant (no race): the loser cannot acquire authority.
    expect(
      await httpStatusOf(
        tenant.createOfflineBootstrap({
          idempotencyKey: `md-grant-loser-${randomUUID()}`,
          deviceId: loser.deviceId,
          registerId: loser.registerId,
        }),
      ),
    ).toBe(409);
  });

  it("3 — the denied device cannot craft an acceptable offline sale (no bypass)", async () => {
    const before = await orderCount();
    // (a) Loser signs with its own identity but references the winner's grant → grant binding mismatch
    //     (command.deviceId != grant.device_id).
    const craftedOwnDevice = buildSignedSale(loser, grant, { deviceId: loser.deviceId });
    expect(await httpStatusOf(ingest(craftedOwnDevice))).toBeGreaterThanOrEqual(400);

    // (b) Loser impersonates the winner's deviceId but signs with the loser's key/credential → the
    //     credential does not belong to that device → signature rejected.
    const impersonation = buildSignedSale(
      loser,
      grant,
      { deviceId: winner.deviceId },
      loser.keys.privateKey,
      loser.credentialId,
    );
    expect(await httpStatusOf(ingest(impersonation))).toBeGreaterThanOrEqual(400);

    // (c) A fabricated grant id → grant not found.
    const fabricated = buildSignedSale(loser, grant, {
      grantId: "2a000099-0000-4000-8000-0000000000ff",
    });
    expect(await httpStatusOf(ingest(fabricated))).toBeGreaterThanOrEqual(400);

    expect(await orderCount()).toBe(before); // no crafted command produced any order
  });

  it("4 — authorized offline sale + cross-channel stock depletion reconciles (no oversell)", async () => {
    const locationId = grant.inventoryLocationId;
    // An authorized connected operation consumes the location's stock (cross-channel) BEFORE the offline
    // sale syncs. Deplete, then size the offline sale to exceed whatever remains so ingestion is forced to
    // reconcile rather than oversell. The winner durably holds this stable signed command (as the POS
    // SQLite outbox would); its quantity/total are fixed at acceptance.
    const { error } = await admin.rpc("phase_2i_test_deplete_stock");
    if (error) throw error;
    const remaining = await onHand(locationId);
    const queued = buildSignedSale(
      winner,
      grant,
      {},
      winner.keys.privateKey,
      winner.credentialId,
      remaining + 1, // one more than is physically available → cannot be fulfilled
    );

    const before = await orderCount();
    const result = await ingest(queued);
    // Server is authoritative: the sale is RECORDED but not fulfilled — reconciled as insufficient stock.
    expect(result.syncStatus).toBe("needs_reconciliation");
    expect(result.fulfillment).toBeNull();
    expect(result.reconciliation?.reason).toBe("insufficient_stock_at_ingestion");
    expect(await orderCount()).toBe(before + 1); // order + payment exist (money attested), no fulfillment
    expect(await onHand(locationId)).toBe(remaining); // stock untouched: no oversell, no negative inventory

    // Exactly-once recovery: replay the identical signed command (lost response / restart) → idempotent.
    const replay = await ingest(queued);
    expect(replay.ingestionId).toBe(result.ingestionId);
    expect(replay.syncStatus).toBe("needs_reconciliation");
    expect(await orderCount()).toBe(before + 1); // still exactly one order; no duplicate

    // A changed-intent command reusing the same idempotency key is rejected (not silently re-accepted).
    // Validly re-signed over the altered command so it is the idempotency fingerprint — not the signature —
    // that rejects it (ID409 → 409).
    const conflict = buildSignedSale(winner, grant, {
      syncCommandId: queued.command.syncCommandId,
      localSaleId: queued.command.localSaleId,
      totalMinor: queued.command.totalMinor + 1,
    });
    expect(await httpStatusOf(ingest(conflict))).toBe(409);
  });
});
