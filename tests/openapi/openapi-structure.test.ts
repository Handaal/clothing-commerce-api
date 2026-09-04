import { describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../../src/openapi/document";

const document = generateOpenApiDocument();
const paths = document.paths as Record<string, Record<string, unknown>>;

function operationOf(pathKey: string): { parameters?: unknown[]; security?: unknown[] } {
  const item = paths[pathKey] as {
    get?: { parameters?: unknown[]; security?: unknown[] };
    post?: { parameters?: unknown[]; security?: unknown[] };
  };
  return item.get ?? item.post ?? {};
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
        "/api/v1/inventory",
        "/api/v1/inventory/receipts",
        "/api/v1/inventory/adjustments",
        "/api/v1/inventory/transfers",
        "/api/v1/me/context",
        "/api/v1/me/tenants",
        "/api/v1/orders",
        "/api/v1/orders/{orderId}",
        "/api/v1/pos/context",
        "/api/v1/pos/sales",
        "/api/v1/products",
        "/api/v1/products/{productId}",
      ].sort(),
    );
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
    ]) {
      expect(operationOf(managementRoute).security).toEqual([{ clerkSessionToken: [] }]);
    }
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
    ]) {
      expect(schemas[name]).toBeDefined();
    }
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
