import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { AuthorizationService } from "../../src/authorization/authorization-service";
import { AuthorizationError } from "../../src/authorization/errors";
import { createSupabaseAuthorizationRepository } from "../../src/authorization/supabase-authorization-repository";
import type { VerifiedExternalIdentity } from "../../src/authorization/model";
import type { ExternalIdentityVerifier } from "../../src/authentication/external-identity";
import { CatalogReadService } from "../../src/catalog/catalog-read-service";
import { createSupabaseCatalogReadRepository } from "../../src/catalog/supabase-catalog-read-repository";
import {
  InventoryListResponseSchema,
  MeContextResponseSchema,
  MeTenantsResponseSchema,
  OrderDetailResponseSchema,
  OrderListResponseSchema,
  ProductDetailResponseSchema,
  ProductListResponseSchema,
} from "../../src/contracts";
import { FulfillmentService } from "../../src/fulfillments/fulfillment-service";
import { createSupabaseFulfillmentRepository } from "../../src/fulfillments/supabase-fulfillment-repository";
import {
  parseRequest,
  runIdentityManagementRoute,
  runTenantManagementRoute,
} from "../../src/http/management-route";
import { InventoryReadService } from "../../src/inventory/inventory-read-service";
import { createSupabaseInventoryReadRepository } from "../../src/inventory/supabase-inventory-read-repository";
import { ManagementContextService } from "../../src/management/context-service";
import { IdentityMembershipResolver } from "../../src/management/identity-membership-resolver";
import {
  InventoryListQuerySchema,
  OrderListQuerySchema,
  ProductListQuerySchema,
  queryRecord,
} from "../../src/management/request";
import { createSupabaseIdentityMembershipRepository } from "../../src/management/supabase-identity-membership-repository";
import { createSupabaseOrganizationReadRepository } from "../../src/management/supabase-organization-read-repository";
import { OrdersReadService } from "../../src/orders/orders-read-service";
import { OrderService } from "../../src/orders/order-service";
import { createSupabaseOrdersRepository } from "../../src/orders/supabase-orders-repository";
import { createSupabaseOrdersReadRepository } from "../../src/orders/supabase-orders-read-repository";

const url = process.env.MGMT_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error("MGMT_TEST_SUPABASE_URL and MGMT_TEST_SUPABASE_SERVICE_ROLE_KEY are required.");
}

const config = { url, serviceRoleKey };

const T = "f2000001-0000-4000-8000-000000000001";
const T2 = "f2000001-0000-4000-8000-000000000002";
const BRAND_A = "f2000002-0000-4000-8000-0000000000a1";
const BRAND_B = "f2000002-0000-4000-8000-0000000000a2";
const BRANCH_A = "f2000003-0000-4000-8000-0000000000b1";
const BRANCH_B = "f2000003-0000-4000-8000-0000000000b2";
const LOC_A = "f2000005-0000-4000-8000-0000000000e1";
const LOC_B = "f2000005-0000-4000-8000-0000000000e2";
const LOC_W = "f2000005-0000-4000-8000-0000000000e3";
const PRODUCT_A1 = "f2000007-0000-4000-8000-0000000000a1";
const PRODUCT_B1 = "f2000007-0000-4000-8000-0000000000b1";
const FOREIGN_PRODUCT = "f2000007-0000-4000-8000-0000000000c1";
const ORDER_A_ONLINE = "f200000a-0000-4000-8000-0000000000a1";
const ABSENT_UUID = "f2000099-0000-4000-8000-000000000099";

// Fake verifier: the Authorization header carries "Bearer subject:<subject>"; a missing or "invalid"
// token is an authentication failure. This isolates the test from real Clerk while exercising the full
// AuthorizationContextResolver against the real database.
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
let identityMembershipResolver: IdentityMembershipResolver;
let contextService: ManagementContextService;
let catalog: CatalogReadService;
let inventory: InventoryReadService;
let orders: OrdersReadService;

beforeAll(() => {
  const verifier = new FakeVerifier();
  const authRepository = createSupabaseAuthorizationRepository(config);
  contextResolver = new AuthorizationContextResolver(verifier, authRepository);
  const authorizationService = new AuthorizationService(authRepository);

  identityMembershipResolver = new IdentityMembershipResolver(
    verifier,
    createSupabaseIdentityMembershipRepository(config),
  );
  contextService = new ManagementContextService(createSupabaseOrganizationReadRepository(config));
  catalog = new CatalogReadService(createSupabaseCatalogReadRepository(config));
  inventory = new InventoryReadService(createSupabaseInventoryReadRepository(config));
  orders = new OrdersReadService(
    createSupabaseOrdersReadRepository(config),
    new OrderService(authorizationService, createSupabaseOrdersRepository(config)),
    new FulfillmentService(authorizationService, createSupabaseFulfillmentRepository(config)),
  );
});

function request(subject: string | null, tenantId: string | null, path: string): Request {
  const headers = new Headers();
  if (subject !== null) {
    headers.set("Authorization", `Bearer subject:${subject}`);
  }
  if (tenantId !== null) {
    headers.set("X-Tenant-Id", tenantId);
  }
  return new Request(`http://test${path}`, { headers });
}

async function meTenants(subject: string | null) {
  return runIdentityManagementRoute({
    responseSchema: MeTenantsResponseSchema,
    handler: () => identityMembershipResolver.resolve(request(subject, null, "/api/v1/me/tenants")),
  });
}

async function meContext(subject: string | null, tenantId: string | null) {
  return runTenantManagementRoute({
    request: request(subject, tenantId, "/api/v1/me/context"),
    contextResolver,
    responseSchema: MeContextResponseSchema,
    handler: (context) => contextService.resolveContext(context),
  });
}

async function listProducts(subject: string, tenantId: string, query = "") {
  const httpRequest = request(subject, tenantId, `/api/v1/products${query}`);
  return runTenantManagementRoute({
    request: httpRequest,
    contextResolver,
    responseSchema: ProductListResponseSchema,
    handler: (context) => {
      const params = parseRequest(
        ProductListQuerySchema,
        queryRecord(new URL(httpRequest.url).searchParams, [
          "brandId",
          "status",
          "limit",
          "cursor",
        ]),
      );
      return catalog.listProducts(context, {
        ...(params.brandId !== undefined ? { brandId: params.brandId } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
        limit: params.limit,
        cursor: params.cursor ?? null,
      });
    },
  });
}

async function getProduct(subject: string, tenantId: string, productId: string) {
  return runTenantManagementRoute({
    request: request(subject, tenantId, `/api/v1/products/${productId}`),
    contextResolver,
    responseSchema: ProductDetailResponseSchema,
    handler: (context) => catalog.getProduct(context, productId),
  });
}

async function listInventory(subject: string, tenantId: string, query = "") {
  const httpRequest = request(subject, tenantId, `/api/v1/inventory${query}`);
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
      return inventory.listBalances(context, {
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

async function listOrders(subject: string, tenantId: string, query = "") {
  const httpRequest = request(subject, tenantId, `/api/v1/orders${query}`);
  return runTenantManagementRoute({
    request: httpRequest,
    contextResolver,
    responseSchema: OrderListResponseSchema,
    handler: (context) => {
      const params = parseRequest(
        OrderListQuerySchema,
        queryRecord(new URL(httpRequest.url).searchParams, [
          "channel",
          "brandId",
          "branchId",
          "status",
          "limit",
          "cursor",
        ]),
      );
      return orders.listOrders(context, {
        ...(params.channel !== undefined ? { channel: params.channel } : {}),
        ...(params.brandId !== undefined ? { brandId: params.brandId } : {}),
        ...(params.branchId !== undefined ? { branchId: params.branchId } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
        limit: params.limit,
        cursor: params.cursor ?? null,
      });
    },
  });
}

async function getOrder(subject: string, tenantId: string, orderId: string) {
  return runTenantManagementRoute({
    request: request(subject, tenantId, `/api/v1/orders/${orderId}`),
    contextResolver,
    responseSchema: OrderDetailResponseSchema,
    handler: (context) => orders.getOrder(context, orderId),
  });
}

// Return type is inferred from Response.json() (implicit any); the assertions below read fields off the
// parsed body directly, which keeps the test readable without an explicit any annotation.
async function body(response: Response) {
  return response.json();
}

describe("authentication and tenant boundary", () => {
  it("returns 401 without a token", async () => {
    expect((await meContext(null, T)).status).toBe(401);
    expect((await meTenants(null)).status).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    expect((await meContext("invalid", T)).status).toBe(401);
  });

  it("returns 400 for a missing or malformed tenant header", async () => {
    expect((await meContext("clerk-full", null)).status).toBe(400);
    const badHeader = await runTenantManagementRoute({
      request: request("clerk-full", "not-a-uuid", "/api/v1/me/context"),
      contextResolver,
      responseSchema: MeContextResponseSchema,
      handler: (context) => contextService.resolveContext(context),
    });
    expect(badHeader.status).toBe(400);
  });

  it("returns 403 for a forged tenant header (no membership) and inactive membership", async () => {
    // Foreign identity presenting tenant T where it has no membership.
    expect((await meContext("clerk-foreign", T)).status).toBe(403);
    // Suspended membership in T.
    expect((await meContext("clerk-inactive-membership", T)).status).toBe(403);
    // Unknown identity (no provider binding).
    expect((await meContext("clerk-nobinding", T)).status).toBe(403);
  });

  it("stamps a fresh X-Request-Id and no-store on every response", async () => {
    const response = await meContext("clerk-full", T);
    expect(response.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /me/tenants identity bootstrap", () => {
  it("returns only the caller's own active tenant, never another identity's", async () => {
    const full = await meTenants("clerk-full");
    expect(full.status).toBe(200);
    const rows = await body(full);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(T);

    const foreign = await body(await meTenants("clerk-foreign"));
    expect(foreign).toHaveLength(1);
    expect(foreign[0].tenantId).toBe(T2);
  });

  it("excludes an inactive membership and returns [] when there are none", async () => {
    const rows = await body(await meTenants("clerk-inactive-membership"));
    expect(rows).toEqual([]);
  });
});

describe("GET /me/context canRead semantics", () => {
  it("reports tenant-wide read across catalog, inventory, and orders", async () => {
    const context = await body(await meContext("clerk-full", T));
    expect(context.access.catalog).toMatchObject({ canRead: true, tenantWide: true });
    expect(context.access.inventory).toMatchObject({ canRead: true, tenantWide: true });
    expect(context.access.orders).toMatchObject({ canRead: true, tenantWide: true });
    expect(context.tenant.id).toBe(T);
  });

  it("reports explicit brand/location/branch scopes with hydrated names", async () => {
    const context = await body(await meContext("clerk-explicit", T));
    expect(context.access.catalog).toMatchObject({ canRead: true, tenantWide: false });
    expect(context.access.catalog.brands.map((b: { id: string }) => b.id)).toEqual([BRAND_A]);
    expect(context.access.inventory.locations.map((l: { id: string }) => l.id)).toEqual([LOC_A]);
    expect(context.access.orders.brands.map((b: { id: string }) => b.id)).toEqual([BRAND_A]);
    expect(context.access.orders.branches.map((b: { id: string }) => b.id)).toEqual([BRANCH_A]);
  });

  it("reports canRead=false for wrong-kind-only scopes", async () => {
    const context = await body(await meContext("clerk-wrong", T));
    expect(context.access.catalog).toEqual({ canRead: false, tenantWide: false, brands: [] });
    expect(context.access.inventory).toEqual({
      canRead: false,
      tenantWide: false,
      locations: [],
      write: { canReceive: false, canAdjust: false, canTransfer: false, locations: [] },
    });
    expect(context.access.orders).toEqual({
      canRead: false,
      tenantWide: false,
      brands: [],
      branches: [],
    });
  });
});

describe("GET /me/context inventory write capability", () => {
  it("gives a read-only inventory user no write capability", async () => {
    // clerk-full holds inventory.read tenant-wide but no write permission at all.
    const context = await body(await meContext("clerk-full", T));
    expect(context.access.inventory.canRead).toBe(true);
    expect(context.access.inventory.write).toEqual({
      canReceive: false,
      canAdjust: false,
      canTransfer: false,
      locations: [],
    });
  });

  it("resolves tenant-wide write capability against each location's operational flags", async () => {
    const context = await body(await meContext("clerk-writer", T));
    const write = context.access.inventory.write;
    expect(write).toMatchObject({ canReceive: true, canAdjust: true, canTransfer: true });

    const byId = Object.fromEntries(write.locations.map((l: { id: string }) => [l.id, l]));
    // LA: fully enabled + active.
    expect(byId[LOC_A]).toMatchObject({
      canReceive: true,
      canAdjust: true,
      canTransferOrigin: true,
      canTransferDestination: true,
    });
    // LB: transfer-origin only (receive off, destination off).
    expect(byId[LOC_B]).toMatchObject({
      canReceive: false,
      canAdjust: true,
      canTransferOrigin: true,
      canTransferDestination: false,
    });
    // LW: receive + transfer-destination, but not a transfer origin.
    expect(byId[LOC_W]).toMatchObject({
      canReceive: true,
      canAdjust: true,
      canTransferOrigin: false,
      canTransferDestination: true,
    });
  });

  it("never presents an out-of-scope location to an explicitly-scoped writer", async () => {
    // clerk-write-scoped holds the write role scoped to Location A ONLY.
    const context = await body(await meContext("clerk-write-scoped", T));
    const write = context.access.inventory.write;
    expect(write.locations.map((l: { id: string }) => l.id)).toEqual([LOC_A]);
    // LA is both origin- and destination-enabled, but a single location cannot transfer to itself.
    expect(write).toMatchObject({ canReceive: true, canAdjust: true, canTransfer: false });
    expect(write.locations[0]).toMatchObject({
      canTransferOrigin: true,
      canTransferDestination: true,
    });
    // LB and LW must never appear for this caller.
    const ids = write.locations.map((l: { id: string }) => l.id);
    expect(ids).not.toContain(LOC_B);
    expect(ids).not.toContain(LOC_W);
  });
});

describe("catalog list visibility and pagination", () => {
  it("tenant-wide list excludes nothing and orders newest-first", async () => {
    const page = await body(await listProducts("clerk-full", T));
    expect(page.items).toHaveLength(6);
    expect(page.items[0].name).toBe("Beta Three");
  });

  it("explicit brand scope excludes other brands BEFORE pagination, across pages", async () => {
    const page1 = await body(await listProducts("clerk-explicit", T, "?limit=2"));
    expect(page1.items.map((p: { name: string }) => p.name)).toEqual(["Alpha Three", "Alpha Two"]);
    expect(page1.pageInfo.hasMore).toBe(true);

    const page2 = await body(
      await listProducts(
        "clerk-explicit",
        T,
        `?limit=2&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`,
      ),
    );
    expect(page2.items.map((p: { name: string }) => p.name)).toEqual(["Alpha One"]);
    expect(page2.pageInfo.hasMore).toBe(false);
    // No Brand B product ever appears for a Brand-A-scoped caller.
    const allNames = [...page1.items, ...page2.items].map((p: { brandId: string }) => p.brandId);
    expect(allNames.every((id: string) => id === BRAND_A)).toBe(true);
  });

  it("wrong-kind-only catalog scope yields an empty list (not 403)", async () => {
    const response = await listProducts("clerk-wrong", T);
    expect(response.status).toBe(200);
    expect((await body(response)).items).toEqual([]);
  });

  it("missing catalog permission entirely is 403", async () => {
    expect((await listProducts("clerk-noperm", T)).status).toBe(403);
  });

  it("explicit filter: foreign brand is 404, in-tenant out-of-scope brand is 403", async () => {
    expect((await listProducts("clerk-explicit", T, `?brandId=${ABSENT_UUID}`)).status).toBe(404);
    expect((await listProducts("clerk-explicit", T, `?brandId=${BRAND_B}`)).status).toBe(403);
    expect((await listProducts("clerk-explicit", T, `?brandId=${BRAND_A}`)).status).toBe(200);
  });

  it("malformed cursor is 400", async () => {
    const response = await listProducts("clerk-full", T, "?cursor=%21%21not-valid");
    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe("INVALID_CURSOR");
  });
});

describe("product detail", () => {
  it("foreign product is 404 and authorized product returns detail", async () => {
    expect((await getProduct("clerk-explicit", T, FOREIGN_PRODUCT)).status).toBe(404);
    expect((await getProduct("clerk-explicit", T, PRODUCT_B1)).status).toBe(403);
    const detail = await body(await getProduct("clerk-explicit", T, PRODUCT_A1));
    expect(detail.product.id).toBe(PRODUCT_A1);
    expect(detail.prices[0]).toMatchObject({ currency: "USD", amountMinor: 1999 });
  });
});

describe("inventory list visibility", () => {
  it("location scope excludes unauthorized locations", async () => {
    const scoped = await body(await listInventory("clerk-explicit", T));
    expect(
      scoped.items.every((b: { inventoryLocationId: string }) => b.inventoryLocationId === LOC_A),
    ).toBe(true);
    expect(scoped.items).toHaveLength(2);
    const full = await body(await listInventory("clerk-full", T));
    expect(full.items.length).toBeGreaterThanOrEqual(4);
    expect(full.items[0]).toHaveProperty("productName");
  });

  it("exposes the authoritative persisted balance version on every row", async () => {
    const full = await body(await listInventory("clerk-full", T));
    // Every row carries the version; the fixture seeds each balance at version 1.
    for (const row of full.items) {
      expect(typeof row.version).toBe("number");
      expect(row.version).toBe(1);
    }
    const scoped = await body(await listInventory("clerk-explicit", T));
    expect(scoped.items.every((b: { version: number }) => typeof b.version === "number")).toBe(
      true,
    );
  });

  it("explicit location filter enforces 404/403", async () => {
    expect(
      (await listInventory("clerk-explicit", T, `?inventoryLocationId=${ABSENT_UUID}`)).status,
    ).toBe(404);
    expect((await listInventory("clerk-explicit", T, `?inventoryLocationId=${LOC_B}`)).status).toBe(
      403,
    );
    expect((await listInventory("clerk-explicit", T, `?inventoryLocationId=${LOC_A}`)).status).toBe(
      200,
    );
  });
});

describe("orders list channel-split visibility", () => {
  it("tenant-wide sees all orders", async () => {
    const page = await body(await listOrders("clerk-full", T));
    expect(page.items).toHaveLength(4);
  });

  it("explicit scope sees only online-of-brand and pos-of-branch", async () => {
    const page = await body(await listOrders("clerk-explicit", T));
    const numbers = page.items.map((o: { orderNumber: string }) => o.orderNumber).sort();
    expect(numbers).toEqual(["ORD-A-ONLINE", "ORD-A-POS"]);
  });

  it("explicit brand/branch filters enforce 404/403", async () => {
    expect((await listOrders("clerk-explicit", T, `?brandId=${BRAND_B}`)).status).toBe(403);
    expect((await listOrders("clerk-explicit", T, `?branchId=${BRANCH_B}`)).status).toBe(403);
    expect((await listOrders("clerk-explicit", T, `?brandId=${ABSENT_UUID}`)).status).toBe(404);
    expect((await listOrders("clerk-explicit", T, `?brandId=${BRAND_A}`)).status).toBe(200);
  });
});

describe("order detail with fulfillment progress", () => {
  it("returns header, lines, and fulfillment progress without internal fields", async () => {
    const response = await getOrder("clerk-full", T, ORDER_A_ONLINE);
    expect(response.status).toBe(200);
    const detail = await body(response);
    expect(detail.header.orderNumber).toBe("ORD-A-ONLINE");
    expect(detail.lines[0]).toMatchObject({ lineNumber: 1, sku: "SKU-A1" });
    expect(detail.fulfillmentProgress.status).toBe("unfulfilled");
    expect(JSON.stringify(detail)).not.toContain("inventoryOperationId");
    expect(JSON.stringify(detail)).not.toContain("idempotency");
  });

  it("foreign/absent order is a safe 404", async () => {
    expect((await getOrder("clerk-full", T, ABSENT_UUID)).status).toBe(404);
  });

  it("out-of-scope order is 403", async () => {
    // clerk-explicit is scoped to Brand A / Branch A; an online Brand B order is out of scope.
    const orderBOnline = "f200000a-0000-4000-8000-0000000000b1";
    expect((await getOrder("clerk-explicit", T, orderBOnline)).status).toBe(403);
  });
});

describe("client metadata has no authorization effect", () => {
  it("ignores X-Client-Type/Version entirely", async () => {
    const httpRequest = request("clerk-full", T, "/api/v1/me/context");
    httpRequest.headers.set("X-Client-Type", "admin-mobile");
    httpRequest.headers.set("X-Client-Version", "9.9.9");
    const response = await runTenantManagementRoute({
      request: httpRequest,
      contextResolver,
      responseSchema: MeContextResponseSchema,
      handler: (context) => contextService.resolveContext(context),
    });
    expect(response.status).toBe(200);
  });
});
