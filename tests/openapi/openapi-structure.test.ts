import { describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../../src/openapi/document";

const document = generateOpenApiDocument();
const paths = document.paths as Record<string, Record<string, unknown>>;

function operationOf(pathKey: string): { parameters?: unknown[]; security?: unknown[] } {
  const item = paths[pathKey] as {
    get?: { parameters?: unknown[]; security?: unknown[] };
    post?: { parameters?: unknown[]; security?: unknown[] };
    patch?: { parameters?: unknown[]; security?: unknown[] };
    put?: { parameters?: unknown[]; security?: unknown[] };
    delete?: { parameters?: unknown[]; security?: unknown[] };
  };
  return item.get ?? item.post ?? item.patch ?? item.put ?? item.delete ?? {};
}

function parametersOf(pathKey: string): Array<{ $ref?: string; name?: string; in?: string }> {
  return (operationOf(pathKey).parameters ?? []) as Array<{
    $ref?: string;
    name?: string;
    in?: string;
  }>;
}

function hasTenantHeader(pathKey: string): boolean {
  return parametersOf(pathKey).some(
    (parameter) => parameter.$ref === "#/components/parameters/TenantIdHeader",
  );
}

function hasIdempotencyHeader(pathKey: string): boolean {
  return parametersOf(pathKey).some(
    (parameter) => parameter.$ref === "#/components/parameters/IdempotencyKeyHeader",
  );
}

const inventoryWritePaths = [
  "/api/v1/inventory/receipts",
  "/api/v1/inventory/adjustments",
  "/api/v1/inventory/transfers",
];

describe("OpenAPI management surface", () => {
  it("exposes exactly the management read paths, the inventory write paths, and health", () => {
    expect(Object.keys(paths).sort()).toEqual(
      [
        "/api/v1/health",
        "/api/v1/suppliers",
        "/api/v1/suppliers/{supplierId}",
        "/api/v1/suppliers/{supplierId}/receipts",
        "/api/v1/staff",
        "/api/v1/staff/eligible-identities",
        "/api/v1/staff/assignable-roles",
        "/api/v1/staff/assignable-scopes",
        "/api/v1/staff/{membershipId}",
        "/api/v1/staff/{membershipId}/role-assignments",
        "/api/v1/staff/{membershipId}/role-assignments/{assignmentId}",
        "/api/v1/inventory",
        "/api/v1/inventory/receipts",
        "/api/v1/inventory/adjustments",
        "/api/v1/inventory/transfers",
        "/api/v1/me/context",
        "/api/v1/me/tenants",
        "/api/v1/orders",
        "/api/v1/orders/{orderId}",
        "/api/v1/orders/{orderId}/return-eligibility",
        "/api/v1/orders/{orderId}/returns",
        "/api/v1/returns/{returnId}",
        "/api/v1/returns/{returnId}/refund",
        "/api/v1/pos/context",
        "/api/v1/pos/sales",
        "/api/v1/pos/devices",
        "/api/v1/pos/devices/{deviceId}/credentials",
        "/api/v1/pos/devices/{deviceId}/revoke",
        "/api/v1/pos/offline-bootstrap",
        "/api/v1/pos/offline-sales",
        "/api/v1/products",
        "/api/v1/products/{productId}",
        "/api/v1/products/{productId}/status",
        "/api/v1/products/{productId}/publication",
        "/api/v1/products/{productId}/variants",
        "/api/v1/products/{productId}/media",
        "/api/v1/products/{productId}/media/upload-intent",
        "/api/v1/products/{productId}/media/{mediaId}",
        "/api/v1/variants/{variantId}/price",
        "/api/v1/storefront/checkout",
        "/api/v1/storefront/quote",
        "/api/v1/storefront/products",
        "/api/v1/storefront/products/{slug}",
        "/api/v1/pos/quote",
        "/api/v1/promotions",
        "/api/v1/promotions/{promotionId}",
        "/api/v1/promotions/{promotionId}/status",
        "/api/v1/promotions/{promotionId}/codes",
        "/api/v1/promotions/codes/{codeId}/status",
        "/api/v1/reports/summary",
        "/api/v1/reports/sales",
        "/api/v1/reports/products",
        "/api/v1/reports/inventory",
        "/api/v1/reports/returns",
        "/api/v1/reports/promotions",
        "/api/v1/reports/suppliers",
        "/api/v1/reports/export",
        "/api/v1/settings/business",
        "/api/v1/settings/brands",
        "/api/v1/settings/brands/{brandId}",
        "/api/v1/settings/branches",
        "/api/v1/settings/branches/{branchId}",
        "/api/v1/settings/branches/{branchId}/brands",
        "/api/v1/settings/warehouses",
        "/api/v1/settings/warehouses/{warehouseId}",
        "/api/v1/settings/inventory-locations",
        "/api/v1/settings/inventory-locations/{locationId}",
        "/api/v1/settings/registers",
        "/api/v1/settings/registers/{registerId}",
        "/api/v1/settings/storefront",
        "/api/v1/settings/storefront/{brandId}",
        "/api/v1/settings/returns",
        "/api/v1/settings/devices",
        "/api/v1/settings/devices/{deviceId}",
        "/api/v1/settings/devices/{deviceId}/revoke",
        "/api/v1/settings/devices/{deviceId}/assignment",
      ].sort(),
    );
  });

  it("exposes the public storefront reads without a session or tenant header", () => {
    for (const publicPath of [
      "/api/v1/storefront/products",
      "/api/v1/storefront/products/{slug}",
    ]) {
      expect(operationOf(publicPath).security).toBeUndefined();
      expect(hasTenantHeader(publicPath)).toBe(false);
      expect(hasIdempotencyHeader(publicPath)).toBe(false);
    }
  });

  it("publishes a strict public checkout command with idempotency and no workforce headers", () => {
    const route = "/api/v1/storefront/checkout";
    expect(operationOf(route).security).toEqual([]);
    expect(hasTenantHeader(route)).toBe(false);
    expect(hasIdempotencyHeader(route)).toBe(true);
  });

  it("requires idempotency on catalog writes but not on the media upload intent", () => {
    // Note: /api/v1/products resolves to its GET here (list); its POST idempotency is covered by the
    // committed OpenAPI drift snapshot.
    for (const writePath of [
      "/api/v1/products/{productId}/status",
      "/api/v1/products/{productId}/publication",
      "/api/v1/products/{productId}/variants",
      "/api/v1/products/{productId}/media",
      "/api/v1/variants/{variantId}/price",
    ]) {
      expect(hasIdempotencyHeader(writePath)).toBe(true);
      expect(hasTenantHeader(writePath)).toBe(true);
    }
    expect(hasIdempotencyHeader("/api/v1/products/{productId}/media/upload-intent")).toBe(false);
    expect(hasTenantHeader("/api/v1/products/{productId}/media/upload-intent")).toBe(true);
  });

  it("exposes the staff assignment catalogs as tenant-scoped, paginated, read-only GETs", () => {
    for (const catalogPath of [
      "/api/v1/staff/assignable-roles",
      "/api/v1/staff/assignable-scopes",
    ]) {
      // Selection only: authoring roles, scopes and scope targets stays deferred, so there is no write
      // verb and therefore no idempotency key.
      expect(Object.keys(paths[catalogPath])).toEqual(["get"]);
      expect(hasIdempotencyHeader(catalogPath)).toBe(false);
      expect(hasTenantHeader(catalogPath)).toBe(true);
      expect(parametersOf(catalogPath).map((parameter) => parameter.name)).toEqual([
        undefined,
        "limit",
        "cursor",
      ]);
    }
  });

  it("exposes the inventory writes as POST operations with typed request bodies", () => {
    for (const writePath of inventoryWritePaths) {
      const post = (paths[writePath] as { post?: { requestBody?: unknown } }).post;
      expect(post).toBeDefined();
      expect(post?.requestBody).toBeDefined();
    }
    // Opening-stock and issue are deliberately NOT exposed in this phase.
    expect(paths["/api/v1/inventory/opening"]).toBeUndefined();
    expect(paths["/api/v1/inventory/issues"]).toBeUndefined();
  });

  it("requires the idempotency-key header on every inventory and POS sale write", () => {
    for (const writePath of inventoryWritePaths) {
      expect(hasIdempotencyHeader(writePath)).toBe(true);
      expect(hasTenantHeader(writePath)).toBe(true);
    }
    for (const readPath of ["/api/v1/inventory", "/api/v1/products", "/api/v1/orders"]) {
      expect(hasIdempotencyHeader(readPath)).toBe(false);
    }
    expect(hasIdempotencyHeader("/api/v1/pos/sales")).toBe(true);
    for (const path of [
      "/api/v1/pos/devices",
      "/api/v1/pos/devices/{deviceId}/credentials",
      "/api/v1/pos/devices/{deviceId}/revoke",
      "/api/v1/pos/offline-bootstrap",
      "/api/v1/pos/offline-sales",
    ])
      expect(hasIdempotencyHeader(path)).toBe(true);
  });

  it("declares a Clerk bearer session-token security scheme", () => {
    const scheme = (
      document.components.securitySchemes as {
        clerkSessionToken?: { type?: string; scheme?: string };
      }
    ).clerkSessionToken;
    expect(scheme?.type).toBe("http");
    expect(scheme?.scheme).toBe("bearer");
  });

  it("requires the tenant header on tenant-scoped routes only", () => {
    for (const tenantRoute of [
      "/api/v1/me/context",
      "/api/v1/products",
      "/api/v1/products/{productId}",
      "/api/v1/inventory",
      ...inventoryWritePaths,
      "/api/v1/orders",
      "/api/v1/orders/{orderId}",
      "/api/v1/pos/context",
      "/api/v1/pos/sales",
      "/api/v1/pos/devices",
      "/api/v1/pos/devices/{deviceId}/credentials",
      "/api/v1/pos/devices/{deviceId}/revoke",
      "/api/v1/pos/offline-bootstrap",
      "/api/v1/pos/offline-sales",
    ]) {
      expect(hasTenantHeader(tenantRoute)).toBe(true);
    }
    // Identity bootstrap and health must NOT carry the tenant header.
    expect(hasTenantHeader("/api/v1/me/tenants")).toBe(false);
    expect(parametersOf("/api/v1/health")).toEqual([]);
  });

  it("secures every management operation and leaves health public", () => {
    for (const managementRoute of [
      "/api/v1/me/tenants",
      "/api/v1/me/context",
      "/api/v1/products",
      "/api/v1/products/{productId}",
      "/api/v1/inventory",
      ...inventoryWritePaths,
      "/api/v1/orders",
      "/api/v1/orders/{orderId}",
      "/api/v1/pos/context",
      "/api/v1/pos/sales",
      "/api/v1/pos/devices",
      "/api/v1/pos/devices/{deviceId}/credentials",
      "/api/v1/pos/devices/{deviceId}/revoke",
      "/api/v1/pos/offline-bootstrap",
    ]) {
      expect(operationOf(managementRoute).security).toEqual([{ clerkSessionToken: [] }]);
    }
    expect(operationOf("/api/v1/pos/offline-sales").security).toEqual([]);
    expect(
      (paths["/api/v1/health"] as { get: { security?: unknown } }).get.security,
    ).toBeUndefined();
  });

  it("registers reusable error responses, pagination, and DTO schemas", () => {
    const responses = document.components.responses as Record<string, unknown>;
    for (const status of [400, 401, 403, 404, 409, 422, 500]) {
      expect(responses[`Error${status}`]).toBeDefined();
    }
    const schemas = document.components.schemas as Record<string, unknown>;
    for (const name of [
      "ApiError",
      "PageInfo",
      "MeTenants",
      "MeContextResponse",
      "ProductListResponse",
      "ProductDetailResponse",
      "InventoryListResponse",
      "ReceiveInventoryRequest",
      "ReceiveInventoryResponse",
      "AdjustInventoryRequest",
      "AdjustInventoryResponse",
      "TransferInventoryRequest",
      "TransferInventoryResponse",
      "OrderListResponse",
      "OrderDetailResponse",
      "PosContextResponse",
      "CreatePosSaleRequest",
      "CreatePosSaleResponse",
      "EnrollPosDeviceRequest",
      "PosDeviceResponse",
      "OfflineBootstrapRequest",
      "OfflineBootstrapResponse",
      "IngestOfflineSaleRequest",
      "IngestOfflineSaleResponse",
    ]) {
      expect(schemas[name]).toBeDefined();
    }
  });

  it("publishes additive independent Promotion capability guidance on /me/context", () => {
    const contextSchema = (document.components.schemas as Record<string, unknown>)[
      "MeContextResponse"
    ] as {
      properties: {
        access: {
          properties: Record<string, { required?: string[] }>;
          required: string[];
        };
      };
    };
    const access = contextSchema.properties.access;

    expect(access.properties.promotions?.required).toEqual(["canRead", "canManage"]);
    expect(access.required).not.toContain("promotions");
    expect(access.properties.catalog).toBeDefined();
    expect(access.properties.inventory).toBeDefined();
    expect(access.properties.orders).toBeDefined();
    expect(access.properties.suppliers).toBeDefined();
    expect(access.properties.staff).toBeDefined();
  });

  it("publishes the bounded CSV export as a tenant-scoped text/csv GET with the row/date bounds", () => {
    const route = "/api/v1/reports/export";
    expect(operationOf(route).security).toEqual([{ clerkSessionToken: [] }]);
    expect(hasTenantHeader(route)).toBe(true);
    expect(hasIdempotencyHeader(route)).toBe(false);

    const get = (
      paths[route] as { get: { parameters: unknown[]; responses: Record<string, unknown> } }
    ).get;
    const dataset = (
      get.parameters as Array<{ name?: string; required?: boolean; schema?: { enum?: string[] } }>
    ).find((parameter) => parameter.name === "dataset");
    expect(dataset?.required).toBe(true);
    expect(dataset?.schema?.enum).toEqual([
      "sales-products",
      "inventory-movements",
      "returns",
      "supplier-receipts",
    ]);

    const ok = get.responses["200"] as { content: Record<string, unknown> };
    expect(Object.keys(ok.content)).toEqual(["text/csv"]);
    // The row bound surfaces as an explicit 413, never a silent truncation.
    expect(get.responses["413"]).toEqual({ $ref: "#/components/responses/Error413" });
  });

  it("keeps the health operation unchanged (no security, no tenant header)", () => {
    expect(paths["/api/v1/health"]).toEqual({
      get: {
        operationId: "getHealth",
        responses: {
          "200": {
            description: "API is healthy",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    });
  });
});
