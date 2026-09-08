import { z } from "zod";

import packageMetadata from "../../package.json";
import {
  AdjustInventoryRequestSchema,
  AdjustInventoryResponseSchema,
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
  PosContextResponseSchema,
  CreatePosSaleRequestSchema,
  CreatePosSaleResponseSchema,
  EnrollPosDeviceRequestSchema,
  PosDeviceResponseSchema,
  RotatePosDeviceCredentialRequestSchema,
  RevokePosDeviceRequestSchema,
  OfflineBootstrapRequestSchema,
  OfflineBootstrapResponseSchema,
  IngestOfflineSaleRequestSchema,
  IngestOfflineSaleResponseSchema,
  ReceiveInventoryRequestSchema,
  ReceiveInventoryResponseSchema,
  TransferInventoryRequestSchema,
  TransferInventoryResponseSchema,
} from "../contracts";

function jsonSchema(schema: z.ZodTypeAny) {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

const clerkSecurity = [{ clerkSessionToken: [] as string[] }];

const tenantHeaderParameter = { $ref: "#/components/parameters/TenantIdHeader" };

const idempotencyKeyHeaderParameter = { $ref: "#/components/parameters/IdempotencyKeyHeader" };

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

function jsonRequestBody(description: string, schemaRef: string) {
  return {
    required: true,
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
      {
        name: "inventory",
        description:
          "Inventory balances (read) and management write operations: receive, adjust, transfer.",
      },
      { name: "orders", description: "Read-only orders and fulfillment progress." },
      { name: "pos", description: "Authorized register context and atomic POS checkout." },
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
      "/api/v1/inventory/receipts": {
        post: {
          operationId: "receiveInventory",
          tags: ["inventory"],
          summary: "Receive stock into an inventory location.",
          description:
            "Records received stock at a single in-tenant inventory location. Requires the " +
            "inventory.receive permission over the target location and a required Idempotency-Key " +
            "header; a replay with the same key and body is not applied twice, and the same key with a " +
            "different body is a 409.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter, idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "The receipt to record.",
            "#/components/schemas/ReceiveInventoryRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The recorded receipt and observed post-commit balance.",
              "#/components/schemas/ReceiveInventoryResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/inventory/adjustments": {
        post: {
          operationId: "adjustInventory",
          tags: ["inventory"],
          summary: "Reconcile an inventory count to a physically observed on-hand.",
          description:
            "Reconciles the balance at a single in-tenant inventory location to a counted on-hand, " +
            "guarded by the version it was counted against (optimistic concurrency). Requires the " +
            "inventory.adjust permission over the target location and a required Idempotency-Key " +
            "header. A stale expectedVersion is a 409; a same-key/different-body replay is a 409.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter, idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "The physical count to reconcile.",
            "#/components/schemas/AdjustInventoryRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The authoritative before/after balance for the reconciliation.",
              "#/components/schemas/AdjustInventoryResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/inventory/transfers": {
        post: {
          operationId: "transferInventory",
          tags: ["inventory"],
          summary: "Transfer stock between two inventory locations.",
          description:
            "Atomically moves stock from a source to a destination inventory location. Requires the " +
            "inventory.transfer permission over BOTH the source and the destination location and a " +
            "required Idempotency-Key header. Insufficient source stock is a 409; a same-key/" +
            "different-body replay is a 409.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter, idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "The transfer to record.",
            "#/components/schemas/TransferInventoryRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The recorded transfer and observed post-commit balances of both sides.",
              "#/components/schemas/TransferInventoryResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
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
      "/api/v1/pos/context": {
        get: {
          operationId: "getPosContext",
          tags: ["pos"],
          summary: "List active registers the caller is fully authorized to sell from.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter],
          responses: {
            "200": jsonResponse(
              "The caller's server-derived register selling contexts.",
              "#/components/schemas/PosContextResponse",
            ),
            ...errorResponses(400, 401, 403, 500),
          },
        },
      },
      "/api/v1/pos/sales": {
        post: {
          operationId: "createPosSale",
          tags: ["pos"],
          summary: "Atomically complete a cash POS sale.",
          description:
            "Creates one canonical POS Order, captured cash Payment, full Fulfillment, and inventory " +
            "issue in one transaction. Currency, branch, and location are derived from the Register. " +
            "A stale expectedTotalMinor returns PRICE_CHANGED before mutation. One Idempotency-Key " +
            "protects the complete sale intent.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter, idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "Register, expected total, received cash, and variant quantities.",
            "#/components/schemas/CreatePosSaleRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The completed atomic sale and its canonical components.",
              "#/components/schemas/CreatePosSaleResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/pos/devices": {
        post: {
          operationId: "enrollPosDevice",
          tags: ["pos"],
          summary: "Enroll and activate an offline-capable POS device.",
          description:
            "An authorized human binds a locally generated Ed25519 public key and installation to one tenant register. Private keys are never accepted.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter, idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "Device identity and public key.",
            "#/components/schemas/EnrollPosDeviceRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The active device credential.",
              "#/components/schemas/PosDeviceResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/pos/devices/{deviceId}/credentials": {
        post: {
          operationId: "rotatePosDeviceCredential",
          tags: ["pos"],
          summary: "Rotate an active POS device public key.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "deviceId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody(
            "Replacement public key and register authorization context.",
            "#/components/schemas/RotatePosDeviceCredentialRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The replacement credential.",
              "#/components/schemas/PosDeviceResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/pos/devices/{deviceId}/revoke": {
        post: {
          operationId: "revokePosDevice",
          tags: ["pos"],
          summary: "Revoke a POS device and its current credential.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "deviceId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody(
            "Revocation reason and register authorization context.",
            "#/components/schemas/RevokePosDeviceRequest",
          ),
          responses: {
            "200": jsonResponse("The revoked device.", "#/components/schemas/PosDeviceResponse"),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/pos/offline-bootstrap": {
        post: {
          operationId: "createOfflineBootstrap",
          tags: ["pos"],
          summary: "Issue a bounded immutable offline grant and complete catalog snapshot.",
          description:
            "Requires a normal authorized human session. No policy means offline selling is disabled. At most one device may hold active authority per inventory location.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter, idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "Enrolled device and register.",
            "#/components/schemas/OfflineBootstrapRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The grant and exact price snapshot.",
              "#/components/schemas/OfflineBootstrapResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/pos/offline-sales": {
        post: {
          operationId: "ingestOfflineSale",
          tags: ["pos"],
          summary: "Ingest a cash sale already accepted offline.",
          description:
            "Device-authenticated ingestion verifies canonical Ed25519 intent and historical grant prices. It returns synced when stock can be issued, otherwise persists the order/payment and a governed reconciliation. Idempotency records are retained indefinitely (minimum guaranteed queue window: 365 days).",
          security: [],
          parameters: [tenantHeaderParameter, idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "Signed immutable offline sale command.",
            "#/components/schemas/IngestOfflineSaleRequest",
          ),
          responses: {
            "200": jsonResponse(
              "Canonical ingestion result.",
              "#/components/schemas/IngestOfflineSaleResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
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
        IdempotencyKeyHeader: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description:
            "Caller-stable idempotency key for the write. A replay with the same key and body is not " +
            "applied twice; the same key with a different body is rejected with a 409.",
          schema: { type: "string", minLength: 1, maxLength: 200 },
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
        ReceiveInventoryRequest: jsonSchema(ReceiveInventoryRequestSchema),
        ReceiveInventoryResponse: jsonSchema(ReceiveInventoryResponseSchema),
        AdjustInventoryRequest: jsonSchema(AdjustInventoryRequestSchema),
        AdjustInventoryResponse: jsonSchema(AdjustInventoryResponseSchema),
        TransferInventoryRequest: jsonSchema(TransferInventoryRequestSchema),
        TransferInventoryResponse: jsonSchema(TransferInventoryResponseSchema),
        OrderSummary: jsonSchema(OrderSummarySchema),
        OrderListResponse: jsonSchema(OrderListResponseSchema),
        OrderDetailResponse: jsonSchema(OrderDetailResponseSchema),
        PosContextResponse: jsonSchema(PosContextResponseSchema),
        CreatePosSaleRequest: jsonSchema(CreatePosSaleRequestSchema),
        CreatePosSaleResponse: jsonSchema(CreatePosSaleResponseSchema),
        EnrollPosDeviceRequest: jsonSchema(EnrollPosDeviceRequestSchema),
        PosDeviceResponse: jsonSchema(PosDeviceResponseSchema),
        RotatePosDeviceCredentialRequest: jsonSchema(RotatePosDeviceCredentialRequestSchema),
        RevokePosDeviceRequest: jsonSchema(RevokePosDeviceRequestSchema),
        OfflineBootstrapRequest: jsonSchema(OfflineBootstrapRequestSchema),
        OfflineBootstrapResponse: jsonSchema(OfflineBootstrapResponseSchema),
        IngestOfflineSaleRequest: jsonSchema(IngestOfflineSaleRequestSchema),
        IngestOfflineSaleResponse: jsonSchema(IngestOfflineSaleResponseSchema),
      },
    },
  };
}
