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

const split = {
  inventoryLocationId: LGB,
  reason: "Initial Website/POS split",
  lines: [
    {
      variantId: VG1,
      websiteQuantity: 1,
      posQuantity: 1,
      expectedBalanceVersion: 0,
      expectedAllocationVersion: 0,
    },
  ],
};

// ADR-042 §13 (owner decision 2026-11-14): stock is one shared pool. The Website/POS split surface is
// retired — every channel endpoint answers 409 CHANNEL_STOCK_SUPERSEDED after authorization and before any
// database write, while ordinary receipts keep working.
describe("ADR-042 channel stock admin API (real database) — retired by §13", () => {
  it("refuses the channel state read as superseded", async () => {
    const response = await getState("clerk-g-reader");
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("CHANNEL_STOCK_SUPERSEDED");
  });

  it("refuses initialize without inventory.adjust and without an Idempotency-Key", async () => {
    const denied = await initialize("clerk-g-reader", "init-denied");
    expect(denied.status).toBe(403);
    const noKey = await initialize("clerk-g-writer");
    expect(noKey.status).toBe(400);
  });

  it("refuses initialize and allocation for an authorized writer as superseded, repeatably", async () => {
    for (const key of ["init-1", "init-2"]) {
      const response = await initialize("clerk-g-writer", key);
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("CHANNEL_STOCK_SUPERSEDED");
    }
    const allocation = await allocate("clerk-g-writer", "split-1", split);
    expect(allocation.status).toBe(409);
    expect(await errorCode(allocation)).toBe("CHANNEL_STOCK_SUPERSEDED");
  });

  it("still refuses an allocation from a read-only caller", async () => {
    const response = await allocate("clerk-g-reader", "split-denied", split);
    expect(response.status).toBe(403);
  });

  it("keeps receiving stock into the shared pool", async () => {
    const receipt = await receiveAtLgb(3, "channels-receipt-1");
    expect(receipt.status).toBe(200);
  });

  it("isolates tenants", async () => {
    const response = await getState("clerk-g-foreign");
    expect([403, 404]).toContain(response.status);
  });
});
