import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { AuthorizationService } from "../../src/authorization/authorization-service";
import { AuthorizationError } from "../../src/authorization/errors";
import { createSupabaseAuthorizationRepository } from "../../src/authorization/supabase-authorization-repository";
import type { VerifiedExternalIdentity } from "../../src/authorization/model";
import type { ExternalIdentityVerifier } from "../../src/authentication/external-identity";
import {
  AllocateInventoryChannelsRequestSchema,
  AllocateInventoryChannelsResponseSchema,
  InitializeInventoryChannelsRequestSchema,
  InitializeInventoryChannelsResponseSchema,
  InventoryChannelStateResponseSchema,
  ReceiveInventoryRequestSchema,
  ReceiveInventoryResponseSchema,
} from "../../src/contracts";
import {
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../src/http/management-route";
import { InventoryChannelService } from "../../src/inventory/channel-service";
import { InventoryService } from "../../src/inventory/inventory-service";
import { createSupabaseInventoryChannelRepository } from "../../src/inventory/supabase-inventory-channel-repository";
import { createSupabaseInventoryRepository } from "../../src/inventory/supabase-inventory-repository";

// ADR-042 admin split API against the real database (disposable rt-<hex> stack, real PostgREST + RPCs).
const url = process.env.MGMT_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("MGMT_TEST_SUPABASE_URL and MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY are required.");
}
const config = { url, serviceRoleKey };

const TG = "f2900001-0000-4000-8000-000000000001";
const LGB = "f2900005-0000-4000-8000-0000000000e2";
const VG1 = "f2900008-0000-4000-8000-0000000000a1"; // seeded 12 at LGB by phase_3a_inventory_channels.setup.sql
const UNKNOWN_VARIANT = "f2900008-0000-4000-8000-0000000000ff";

class FakeVerifier implements ExternalIdentityVerifier {
  async verifyRequest(request: Request): Promise<VerifiedExternalIdentity> {
    const match = request.headers.get("Authorization")?.match(/^Bearer subject:(.+)$/);
    if (!match) throw new AuthorizationError("UNAUTHENTICATED");
    return { provider: "clerk", subject: match[1]! };
  }
}

let contextResolver: AuthorizationContextResolver;
let channels: InventoryChannelService;
let inventory: InventoryService;

beforeAll(() => {
  const authRepository = createSupabaseAuthorizationRepository(config);
  contextResolver = new AuthorizationContextResolver(new FakeVerifier(), authRepository);
  const authorizationService = new AuthorizationService(authRepository);
  channels = new InventoryChannelService(
    authorizationService,
    createSupabaseInventoryChannelRepository(config),
  );
  inventory = new InventoryService(authorizationService, createSupabaseInventoryRepository(config));
});

function headers(subject: string, idempotencyKey?: string): Headers {
  const result = new Headers({
    Authorization: `Bearer subject:${subject}`,
    "X-Tenant-Id": TG,
    "Content-Type": "application/json",
  });
  if (idempotencyKey !== undefined) result.set("Idempotency-Key", idempotencyKey);
  return result;
}

function getState(subject: string) {
  const request = new Request(`http://test/api/v1/inventory/channels?inventoryLocationId=${LGB}`, {
    headers: headers(subject),
  });
  return runTenantManagementRoute({
    request,
    contextResolver,
    responseSchema: InventoryChannelStateResponseSchema,
    handler: (context) => channels.getChannelState(context, { inventoryLocationId: LGB }),
  });
}

function initialize(subject: string, idempotencyKey?: string) {
  return runTenantManagementWriteRoute({
    request: new Request("http://test/api/v1/inventory/channels/initialize", {
      method: "POST",
      headers: headers(subject, idempotencyKey),
      body: JSON.stringify({ inventoryLocationId: LGB }),
    }),
    contextResolver,
    requestSchema: InitializeInventoryChannelsRequestSchema,
    responseSchema: InitializeInventoryChannelsResponseSchema,
    handler: ({ context, body }) =>
      channels.initializeChannels(context, { inventoryLocationId: body.inventoryLocationId }),
  });
}

function allocate(subject: string, idempotencyKey: string, payload: unknown) {
  return runTenantManagementWriteRoute({
    request: new Request("http://test/api/v1/inventory/channels/allocations", {
      method: "POST",
      headers: headers(subject, idempotencyKey),
      body: JSON.stringify(payload),
    }),
    contextResolver,
    requestSchema: AllocateInventoryChannelsRequestSchema,
    responseSchema: AllocateInventoryChannelsResponseSchema,
    handler: ({ context, body, idempotencyKey: key }) =>
      channels.allocateChannels(context, {
        inventoryLocationId: body.inventoryLocationId,
        reason: body.reason,
        idempotencyKey: key,
        lines: body.lines,
      }),
  });
}

function receiveAtLgb(quantity: number, idempotencyKey: string) {
  return runTenantManagementWriteRoute({
    request: new Request("http://test/api/v1/inventory/receipts", {
      method: "POST",
      headers: headers("clerk-g-writer", idempotencyKey),
      body: JSON.stringify({ variantId: VG1, inventoryLocationId: LGB, quantity }),
    }),
    contextResolver,
    requestSchema: ReceiveInventoryRequestSchema,
    responseSchema: ReceiveInventoryResponseSchema,
    handler: ({ context, body, idempotencyKey: key }) =>
      inventory
        .receiveInventory(context, {
          variantId: body.variantId,
          inventoryLocationId: body.inventoryLocationId,
          quantity: body.quantity,
          idempotencyKey: key,
        })
        .then((r) => ({
          operationId: r.operationId,
          variantId: r.variantId,
          inventoryLocationId: r.inventoryLocationId,
          observedOnHand: r.observedOnHand,
          observedVersion: r.observedVersion,
        })),
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

function vg1(items: Array<{ variantId: string }>) {
  return items.find((item) => item.variantId === VG1) as Record<string, unknown> | undefined;
}

const split = (website: number, pos: number, extra: Record<string, unknown> = {}) => ({
  inventoryLocationId: LGB,
  reason: "Initial Website/POS split",
  lines: [{ variantId: VG1, websiteQuantity: website, posQuantity: pos, ...extra }],
});

/** The versions the split screen would send back right now (ADR-042 §3.5). */
async function currentVersions(): Promise<{
  expectedBalanceVersion: number;
  expectedAllocationVersion: number;
}> {
  const state = (await (await getState("clerk-g-reader")).json()) as {
    items: Array<{ variantId: string }>;
  };
  const row = vg1(state.items)!;
  return {
    expectedBalanceVersion: Number(row.balanceVersion),
    expectedAllocationVersion: Number(row.allocationVersion),
  };
}

describe("ADR-042 channel stock admin API (real database)", () => {
  it("reports a legacy location with no buckets", async () => {
    const response = await getState("clerk-g-reader");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inventoryLocationId: LGB, mode: "legacy", items: [] });
  });

  it("refuses initialize without inventory.adjust and without an Idempotency-Key", async () => {
    const denied = await initialize("clerk-g-reader", "init-denied");
    expect(denied.status).toBe(403);
    const noKey = await initialize("clerk-g-writer");
    expect(noKey.status).toBe(400);
  });

  it("refuses a split while the location is still legacy", async () => {
    const response = await allocate(
      "clerk-g-writer",
      "split-too-early",
      split(1, 1, { expectedBalanceVersion: 0, expectedAllocationVersion: 0 }),
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("CHANNELS_NOT_INITIALIZED");
  });

  it("initializes once with all stock unallocated, and a repeat is a no-op", async () => {
    const first = await initialize("clerk-g-writer", "init-1");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ mode: "shadow", initialized: true });
    const again = await initialize("clerk-g-writer", "init-2");
    expect(await again.json()).toMatchObject({
      mode: "shadow",
      initialized: false,
      allocationRunId: null,
    });

    const state = (await (await getState("clerk-g-reader")).json()) as {
      mode: string;
      items: Array<{ variantId: string }>;
    };
    expect(state.mode).toBe("shadow");
    expect(vg1(state.items)).toMatchObject({
      canonicalOnHand: 12,
      unallocatedOnHand: 12,
      websiteOnHand: 0,
      posOnHand: 0,
      mismatch: 0,
      explicitlyAllocated: false,
    });
  });

  it("applies a split guarded by the balance version, and replays it exactly", async () => {
    const loaded = await currentVersions();
    expect(loaded).toEqual({ expectedBalanceVersion: 1, expectedAllocationVersion: 0 });
    const response = await allocate("clerk-g-writer", "split-1", split(5, 6, loaded));
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      allocationRunId: string;
      items: Array<{ variantId: string }>;
    };
    expect(result.items).toHaveLength(1);
    expect(vg1(result.items)).toMatchObject({
      websiteOnHand: 5,
      posOnHand: 6,
      unallocatedOnHand: 1,
      mismatch: 0,
      explicitlyAllocated: true,
    });

    // Exact replay returns the original run even though the allocation version has moved since.
    const replay = await allocate("clerk-g-writer", "split-1", split(5, 6, loaded));
    expect(((await replay.json()) as { allocationRunId: string }).allocationRunId).toBe(
      result.allocationRunId,
    );

    const conflict = await allocate("clerk-g-writer", "split-1", split(4, 6, loaded));
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("IDEMPOTENCY_CONFLICT");
    expect(await currentVersions()).toEqual({
      expectedBalanceVersion: 1,
      expectedAllocationVersion: 1,
    });

    // A second admin who loaded the SAME numbers before split-1 saves 4/7: refused with the current
    // values, nothing overwritten (Finding C — no last-writer-wins).
    const stale = await allocate("clerk-g-writer", "split-1-second-admin", split(4, 7, loaded));
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      error: { code: string; details?: Array<{ path: unknown[]; value?: number }> };
    };
    expect(body.error.code).toBe("CONCURRENT_MODIFICATION");
    const detail = (field: string) =>
      body.error.details?.find((d) => d.path[1] === VG1 && d.path[2] === field)?.value;
    expect(detail("allocationVersion")).toBe(1);
    expect(detail("websiteOnHand")).toBe(5);
    expect(detail("posOnHand")).toBe(6);
    const after = vg1(
      ((await (await getState("clerk-g-reader")).json()) as { items: Array<{ variantId: string }> })
        .items,
    );
    expect(after).toMatchObject({ websiteOnHand: 5, posOnHand: 6, unallocatedOnHand: 1 });

    // Missing versions never reach the database.
    const unguarded = await allocate("clerk-g-writer", "split-unguarded", split(4, 7));
    expect(unguarded.status).toBe(400);
  });

  it("rejects an over-allocation, a stale version, an unknown variant and a read-only caller", async () => {
    const over = await allocate(
      "clerk-g-writer",
      "split-over",
      split(10, 3, await currentVersions()),
    );
    expect(over.status).toBe(422);
    expect(await errorCode(over)).toBe("CHANNEL_ALLOCATION_INVALID");

    const stale = await allocate(
      "clerk-g-writer",
      "split-stale",
      split(1, 1, { ...(await currentVersions()), expectedBalanceVersion: 0 }),
    );
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("CONCURRENT_MODIFICATION");

    const unknown = await allocate("clerk-g-writer", "split-unknown", {
      inventoryLocationId: LGB,
      reason: "x",
      lines: [
        {
          variantId: UNKNOWN_VARIANT,
          websiteQuantity: 0,
          posQuantity: 0,
          expectedBalanceVersion: 0,
          expectedAllocationVersion: 0,
        },
      ],
    });
    expect(unknown.status).toBe(404);

    const denied = await allocate(
      "clerk-g-reader",
      "split-denied",
      split(1, 1, await currentVersions()),
    );
    expect(denied.status).toBe(403);

    const state = (await (await getState("clerk-g-reader")).json()) as {
      items: Array<{ variantId: string }>;
    };
    expect(vg1(state.items)).toMatchObject({
      websiteOnHand: 5,
      posOnHand: 6,
      unallocatedOnHand: 1,
    });
  });

  it("puts received stock into unallocated without changing Website or POS", async () => {
    const receipt = await receiveAtLgb(3, "channels-receipt-1");
    expect(receipt.status).toBe(200);
    const state = (await (await getState("clerk-g-reader")).json()) as {
      items: Array<{ variantId: string }>;
    };
    expect(vg1(state.items)).toMatchObject({
      canonicalOnHand: 15,
      websiteOnHand: 5,
      posOnHand: 6,
      unallocatedOnHand: 4,
      mismatch: 0,
    });
  });

  it("four admins saving different splits from the same loaded versions: exactly one wins, the rest get 409", async () => {
    const loaded = await currentVersions();
    const before = vg1(
      ((await (await getState("clerk-g-reader")).json()) as { items: Array<{ variantId: string }> })
        .items,
    )!;
    const targets: Array<[number, number]> = [
      [6, 6],
      [4, 8],
      [7, 5],
      [5, 7],
    ];
    // Fired together: the database row locks are the barrier; each request is its own transaction.
    const results = await Promise.all(
      targets.map(([web, pos], index) =>
        allocate("clerk-g-writer", `race-split-${index}`, split(web, pos, loaded)),
      ),
    );
    const statuses = results.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(3);
    for (const response of results.filter((r) => r.status === 409)) {
      expect(await errorCode(response)).toBe("CONCURRENT_MODIFICATION");
    }
    const winner = targets[statuses.indexOf(200)]!;
    const after = vg1(
      ((await (await getState("clerk-g-reader")).json()) as { items: Array<{ variantId: string }> })
        .items,
    )!;
    expect(`${after.websiteOnHand}/${after.posOnHand}`).toBe(`${winner[0]}/${winner[1]}`);
    expect(Number(after.canonicalOnHand)).toBe(Number(before.canonicalOnHand));
    expect(after.mismatch).toBe(0);
    expect(Number(after.allocationVersion)).toBe(loaded.expectedAllocationVersion + 1);
  });

  it("splits racing receipts: receipts always land, at most one split wins, stock is conserved", async () => {
    const loaded = await currentVersions();
    const before = vg1(
      ((await (await getState("clerk-g-reader")).json()) as { items: Array<{ variantId: string }> })
        .items,
    )!;
    const canonicalBefore = Number(before.canonicalOnHand);
    const results = await Promise.all([
      allocate("clerk-g-writer", "conc-split-a", split(6, 6, loaded)),
      receiveAtLgb(1, "conc-receipt-1"),
      allocate("clerk-g-writer", "conc-split-b", split(4, 8, loaded)),
      receiveAtLgb(1, "conc-receipt-2"),
    ]);
    expect(results[1]!.status).toBe(200);
    expect(results[3]!.status).toBe(200);
    const splitStatuses = [results[0]!.status, results[2]!.status];
    for (const status of splitStatuses) expect([200, 409]).toContain(status);
    expect(splitStatuses.filter((status) => status === 200).length).toBeLessThanOrEqual(1);
    const after = vg1(
      ((await (await getState("clerk-g-reader")).json()) as { items: Array<{ variantId: string }> })
        .items,
    )!;
    expect(Number(after.canonicalOnHand)).toBe(canonicalBefore + 2);
    expect(
      Number(after.websiteOnHand) + Number(after.posOnHand) + Number(after.unallocatedOnHand),
    ).toBe(canonicalBefore + 2);
    expect(after.mismatch).toBe(0);
    if (splitStatuses[0] === 200) expect(`${after.websiteOnHand}/${after.posOnHand}`).toBe("6/6");
    else if (splitStatuses[1] === 200)
      expect(`${after.websiteOnHand}/${after.posOnHand}`).toBe("4/8");
    else
      expect(`${after.websiteOnHand}/${after.posOnHand}`).toBe(
        `${before.websiteOnHand}/${before.posOnHand}`,
      );
  });

  it("isolates tenants", async () => {
    const response = await getState("clerk-g-foreign");
    expect([403, 404]).toContain(response.status);
  });
});
