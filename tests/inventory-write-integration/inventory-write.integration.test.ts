import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { AuthorizationService } from "../../src/authorization/authorization-service";
import { AuthorizationError } from "../../src/authorization/errors";
import { createSupabaseAuthorizationRepository } from "../../src/authorization/supabase-authorization-repository";
import type { VerifiedExternalIdentity } from "../../src/authorization/model";
import type { ExternalIdentityVerifier } from "../../src/authentication/external-identity";
import {
  AdjustInventoryRequestSchema,
  AdjustInventoryResponseSchema,
  InventoryListResponseSchema,
  ReceiveInventoryRequestSchema,
  ReceiveInventoryResponseSchema,
  TransferInventoryRequestSchema,
  TransferInventoryResponseSchema,
} from "../../src/contracts";
import {
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../src/http/management-route";
import { InventoryReadService } from "../../src/inventory/inventory-read-service";
import { InventoryService } from "../../src/inventory/inventory-service";
import { createSupabaseInventoryReadRepository } from "../../src/inventory/supabase-inventory-read-repository";
import { createSupabaseInventoryRepository } from "../../src/inventory/supabase-inventory-repository";
import { InventoryListQuerySchema, queryRecord } from "../../src/management/request";

const url = process.env.MGMT_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error("MGMT_TEST_SUPABASE_URL and MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY are required.");
}

const config = { url, serviceRoleKey };

const TG = "f2900001-0000-4000-8000-000000000001";
const TG2 = "f2900001-0000-4000-8000-000000000002";
const LGA = "f2900005-0000-4000-8000-0000000000e1";
const LGB = "f2900005-0000-4000-8000-0000000000e2";
const VG1 = "f2900008-0000-4000-8000-0000000000a1"; // receive scenario, seeded 10
const VG2 = "f2900008-0000-4000-8000-0000000000a2"; // adjust scenario, seeded 5 (version 1)
const VG3 = "f2900008-0000-4000-8000-0000000000a3"; // transfer scenario, seeded 20
const VG4 = "f2900008-0000-4000-8000-0000000000a4"; // read->adjust contract, seeded 8 (version 1)

// Fake verifier: Authorization header carries "Bearer subject:<subject>"; this isolates the test from
// Clerk while exercising the full AuthorizationContextResolver against the real database.
class FakeVerifier implements ExternalIdentityVerifier {
  async verifyRequest(request: Request): Promise<VerifiedExternalIdentity> {
    const header = request.headers.get("Authorization");
    const match = header?.match(/^Bearer subject:(.+)$/);
    if (!match || match[1] === "invalid") {
      throw new AuthorizationError("UNAUTHENTICATED");
    }
    return { provider: "clerk", subject: match[1] };
  }
}

let contextResolver: AuthorizationContextResolver;
let inventory: InventoryService;
let inventoryRead: InventoryReadService;

beforeAll(() => {
  const verifier = new FakeVerifier();
  const authRepository = createSupabaseAuthorizationRepository(config);
  contextResolver = new AuthorizationContextResolver(verifier, authRepository);
  const authorizationService = new AuthorizationService(authRepository);
  inventory = new InventoryService(authorizationService, createSupabaseInventoryRepository(config));
  inventoryRead = new InventoryReadService(createSupabaseInventoryReadRepository(config));
});

interface WriteOptions {
  subject: string | null;
  tenantId: string | null;
  idempotencyKey?: string | null;
  path: string;
  body: unknown;
}

function writeRequest({ subject, tenantId, idempotencyKey, path, body }: WriteOptions): Request {
  const headers = new Headers();
  if (subject !== null) headers.set("Authorization", `Bearer subject:${subject}`);
  if (tenantId !== null) headers.set("X-Tenant-Id", tenantId);
  if (idempotencyKey !== null && idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  headers.set("Content-Type", "application/json");
  return new Request(`http://test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function receive(options: Omit<WriteOptions, "path">) {
  return runTenantManagementWriteRoute({
    request: writeRequest({ ...options, path: "/api/v1/inventory/receipts" }),
    contextResolver,
    requestSchema: ReceiveInventoryRequestSchema,
    responseSchema: ReceiveInventoryResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      inventory
        .receiveInventory(context, {
          variantId: body.variantId,
          inventoryLocationId: body.inventoryLocationId,
          quantity: body.quantity,
          idempotencyKey,
          ...(body.note !== undefined ? { note: body.note } : {}),
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

async function adjust(options: Omit<WriteOptions, "path">) {
  return runTenantManagementWriteRoute({
    request: writeRequest({ ...options, path: "/api/v1/inventory/adjustments" }),
    contextResolver,
    requestSchema: AdjustInventoryRequestSchema,
    responseSchema: AdjustInventoryResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      inventory.adjustInventory(context, {
        variantId: body.variantId,
        inventoryLocationId: body.inventoryLocationId,
        countedQuantity: body.countedQuantity,
        expectedVersion: body.expectedVersion,
        idempotencyKey,
        ...(body.note !== undefined ? { note: body.note } : {}),
      }),
  });
}

async function transfer(options: Omit<WriteOptions, "path">) {
  return runTenantManagementWriteRoute({
    request: writeRequest({ ...options, path: "/api/v1/inventory/transfers" }),
    contextResolver,
    requestSchema: TransferInventoryRequestSchema,
    responseSchema: TransferInventoryResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      inventory
        .transferInventory(context, {
          variantId: body.variantId,
          sourceInventoryLocationId: body.sourceInventoryLocationId,
          destinationInventoryLocationId: body.destinationInventoryLocationId,
          quantity: body.quantity,
          idempotencyKey,
          ...(body.note !== undefined ? { note: body.note } : {}),
        })
        .then((r) => ({
          operationId: r.operationId,
          variantId: r.variantId,
          source: {
            inventoryLocationId: r.source.inventoryLocationId,
            observedOnHand: r.source.observedOnHand,
            observedVersion: r.source.observedVersion,
          },
          destination: {
            inventoryLocationId: r.destination.inventoryLocationId,
            observedOnHand: r.destination.observedOnHand,
            observedVersion: r.destination.observedVersion,
          },
        })),
  });
}

async function listInventory(subject: string, tenantId: string, query: string) {
  const headers = new Headers();
  headers.set("Authorization", `Bearer subject:${subject}`);
  headers.set("X-Tenant-Id", tenantId);
  const httpRequest = new Request(`http://test/api/v1/inventory${query}`, { headers });
  return runTenantManagementRoute({
    request: httpRequest,
    contextResolver,
    responseSchema: InventoryListResponseSchema,
    handler: (context) => {
      const params = parseRequest(
        InventoryListQuerySchema,
        queryRecord(new URL(httpRequest.url).searchParams, [
          "inventoryLocationId",
          "variantId",
          "limit",
          "cursor",
        ]),
      );
      return inventoryRead.listBalances(context, {
        ...(params.inventoryLocationId !== undefined
          ? { inventoryLocationId: params.inventoryLocationId }
          : {}),
        ...(params.variantId !== undefined ? { variantId: params.variantId } : {}),
        limit: params.limit,
        cursor: params.cursor ?? null,
      });
    },
  });
}

async function body(response: Response) {
  return response.json();
}

describe("receive stock through the HTTP write boundary", () => {
  it("applies the receipt exactly once and reports the new balance", async () => {
    const response = await receive({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "recv-1",
      body: { variantId: VG1, inventoryLocationId: LGA, quantity: 4, note: "pallet" },
    });
    expect(response.status).toBe(200);
    const result = await body(response);
    // Seeded 10 + 4 received = 14.
    expect(result.observedOnHand).toBe(14);
    expect(result.inventoryLocationId).toBe(LGA);
  });

  it("does not apply a same-key/same-body replay twice", async () => {
    const replay = await receive({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "recv-1",
      body: { variantId: VG1, inventoryLocationId: LGA, quantity: 4, note: "pallet" },
    });
    expect(replay.status).toBe(200);
    // Still 14, not 18: the ledger replayed the recorded operation instead of re-applying it.
    expect((await body(replay)).observedOnHand).toBe(14);
  });

  it("rejects a same-key/different-body replay as an idempotency conflict", async () => {
    const conflict = await receive({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "recv-1",
      body: { variantId: VG1, inventoryLocationId: LGA, quantity: 9 },
    });
    expect(conflict.status).toBe(409);
    expect((await body(conflict)).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects an invalid body with 400 and a missing idempotency key with 400", async () => {
    const badBody = await receive({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "recv-bad",
      body: { variantId: VG1, inventoryLocationId: LGA, quantity: 0 },
    });
    expect(badBody.status).toBe(400);

    const noKey = await receive({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: null,
      body: { variantId: VG1, inventoryLocationId: LGA, quantity: 4 },
    });
    expect(noKey.status).toBe(400);
  });

  it("rejects an unauthenticated write with 401 and a permission-less writer with 403", async () => {
    const unauth = await receive({
      subject: null,
      tenantId: TG,
      idempotencyKey: "recv-unauth",
      body: { variantId: VG1, inventoryLocationId: LGA, quantity: 4 },
    });
    expect(unauth.status).toBe(401);

    const forbidden = await receive({
      subject: "clerk-g-reader",
      tenantId: TG,
      idempotencyKey: "recv-forbidden",
      body: { variantId: VG1, inventoryLocationId: LGA, quantity: 4 },
    });
    expect(forbidden.status).toBe(403);
  });

  it("cannot mutate another tenant's inventory (isolation)", async () => {
    // The writer has no membership in TG2; presenting its tenant header is a 403 at context resolution.
    const crossTenant = await receive({
      subject: "clerk-g-writer",
      tenantId: TG2,
      idempotencyKey: "recv-cross",
      body: { variantId: VG1, inventoryLocationId: LGA, quantity: 4 },
    });
    expect(crossTenant.status).toBe(403);
  });
});

describe("adjust stock through the HTTP write boundary", () => {
  it("reconciles to the counted quantity and guards stale versions", async () => {
    const response = await adjust({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "adj-1",
      body: { variantId: VG2, inventoryLocationId: LGA, countedQuantity: 12, expectedVersion: 1 },
    });
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result).toMatchObject({ changed: true, previousOnHand: 5, newOnHand: 12 });

    // Version has moved past 1; a re-count against the stale version is a safe conflict, not an overwrite.
    const stale = await adjust({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "adj-stale",
      body: { variantId: VG2, inventoryLocationId: LGA, countedQuantity: 99, expectedVersion: 1 },
    });
    expect(stale.status).toBe(409);
    expect((await body(stale)).error.code).toBe("CONCURRENT_MODIFICATION");
  });
});

describe("transfer stock through the HTTP write boundary", () => {
  it("moves stock from source to destination and does not double-apply on replay", async () => {
    const response = await transfer({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "xfer-1",
      body: {
        variantId: VG3,
        sourceInventoryLocationId: LGA,
        destinationInventoryLocationId: LGB,
        quantity: 6,
      },
    });
    expect(response.status).toBe(200);
    const result = await body(response);
    // Source seeded 20 - 6 = 14; destination 0 + 6 = 6.
    expect(result.source.observedOnHand).toBe(14);
    expect(result.destination.observedOnHand).toBe(6);

    const replay = await transfer({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "xfer-1",
      body: {
        variantId: VG3,
        sourceInventoryLocationId: LGA,
        destinationInventoryLocationId: LGB,
        quantity: 6,
      },
    });
    const replayResult = await body(replay);
    // Unchanged: the transfer was not applied a second time.
    expect(replayResult.source.observedOnHand).toBe(14);
    expect(replayResult.destination.observedOnHand).toBe(6);
  });

  it("enforces destination scope: source in scope but destination out of scope is 403", async () => {
    // clerk-g-scoped holds inventory.transfer scoped to LGA only. Source LGA is covered, destination
    // LGB is not, so authorization denies the transfer before any ledger write.
    const denied = await transfer({
      subject: "clerk-g-scoped",
      tenantId: TG,
      idempotencyKey: "xfer-scope",
      body: {
        variantId: VG3,
        sourceInventoryLocationId: LGA,
        destinationInventoryLocationId: LGB,
        quantity: 1,
      },
    });
    expect(denied.status).toBe(403);
    expect((await body(denied)).error.code).toBe("SCOPE_DENIED");
  });
});

describe("adjust client contract: fresh read provides the version, refresh recovers from a 409", () => {
  it("reads the authoritative version, adjusts against it, and refreshes after a stale conflict", async () => {
    // 1. Fresh inventory read gives the client everything it needs to adjust safely: onHand + version.
    const firstRead = await listInventory(
      "clerk-g-writer",
      TG,
      `?variantId=${VG4}&inventoryLocationId=${LGA}`,
    );
    expect(firstRead.status).toBe(200);
    const firstRow = (await body(firstRead)).items[0];
    expect(firstRow).toMatchObject({ variantId: VG4, inventoryLocationId: LGA, onHand: 8 });
    expect(typeof firstRow.version).toBe("number");
    const observedVersion = firstRow.version;

    // 2. Adjust using exactly the version the read returned -> success, version advances.
    const applied = await adjust({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "adj-contract-1",
      body: {
        variantId: VG4,
        inventoryLocationId: LGA,
        countedQuantity: 15,
        expectedVersion: observedVersion,
      },
    });
    expect(applied.status).toBe(200);
    const appliedResult = await body(applied);
    expect(appliedResult).toMatchObject({ changed: true, previousOnHand: 8, newOnHand: 15 });
    expect(appliedResult.version).toBeGreaterThan(observedVersion);

    // 3. Re-using the now-stale version is a safe CONCURRENT_MODIFICATION, never a blind overwrite.
    const stale = await adjust({
      subject: "clerk-g-writer",
      tenantId: TG,
      idempotencyKey: "adj-contract-stale",
      body: {
        variantId: VG4,
        inventoryLocationId: LGA,
        countedQuantity: 99,
        expectedVersion: observedVersion,
      },
    });
    expect(stale.status).toBe(409);
    expect((await body(stale)).error.code).toBe("CONCURRENT_MODIFICATION");

    // 4. A refresh read returns the newer authoritative version so the client can retry with user reconfirmation.
    const refreshed = await listInventory(
      "clerk-g-writer",
      TG,
      `?variantId=${VG4}&inventoryLocationId=${LGA}`,
    );
    const refreshedRow = (await body(refreshed)).items[0];
    expect(refreshedRow.onHand).toBe(15);
    expect(refreshedRow.version).toBe(appliedResult.version);
    expect(refreshedRow.version).toBeGreaterThan(observedVersion);
  });
});
