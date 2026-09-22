import {
  SupplierSchema,
  SupplierSummarySchema,
  CreateSupplierRequestSchema,
  UpdateSupplierRequestSchema,
  SupplierListResponseSchema,
  SupplierReceiptSchema,
  SupplierReceiptsResponseSchema,
} from "../contracts/management/suppliers";
import {
  StaffSummarySchema,
  StaffDetailSchema,
  StaffListResponseSchema,
  EligibleIdentitySchema,
  EligibleIdentitiesResponseSchema,
  CreateStaffRequestSchema,
  UpdateStaffStatusRequestSchema,
  AssignStaffRoleRequestSchema,
  UnassignStaffRoleRequestSchema,
} from "../contracts/management/staff";
import {
  CreateReturnRequestSchema,
  SettleRefundRequestSchema,
  ReturnDetailResponseSchema,
  ReturnEligibilityResponseSchema,
  ReturnHistoryResponseSchema,
} from "../contracts/management/returns";
import { CheckoutRequestSchema, CheckoutResultSchema } from "../contracts/storefront/checkout";
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
  CreateProductRequestSchema,
  UpdateProductRequestSchema,
  SetProductStatusRequestSchema,
  ProductWriteResponseSchema,
  ProductUpdatedResponseSchema,
  PublishProductResponseSchema,
  UnpublishProductResponseSchema,
  CreateVariantRequestSchema,
  CreateVariantResponseSchema,
  SetVariantPriceRequestSchema,
  SetVariantPriceResponseSchema,
  CreateMediaUploadIntentRequestSchema,
  MediaUploadIntentResponseSchema,
  RegisterProductMediaRequestSchema,
  RegisterProductMediaResponseSchema,
  ArchiveProductMediaResponseSchema,
  PublicProductListResponseSchema,
  PublicProductDetailResponseSchema,
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
        name: "catalog-management",
        description:
          "Authenticated catalog authoring and Storefront publication: products, variants, prices, " +
          "media, and publish/unpublish.",
      },
      {
        name: "storefront",
        description: "Public, unauthenticated Storefront catalog: published products only.",
      },
      {
        name: "inventory",
        description:
          "Inventory balances (read) and management write operations: receive, adjust, transfer.",
      },
      {
        name: "suppliers",
        description: "Tenant-owned supplier management and canonical receiving history.",
      },
      {
        name: "staff",
        description:
          "Tenant staff (membership) management: list/detail, lifecycle, and role/scope assignment " +
          "over the existing identity + RBAC model. Not an HR/payroll domain.",
      },
      { name: "orders", description: "Read-only orders and fulfillment progress." },
      { name: "pos", description: "Authorized register context and atomic POS checkout." },
    ],
    paths: {
      "/api/v1/suppliers": {
        get: {
          operationId: "listSuppliers",
          tags: ["suppliers"],
          summary: "listSuppliers",
          description: "Requires a tenant-wide suppliers.read grant.",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 25,
              },
            },
            {
              name: "cursor",
              in: "query",
              schema: {
                type: "string",
                maxLength: 1000,
              },
              description:
                "Opaque forward cursor; invalid cursors fail closed. Stable UUID ascending order.",
            },
            {
              name: "search",
              in: "query",
              schema: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
              description: "Case-insensitive literal substring in name or code.",
            },
            {
              name: "status",
              in: "query",
              schema: {
                type: "string",
                enum: ["active", "inactive"],
              },
            },
          ],
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/SupplierListResponse",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
        },
        post: {
          operationId: "createSupplier",
          tags: ["suppliers"],
          summary: "createSupplier",
          description:
            "Requires a tenant-wide suppliers.manage grant and Idempotency-Key. Exact replay returns the original response; changed intent conflicts.",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              $ref: "#/components/parameters/IdempotencyKeyHeader",
            },
          ],
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Supplier",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CreateSupplierRequest",
                },
              },
            },
          },
        },
      },
      "/api/v1/suppliers/{supplierId}": {
        get: {
          operationId: "getSupplier",
          tags: ["suppliers"],
          summary: "getSupplier",
          description: "Requires a tenant-wide suppliers.read grant.",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              name: "supplierId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                format: "uuid",
              },
            },
          ],
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Supplier",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
        },
        patch: {
          operationId: "updateSupplier",
          tags: ["suppliers"],
          summary: "updateSupplier",
          description:
            "Requires a tenant-wide suppliers.manage grant and Idempotency-Key. Exact replay returns the original response; changed intent conflicts. PATCH status active/inactive implements activation/deactivation. Nullable optional fields may be cleared with null. No DELETE exists.",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              name: "supplierId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                format: "uuid",
              },
            },
            {
              $ref: "#/components/parameters/IdempotencyKeyHeader",
            },
          ],
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Supplier",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/UpdateSupplierRequest",
                },
              },
            },
          },
        },
      },
      "/api/v1/suppliers/{supplierId}/receipts": {
        get: {
          operationId: "listSupplierReceipts",
          tags: ["suppliers"],
          summary: "listSupplierReceipts",
          description:
            "Requires a tenant-wide suppliers.read grant. Also requires inventory.read; results include only operations entirely within the caller's inventory location visibility. Supplier name/code are immutable receipt snapshots; product/location display names are current.",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              name: "supplierId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                format: "uuid",
              },
            },
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 25,
              },
            },
            {
              name: "cursor",
              in: "query",
              schema: {
                type: "string",
                maxLength: 1000,
              },
              description:
                "Opaque forward cursor; invalid cursors fail closed. Stable UUID ascending order.",
            },
          ],
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/SupplierReceiptsResponse",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
        },
      },
      "/api/v1/staff": {
        get: {
          operationId: "listStaff",
          tags: ["staff"],
          summary: "listStaff",
          description: "Requires a tenant-wide staff.read grant.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            limitParameter(),
            cursorParameter(),
            {
              name: "search",
              in: "query",
              required: false,
              description: "Case-insensitive literal substring in identity display name or email.",
              schema: { type: "string", minLength: 1, maxLength: 200 },
            },
            {
              name: "status",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["invited", "active", "suspended", "deactivated"],
              },
            },
            uuidQueryParameter("roleId", "Filter to memberships currently assigned this role."),
          ],
          responses: {
            "200": jsonResponse("Success", "#/components/schemas/StaffListResponse"),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
        post: {
          operationId: "createStaff",
          tags: ["staff"],
          summary: "createStaff",
          description:
            "Requires a tenant-wide staff.manage grant and Idempotency-Key. Creates an active " +
            "membership for an already-provisioned identity; there is no invitation delivery. Exact " +
            "replay returns the original response; changed intent conflicts.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter, idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "Identity to link.",
            "#/components/schemas/CreateStaffRequest",
          ),
          responses: {
            "200": jsonResponse("Success", "#/components/schemas/StaffDetail"),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/staff/eligible-identities": {
        get: {
          operationId: "findEligibleStaffIdentitiesByEmail",
          tags: ["staff"],
          summary: "findEligibleStaffIdentitiesByEmail",
          description:
            "Requires a tenant-wide staff.manage grant. Resolves an existing account by EXACT email " +
            "(case-insensitive, trimmed) so a manager can add it as staff — this is a confirmation " +
            "lookup, NOT a browsable directory: there is no display-name, partial, substring, or " +
            "wildcard search, and no pagination. Returns already-provisioned, active identities that " +
            "do not yet hold a membership in this tenant, with a minimal projection; never reveals " +
            "other tenants' membership relationships. An unknown email, an inactive identity, and an " +
            "already-a-member identity are indistinguishable (all return an empty list). Because " +
            "primary_email is not unique, the response is an explicit 0..N list ordered by identity id " +
            "ascending (bounded to 50 exact matches): 0 items = no eligible account; 1 item = an " +
            "unambiguous account; more than 1 = multiple provisioned identities share the exact email, " +
            "and the client MUST require explicit selection and MUST NOT silently choose one (the " +
            "server never collapses or prefers a match). Does not create identities or send invitations.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            {
              name: "email",
              in: "query",
              required: true,
              description:
                "Exact email of the existing account to link (trimmed, case-insensitive).",
              schema: { type: "string", minLength: 1, maxLength: 320 },
            },
          ],
          responses: {
            "200": jsonResponse("Success", "#/components/schemas/EligibleIdentitiesResponse"),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/staff/{membershipId}": {
        get: {
          operationId: "getStaffMember",
          tags: ["staff"],
          summary: "getStaffMember",
          description: "Requires a tenant-wide staff.read grant.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            {
              name: "membershipId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": jsonResponse("Success", "#/components/schemas/StaffDetail"),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
        patch: {
          operationId: "updateStaffStatus",
          tags: ["staff"],
          summary: "updateStaffStatus",
          description:
            "Requires a tenant-wide staff.manage grant and Idempotency-Key. Transitions membership " +
            "lifecycle (activate/suspend/revoke). Revoked (deactivated) is terminal. The last active " +
            "staff.manage membership cannot be suspended or revoked.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            {
              name: "membershipId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            idempotencyKeyHeaderParameter,
          ],
          requestBody: jsonRequestBody(
            "Target lifecycle status.",
            "#/components/schemas/UpdateStaffStatusRequest",
          ),
          responses: {
            "200": jsonResponse("Success", "#/components/schemas/StaffDetail"),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/staff/{membershipId}/role-assignments": {
        post: {
          operationId: "assignStaffRole",
          tags: ["staff"],
          summary: "assignStaffRole",
          description:
            "Requires a tenant-wide staff.manage grant and Idempotency-Key. Assigns an existing tenant " +
            "role + access scope to the membership. Anti-escalation: the role's permission set must be a " +
            "subset of the caller's own current tenant-wide permissions.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            {
              name: "membershipId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            idempotencyKeyHeaderParameter,
          ],
          requestBody: jsonRequestBody(
            "Role and access scope to assign.",
            "#/components/schemas/AssignStaffRoleRequest",
          ),
          responses: {
            "200": jsonResponse("Success", "#/components/schemas/StaffDetail"),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/staff/{membershipId}/role-assignments/{assignmentId}": {
        delete: {
          operationId: "unassignStaffRole",
          tags: ["staff"],
          summary: "unassignStaffRole",
          description:
            "Requires a tenant-wide staff.manage grant and Idempotency-Key. Revokes an active " +
            "assignment (history-preserving; never deleted). Cannot strand the tenant's last active " +
            "staff.manage membership.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            {
              name: "membershipId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "assignmentId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            idempotencyKeyHeaderParameter,
          ],
          requestBody: jsonRequestBody(
            "Optional unassignment reason.",
            "#/components/schemas/UnassignStaffRoleRequest",
          ),
          responses: {
            "200": jsonResponse("Success", "#/components/schemas/StaffDetail"),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/orders/{orderId}/return-eligibility": {
        get: {
          operationId: "getReturnEligibility",
          tags: ["returns"],
          summary: "getReturnEligibility",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              name: "orderId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                format: "uuid",
              },
            },
          ],
          responses: {
            "200": {
              description: "Canonical return state.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ReturnEligibilityResponse",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
        },
      },
      "/api/v1/orders/{orderId}/returns": {
        get: {
          operationId: "listReturns",
          tags: ["returns"],
          summary: "listReturns",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              name: "orderId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                format: "uuid",
              },
            },
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 25,
              },
            },
            {
              name: "cursor",
              in: "query",
              schema: {
                type: "string",
                format: "uuid",
              },
            },
          ],
          responses: {
            "200": {
              description: "Canonical return state.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ReturnHistoryResponse",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
        },
        post: {
          operationId: "createReturn",
          tags: ["returns"],
          summary: "Accept received merchandise and initiate its server-calculated refund.",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              name: "orderId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                format: "uuid",
              },
            },
            {
              $ref: "#/components/parameters/IdempotencyKeyHeader",
            },
          ],
          responses: {
            "200": {
              description: "Canonical return state.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ReturnDetailResponse",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CreateReturnRequest",
                },
              },
            },
          },
        },
      },
      "/api/v1/returns/{returnId}": {
        get: {
          operationId: "getReturn",
          tags: ["returns"],
          summary: "getReturn",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              name: "returnId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                format: "uuid",
              },
            },
          ],
          responses: {
            "200": {
              description: "Canonical return state.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ReturnDetailResponse",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
        },
      },
      "/api/v1/returns/{returnId}/refund": {
        post: {
          operationId: "settleRefund",
          tags: ["returns"],
          summary: "Attest an actual manual cash refund. Electronic settlement is not supported.",
          security: [
            {
              clerkSessionToken: [],
            },
          ],
          parameters: [
            {
              $ref: "#/components/parameters/TenantIdHeader",
            },
            {
              name: "returnId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                format: "uuid",
              },
            },
            {
              $ref: "#/components/parameters/IdempotencyKeyHeader",
            },
          ],
          responses: {
            "200": {
              description: "Canonical return state.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ReturnDetailResponse",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/Error400",
            },
            "401": {
              $ref: "#/components/responses/Error401",
            },
            "403": {
              $ref: "#/components/responses/Error403",
            },
            "404": {
              $ref: "#/components/responses/Error404",
            },
            "409": {
              $ref: "#/components/responses/Error409",
            },
            "422": {
              $ref: "#/components/responses/Error422",
            },
            "500": {
              $ref: "#/components/responses/Error500",
            },
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/SettleRefundRequest",
                },
              },
            },
          },
        },
      },
      "/api/v1/storefront/checkout": {
        post: {
          operationId: "checkout",
          summary: "Place a guest online order with authoritative pricing and stock reservations.",
          description:
            "Public configured tenant/brand context. Requires a stable Idempotency-Key. COD is enabled only by server-owned routing configuration; payment stays pending. PRICE_CHANGED returns the current total in error.details[0].value before business mutation. Exact replay returns the original placement result, not live order status.",
          tags: ["Storefront"],
          security: [],
          parameters: [idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "Customer purchase intent",
            "#/components/schemas/CheckoutRequest",
          ),
          responses: {
            "200": jsonResponse(
              "Canonical online order placement result",
              "#/components/schemas/CheckoutResult",
            ),
            ...errorResponses(400, 409, 422, 500),
          },
        },
      },
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
        post: {
          operationId: "createProduct",
          tags: ["catalog-management"],
          summary: "Create a product in a brand.",
          description:
            "Creates a draft product in the target brand. Requires catalog.author over the brand and a " +
            "required Idempotency-Key header; a replay with the same key and body returns the original " +
            "product, and the same key with a different body is a 409.",
          security: clerkSecurity,
          parameters: [tenantHeaderParameter, idempotencyKeyHeaderParameter],
          requestBody: jsonRequestBody(
            "The product to create.",
            "#/components/schemas/CreateProductRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The created product identity and lifecycle state.",
              "#/components/schemas/ProductWriteResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
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
        patch: {
          operationId: "updateProduct",
          tags: ["catalog-management"],
          summary: "Update a product's editable fields.",
          description:
            "Replaces the product's name, slug, style code, and description. Requires catalog.author " +
            "over the product's brand and a required Idempotency-Key header.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "productId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody(
            "The updated product fields.",
            "#/components/schemas/UpdateProductRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The updated product identity.",
              "#/components/schemas/ProductUpdatedResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/products/{productId}/status": {
        post: {
          operationId: "setProductStatus",
          tags: ["catalog-management"],
          summary: "Change a product's internal lifecycle status.",
          description:
            "Activates, deactivates (active to draft), or archives a product. A published product " +
            "cannot be deactivated (unpublish first); archiving force-unpublishes. Requires " +
            "catalog.author over the product's brand and a required Idempotency-Key header.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "productId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody(
            "The target lifecycle status.",
            "#/components/schemas/SetProductStatusRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The product's new lifecycle and publication state.",
              "#/components/schemas/ProductWriteResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/products/{productId}/publication": {
        post: {
          operationId: "publishProduct",
          tags: ["catalog-management"],
          summary: "Publish a product to the Storefront.",
          description:
            "Publishes an active product that has at least one active, priced variant. Requires the " +
            "distinct catalog.publish permission over the product's brand and a required " +
            "Idempotency-Key header. A structurally unsellable product is a 422.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "productId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody("An empty object.", "#/components/schemas/EmptyRequest"),
          responses: {
            "200": jsonResponse(
              "The product's published state.",
              "#/components/schemas/PublishProductResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
        delete: {
          operationId: "unpublishProduct",
          tags: ["catalog-management"],
          summary: "Unpublish a product from the Storefront.",
          description:
            "Removes a product from the public Storefront while leaving its canonical catalog state " +
            "intact. Requires catalog.publish over the product's brand and a required Idempotency-Key " +
            "header.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "productId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody("An empty object.", "#/components/schemas/EmptyRequest"),
          responses: {
            "200": jsonResponse(
              "The product's unpublished state.",
              "#/components/schemas/UnpublishProductResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/products/{productId}/variants": {
        post: {
          operationId: "createVariant",
          tags: ["catalog-management"],
          summary: "Create a variant under a product.",
          description:
            "Creates an active variant with a unique SKU. Requires catalog.author over the product's " +
            "brand and a required Idempotency-Key header; a duplicate SKU is a 409.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "productId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody(
            "The variant to create.",
            "#/components/schemas/CreateVariantRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The created variant identity.",
              "#/components/schemas/CreateVariantResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/variants/{variantId}/price": {
        put: {
          operationId: "setVariantPrice",
          tags: ["catalog-management"],
          summary: "Set a variant's active base price for a currency.",
          description:
            "Writes a new active price in minor units and archives the prior active price for that " +
            "currency (history retained). Requires catalog.author over the variant's brand and a " +
            "required Idempotency-Key header.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "variantId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody(
            "The currency and minor-unit amount.",
            "#/components/schemas/SetVariantPriceRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The new active price.",
              "#/components/schemas/SetVariantPriceResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/products/{productId}/media/upload-intent": {
        post: {
          operationId: "createProductMediaUploadIntent",
          tags: ["catalog-management"],
          summary: "Authorize a product media upload and get a server-controlled destination.",
          description:
            "Returns a tenant/product-scoped storage bucket and path (and a signed upload URL when " +
            "object storage is reachable). The client can never choose an arbitrary destination. " +
            "Requires catalog.author over the product's brand. This is not a durable mutation and " +
            "requires no Idempotency-Key.",
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
          requestBody: jsonRequestBody(
            "The intended content type and optional variant/file name.",
            "#/components/schemas/CreateMediaUploadIntentRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The authorized upload destination.",
              "#/components/schemas/MediaUploadIntentResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 500),
          },
        },
      },
      "/api/v1/products/{productId}/media": {
        post: {
          operationId: "registerProductMedia",
          tags: ["catalog-management"],
          summary: "Register a product media reference.",
          description:
            "Records an object-storage reference (never a binary) for a product, optionally scoped to " +
            "a variant, optionally marked primary. Requires catalog.author over the product's brand " +
            "and a required Idempotency-Key header.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "productId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody(
            "The media reference to register.",
            "#/components/schemas/RegisterProductMediaRequest",
          ),
          responses: {
            "200": jsonResponse(
              "The registered media identity.",
              "#/components/schemas/RegisterProductMediaResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/products/{productId}/media/{mediaId}": {
        delete: {
          operationId: "archiveProductMedia",
          tags: ["catalog-management"],
          summary: "Archive a product media reference.",
          description:
            "Soft-archives a media reference (never a hard delete). Requires catalog.author over the " +
            "media's brand and a required Idempotency-Key header.",
          security: clerkSecurity,
          parameters: [
            tenantHeaderParameter,
            idempotencyKeyHeaderParameter,
            {
              name: "productId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "mediaId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: jsonRequestBody("An empty object.", "#/components/schemas/EmptyRequest"),
          responses: {
            "200": jsonResponse(
              "The archived media identity.",
              "#/components/schemas/ArchiveProductMediaResponse",
            ),
            ...errorResponses(400, 401, 403, 404, 409, 422, 500),
          },
        },
      },
      "/api/v1/storefront/products": {
        get: {
          operationId: "listPublishedProducts",
          tags: ["storefront"],
          summary: "List published products for a storefront tenant.",
          description:
            "Public, unauthenticated. Returns only published, publicly sellable products for the " +
            "given tenant (optionally narrowed to a brand). No internal lifecycle, cost, exact stock, " +
            "or unpublished data is ever returned.",
          parameters: [
            {
              name: "tenantId",
              in: "query",
              required: true,
              description: "The tenant the storefront serves.",
              schema: { type: "string", format: "uuid" },
            },
            uuidQueryParameter("brandId", "Restrict to a single in-tenant brand."),
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Maximum products (1-200, default 50).",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            "200": jsonResponse(
              "A list of published products.",
              "#/components/schemas/PublicProductListResponse",
            ),
            ...errorResponses(400, 500),
          },
        },
      },
      "/api/v1/storefront/products/{slug}": {
        get: {
          operationId: "getPublishedProduct",
          tags: ["storefront"],
          summary: "Read a single published product by slug.",
          description:
            "Public, unauthenticated. Returns the published product for the given tenant and slug, or " +
            "404 if it is missing or unpublished.",
          parameters: [
            {
              name: "tenantId",
              in: "query",
              required: true,
              description: "The tenant the storefront serves.",
              schema: { type: "string", format: "uuid" },
            },
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": jsonResponse(
              "The published product detail.",
              "#/components/schemas/PublicProductDetailResponse",
            ),
            ...errorResponses(400, 404, 500),
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
        Supplier: jsonSchema(SupplierSchema),
        SupplierSummary: jsonSchema(SupplierSummarySchema),
        CreateSupplierRequest: jsonSchema(CreateSupplierRequestSchema),
        UpdateSupplierRequest: jsonSchema(UpdateSupplierRequestSchema),
        SupplierListResponse: jsonSchema(SupplierListResponseSchema),
        SupplierReceipt: jsonSchema(SupplierReceiptSchema),
        SupplierReceiptsResponse: jsonSchema(SupplierReceiptsResponseSchema),

        StaffSummary: jsonSchema(StaffSummarySchema),
        StaffDetail: jsonSchema(StaffDetailSchema),
        StaffListResponse: jsonSchema(StaffListResponseSchema),
        EligibleIdentity: jsonSchema(EligibleIdentitySchema),
        EligibleIdentitiesResponse: jsonSchema(EligibleIdentitiesResponseSchema),
        CreateStaffRequest: jsonSchema(CreateStaffRequestSchema),
        UpdateStaffStatusRequest: jsonSchema(UpdateStaffStatusRequestSchema),
        AssignStaffRoleRequest: jsonSchema(AssignStaffRoleRequestSchema),
        UnassignStaffRoleRequest: jsonSchema(UnassignStaffRoleRequestSchema),

        CreateReturnRequest: jsonSchema(CreateReturnRequestSchema),
        SettleRefundRequest: jsonSchema(SettleRefundRequestSchema),
        ReturnDetailResponse: jsonSchema(ReturnDetailResponseSchema),
        ReturnEligibilityResponse: jsonSchema(ReturnEligibilityResponseSchema),
        ReturnHistoryResponse: jsonSchema(ReturnHistoryResponseSchema),

        CheckoutRequest: jsonSchema(CheckoutRequestSchema),
        CheckoutResult: jsonSchema(CheckoutResultSchema),
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
        EmptyRequest: { type: "object", additionalProperties: false },
        CreateProductRequest: jsonSchema(CreateProductRequestSchema),
        UpdateProductRequest: jsonSchema(UpdateProductRequestSchema),
        SetProductStatusRequest: jsonSchema(SetProductStatusRequestSchema),
        ProductWriteResponse: jsonSchema(ProductWriteResponseSchema),
        ProductUpdatedResponse: jsonSchema(ProductUpdatedResponseSchema),
        PublishProductResponse: jsonSchema(PublishProductResponseSchema),
        UnpublishProductResponse: jsonSchema(UnpublishProductResponseSchema),
        CreateVariantRequest: jsonSchema(CreateVariantRequestSchema),
        CreateVariantResponse: jsonSchema(CreateVariantResponseSchema),
        SetVariantPriceRequest: jsonSchema(SetVariantPriceRequestSchema),
        SetVariantPriceResponse: jsonSchema(SetVariantPriceResponseSchema),
        CreateMediaUploadIntentRequest: jsonSchema(CreateMediaUploadIntentRequestSchema),
        MediaUploadIntentResponse: jsonSchema(MediaUploadIntentResponseSchema),
        RegisterProductMediaRequest: jsonSchema(RegisterProductMediaRequestSchema),
        RegisterProductMediaResponse: jsonSchema(RegisterProductMediaResponseSchema),
        ArchiveProductMediaResponse: jsonSchema(ArchiveProductMediaResponseSchema),
        PublicProductListResponse: jsonSchema(PublicProductListResponseSchema),
        PublicProductDetailResponse: jsonSchema(PublicProductDetailResponseSchema),
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
