import { describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../../src/openapi/document";

const document = generateOpenApiDocument();
const paths = document.paths as Record<string, Record<string, unknown>>;

function parametersOf(pathKey: string): Array<{ $ref?: string; name?: string; in?: string }> {
  const operation = (paths[pathKey] as { get?: { parameters?: unknown[] } }).get;
  return (operation?.parameters ?? []) as Array<{ $ref?: string; name?: string; in?: string }>;
}

function hasTenantHeader(pathKey: string): boolean {
  return parametersOf(pathKey).some(
    (parameter) => parameter.$ref === "#/components/parameters/TenantIdHeader",
  );
}

describe("OpenAPI management surface", () => {
  it("exposes exactly the seven management paths plus health", () => {
    expect(Object.keys(paths).sort()).toEqual(
      [
        "/api/v1/health",
        "/api/v1/inventory",
        "/api/v1/me/context",
        "/api/v1/me/tenants",
        "/api/v1/orders",
        "/api/v1/orders/{orderId}",
        "/api/v1/products",
        "/api/v1/products/{productId}",
      ].sort(),
    );
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
      "/api/v1/orders",
      "/api/v1/orders/{orderId}",
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
      "/api/v1/orders",
      "/api/v1/orders/{orderId}",
    ]) {
      const operation = (paths[managementRoute] as { get: { security?: unknown[] } }).get;
      expect(operation.security).toEqual([{ clerkSessionToken: [] }]);
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
      "OrderListResponse",
      "OrderDetailResponse",
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
