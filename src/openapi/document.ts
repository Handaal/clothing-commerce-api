import { z } from "zod";

import packageMetadata from "../../package.json";
import {
  ApiErrorSchema,
  HealthResponseSchema,
  InventoryBalanceSchema,
  InventoryListResponseSchema,
  MeContextResponseSchema,
  MeTenantSchema,
  OrderDetailResponseSchema,
  OrderListResponseSchema,
  OrderSummarySchema,
  PageInfoSchema,
  ProductDetailResponseSchema,
  ProductListResponseSchema,
  ProductSummarySchema,
} from "../contracts";

function jsonSchema(schema: z.ZodTypeAny) {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

const clerkSecurity = [{ clerkSessionToken: [] as string[] }];

const tenantHeaderParameter = { $ref: "#/components/parameters/TenantIdHeader" };

function errorResponses(...statuses: number[]) {
  const responses: Record<string, { $ref: string }> = {};
  for (const status of statuses) {
    responses[String(status)] = { $ref: `#/components/responses/Error${status}` };
  }
  return responses;
}

function limitParameter() {
  return {
    name: "limit",
    in: "query",
    required: false,
    description: "Maximum items per page (1-100, default 25).",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  };
}

function cursorParameter() {
  return {
    name: "cursor",
    in: "query",
    required: false,
    description: "Opaque forward-pagination cursor from a previous page's nextCursor.",
    schema: { type: "string" },
  };
}

function uuidQueryParameter(name: string, description: string) {
  return {
    name,
    in: "query",
    required: false,
    description,
    schema: { type: "string", format: "uuid" },
  };
}

function jsonResponse(description: string, schemaRef: string) {
  return {
    description,
    content: { "application/json": { schema: { $ref: schemaRef } } },
  };
}

export function generateOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Clothing Commerce API",
      version: packageMetadata.version,
    },
    tags: [
      { name: "me", description: "Identity bootstrap and permission context." },
      { name: "catalog", description: "Read-only product catalog." },
      { name: "inventory", description: "Read-only inventory balances." },
      { name: "orders", description: "Read-only orders and fulfillment progress." },
    ],
    paths: {
      "/api/v1/health": {
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
      },
      "/api/v1/me/tenants": {
        get: {
          operationId: "getMyTenants",
          tags: ["me"],
          summary: "List the caller's own selectable active tenants.",
          description:
            "Identity-scoped bootstrap. Requires only a valid session (no X-Tenant-Id) and returns " +
            "solely the verified caller's own active memberships against active tenants.",
          security: clerkSecurity,
          responses: {
            "200": jsonResponse(
              "The caller's active memberships and selectable tenants.",
              "#/components/schemas/MeTenants",
            ),
            ...errorResponses(401, 403, 500),
          },
        },
      },
      "/api/v1/me/context": {
        get: {
          operationId: "getMyContext",
          tags: ["me"],
          summary: "Read the caller's effective read capability for a tenant.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter],
          responses: {
            "200": jsonResponse(
              "The caller's permission-specific read context.",
              "#/components/schemas/MeContextResponse",
            ),
            ...errorResponses(400, 401, 403, 500),
          },
        },
      },
      "/api/v1/products": {
        get: {
          operationId: "listProducts",
          tags: ["catalog"],
          summary: "List products in the caller's catalog read scope.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            uuidQueryParameter("brandId", "Restrict to a single in-tenant brand."),
            {
              name: "status",
              in: "query",
              required: false,
              description: "Restrict to a product status.",
              schema: { type: "string", enum: ["draft", "active", "archived"] },
            },
            limitParameter(),
            cursorParameter(),
          ],
          responses: {
            "200": jsonResponse(
              "A page of product summaries.",
              "#/components/schemas/ProductListResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 500),
          },
        },
      },
      "/api/v1/products/{productId}": {
        get: {
          operationId: "getProduct",
          tags: ["catalog"],
          summary: "Read a single product's detail.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            {
              name: "productId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": jsonResponse(
              "The product detail.",
              "#/components/schemas/ProductDetailResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 500),
          },
        },
      },
      "/api/v1/inventory": {
        get: {
          operationId: "listInventory",
          tags: ["inventory"],
          summary: "List inventory balances in the caller's inventory read scope.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            uuidQueryParameter(
              "inventoryLocationId",
              "Restrict to a single in-tenant inventory location.",
            ),
            uuidQueryParameter("variantId", "Restrict to a single variant."),
            limitParameter(),
            cursorParameter(),
          ],
          responses: {
            "200": jsonResponse(
              "A page of inventory balances.",
              "#/components/schemas/InventoryListResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 500),
          },
        },
      },
      "/api/v1/orders": {
        get: {
          operationId: "listOrders",
          tags: ["orders"],
          summary: "List orders in the caller's orders read scope.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            {
              name: "channel",
              in: "query",
              required: false,
              description: "Restrict to a channel.",
              schema: { type: "string", enum: ["pos", "online"] },
            },
            uuidQueryParameter("brandId", "Restrict to a single in-tenant brand."),
            uuidQueryParameter("branchId", "Restrict to a single in-tenant branch."),
            {
              name: "status",
              in: "query",
              required: false,
              description: "Restrict to an order status.",
              schema: { type: "string", enum: ["placed", "cancelled"] },
            },
            limitParameter(),
            cursorParameter(),
          ],
          responses: {
            "200": jsonResponse(
              "A page of order summaries.",
              "#/components/schemas/OrderListResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 500),
          },
        },
      },
      "/api/v1/orders/{orderId}": {
        get: {
          operationId: "getOrder",
          tags: ["orders"],
          summary: "Read a single order's detail and fulfillment progress.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            {
              name: "orderId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": jsonResponse(
              "The order detail with embedded fulfillment progress.",
              "#/components/schemas/OrderDetailResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 500),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        clerkSessionToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Clerk session token presented as a Bearer credential.",
        },
      },
      parameters: {
        TenantIdHeader: {
          name: "X-Tenant-Id",
          in: "header",
          required: true,
          description: "The tenant the request operates within.",
          schema: { type: "string", format: "uuid" },
        },
      },
      responses: {
        Error400: jsonResponse("Invalid request.", "#/components/schemas/ApiError"),
        Error401: jsonResponse("Authentication is required.", "#/components/schemas/ApiError"),
        Error403: jsonResponse("The operation is not permitted.", "#/components/schemas/ApiError"),
        Error404: jsonResponse("The resource was not found.", "#/components/schemas/ApiError"),
        Error409: jsonResponse(
          "The request conflicts with current state.",
          "#/components/schemas/ApiError",
        ),
        Error422: jsonResponse(
          "The request was semantically rejected.",
          "#/components/schemas/ApiError",
        ),
        Error500: jsonResponse("An unexpected error occurred.", "#/components/schemas/ApiError"),
      },
      schemas: {
        HealthResponse: jsonSchema(HealthResponseSchema),
        ApiError: jsonSchema(ApiErrorSchema),
        PageInfo: jsonSchema(PageInfoSchema),
        MeTenants: jsonSchema(z.array(MeTenantSchema)),
        MeContextResponse: jsonSchema(MeContextResponseSchema),
        ProductSummary: jsonSchema(ProductSummarySchema),
        ProductListResponse: jsonSchema(ProductListResponseSchema),
        ProductDetailResponse: jsonSchema(ProductDetailResponseSchema),
        InventoryBalance: jsonSchema(InventoryBalanceSchema),
        InventoryListResponse: jsonSchema(InventoryListResponseSchema),
        OrderSummary: jsonSchema(OrderSummarySchema),
        OrderListResponse: jsonSchema(OrderListResponseSchema),
        OrderDetailResponse: jsonSchema(OrderDetailResponseSchema),
      },
    },
  };
}
