import {
  SupplierSchema,
  SupplierListResponseSchema,
  SupplierReceiptsResponseSchema,
  type Supplier,
  type SupplierListResponse,
  type SupplierReceiptsResponse,
  type SupplierStatus,
  type CreateSupplierRequest,
  type UpdateSupplierRequest,
} from "../../../src/contracts/management/suppliers";
export type {
  Supplier,
  SupplierSummary,
  SupplierStatus,
  SupplierListResponse,
  SupplierReceipt,
  SupplierReceiptsResponse,
  CreateSupplierRequest,
  UpdateSupplierRequest,
} from "../../../src/contracts/management/suppliers";
export interface SupplierListQuery {
  search?: string;
  status?: SupplierStatus;
  limit?: number;
  cursor?: string;
}
export interface SupplierReceiptsQuery {
  limit?: number;
  cursor?: string;
}
export type CreateSupplierInput = CreateSupplierRequest & IdempotentWrite;
export type UpdateSupplierInput = UpdateSupplierRequest & IdempotentWrite & { supplierId: string };
import {
  StaffDetailSchema,
  StaffListResponseSchema,
  EligibleIdentitiesResponseSchema,
  type StaffDetail,
  type StaffListResponse,
  type StaffStatus,
  type EligibleIdentitiesResponse,
  type CreateStaffRequest,
  type UpdateStaffStatusRequest,
  type AssignStaffRoleRequest,
} from "../../../src/contracts/management/staff";
export type {
  StaffSummary,
  StaffDetail,
  StaffStatus,
  StaffStatusTarget,
  StaffRoleRef,
  StaffScopeTarget,
  StaffAssignment,
  StaffListResponse,
  EligibleIdentity,
  EligibleIdentitiesResponse,
  CreateStaffRequest,
  UpdateStaffStatusRequest,
  AssignStaffRoleRequest,
  UnassignStaffRoleRequest,
} from "../../../src/contracts/management/staff";
export interface StaffListQuery {
  search?: string;
  status?: StaffStatus;
  roleId?: string;
  limit?: number;
  cursor?: string;
}
/**
 * Add-Staff identity resolution is an EXACT-email lookup, not a directory search — the only input is the
 * email of the account to link. There is deliberately no name, partial, or wildcard search and no
 * pagination.
 */
export interface EligibleStaffIdentityLookup {
  email: string;
}
export type CreateStaffInput = CreateStaffRequest & IdempotentWrite;
export type UpdateStaffStatusInput = UpdateStaffStatusRequest &
  IdempotentWrite & { membershipId: string };
export type AssignStaffRoleInput = AssignStaffRoleRequest &
  IdempotentWrite & { membershipId: string };
export interface UnassignStaffRoleInput extends IdempotentWrite {
  membershipId: string;
  assignmentId: string;
  reason?: string;
}
import {
  CheckoutResultSchema,
  type CheckoutRequest,
  type CheckoutResult,
} from "../../../src/contracts/storefront/checkout";
export type {
  CheckoutRequest,
  CheckoutResult,
  OrderCommerceDetails,
} from "../../../src/contracts/storefront/checkout";
import {
  AdjustInventoryResponseSchema,
  ApiErrorSchema,
  HealthResponseSchema,
  InventoryListResponseSchema,
  MeContextResponseSchema,
  MeTenantsResponseSchema,
  OrderDetailResponseSchema,
  OrderListResponseSchema,
  ProductDetailResponseSchema,
  ProductListResponseSchema,
  PosContextResponseSchema,
  CreatePosSaleResponseSchema,
  PosDeviceResponseSchema,
  OfflineBootstrapResponseSchema,
  IngestOfflineSaleResponseSchema,
  ReceiveInventoryResponseSchema,
  TransferInventoryResponseSchema,
  ProductWriteResponseSchema,
  ProductUpdatedResponseSchema,
  PublishProductResponseSchema,
  UnpublishProductResponseSchema,
  CreateVariantResponseSchema,
  SetVariantPriceResponseSchema,
  MediaUploadIntentResponseSchema,
  RegisterProductMediaResponseSchema,
  ArchiveProductMediaResponseSchema,
  PublicProductListResponseSchema,
  PublicProductDetailResponseSchema,
  type ProductWriteResponse,
  type ProductUpdatedResponse,
  type PublishProductResponse,
  type UnpublishProductResponse,
  type CreateVariantResponse,
  type SetVariantPriceResponse,
  type MediaUploadIntentResponse,
  type RegisterProductMediaResponse,
  type ArchiveProductMediaResponse,
  type PublicProduct,
  type PublicProductListResponse,
  type PublicProductDetailResponse,
  type StorefrontStatus,
  type AdjustInventoryResponse,
  type HealthResponse,
  type InventoryListResponse,
  type MeContextResponse,
  type MeTenantsResponse,
  type OrderChannel,
  type OrderDetailResponse,
  type OrderListResponse,
  type OrderStatus,
  type ProductDetailResponse,
  type ProductListResponse,
  type ProductStatus,
  type PosContextResponse,
  type CreatePosSaleResponse,
  type EnrollPosDeviceRequest,
  type PosDeviceResponse,
  type OfflineBootstrapRequest,
  type OfflineBootstrapResponse,
  type OfflineSaleCommand,
  type IngestOfflineSaleRequest,
  type IngestOfflineSaleResponse,
  type ReceiveInventoryResponse,
  type TransferInventoryResponse,
} from "../../../src/contracts";
export { canonicalizeOfflineSaleCommand } from "../../../src/contracts";
import packageMetadata from "../package.json";
import type { z } from "zod";

export const SDK_VERSION = packageMetadata.version;

export type ClientType = "pos-desktop" | "storefront" | "admin-mobile";

export interface ClientMetadata {
  type: ClientType;
  version: string;
}

/** Injection seam for the Clerk user/session token. The SDK never owns Clerk UI or session state. */
export type TokenProvider = () => Promise<string | null | undefined> | string | null | undefined;

export interface CommerceClientOptions {
  baseUrl: string;
  client?: ClientMetadata;
  getToken?: TokenProvider;
  fetch?: typeof globalThis.fetch;
}

export interface ProductListQuery {
  brandId?: string;
  status?: ProductStatus;
  limit?: number;
  cursor?: string;
}

export interface InventoryListQuery {
  inventoryLocationId?: string;
  variantId?: string;
  limit?: number;
  cursor?: string;
}

export interface OrderListQuery {
  channel?: OrderChannel;
  brandId?: string;
  branchId?: string;
  status?: OrderStatus;
  limit?: number;
  cursor?: string;
}

/**
 * Idempotency is a required, explicit part of every inventory write. The caller supplies a stable key
 * per logical intent; the SDK sends it as the Idempotency-Key header. A replay with the same key and
 * body is not applied twice; the same key with a different body is rejected by the API with a 409.
 */
export interface IdempotentWrite {
  idempotencyKey: string;
}

export interface ReceiveInventoryInput extends IdempotentWrite {
  supplierId?: string;
  supplierReference?: string;
  variantId: string;
  inventoryLocationId: string;
  quantity: number;
  note?: string;
}

export interface AdjustInventoryInput extends IdempotentWrite {
  variantId: string;
  inventoryLocationId: string;
  countedQuantity: number;
  expectedVersion: number;
  note?: string;
}

export interface TransferInventoryInput extends IdempotentWrite {
  variantId: string;
  sourceInventoryLocationId: string;
  destinationInventoryLocationId: string;
  quantity: number;
  note?: string;
}

export interface CreatePosSaleInput extends IdempotentWrite {
  registerId: string;
  expectedTotalMinor: number;
  cashReceivedMinor: number;
  lines: ReadonlyArray<{ variantId: string; quantity: number }>;
}

export interface EnrollPosDeviceInput extends EnrollPosDeviceRequest, IdempotentWrite {}
export interface RotatePosDeviceCredentialInput extends IdempotentWrite {
  deviceId: string;
  registerId: string;
  publicKey: { algorithm: "Ed25519"; encoding: "spki_der_base64"; value: string };
}
export interface RevokePosDeviceInput extends IdempotentWrite {
  deviceId: string;
  registerId: string;
  reason: string;
}
export interface OfflineBootstrapInput extends OfflineBootstrapRequest, IdempotentWrite {}
export interface IngestOfflineSaleInput extends IngestOfflineSaleRequest, IdempotentWrite {}

// ---- Phase 2J catalog management inputs ----
export interface CreateProductInput extends IdempotentWrite {
  brandId: string;
  name: string;
  slug: string;
  styleCode?: string;
  description?: string;
}
export interface UpdateProductInput extends IdempotentWrite {
  productId: string;
  name: string;
  slug: string;
  styleCode?: string;
  description?: string;
}
export interface SetProductStatusInput extends IdempotentWrite {
  productId: string;
  status: ProductStatus;
  archiveReason?: string;
}
export interface PublishProductInput extends IdempotentWrite {
  productId: string;
}
export interface CreateVariantInput extends IdempotentWrite {
  productId: string;
  sku: string;
  displayName?: string;
}
export interface SetVariantPriceInput extends IdempotentWrite {
  variantId: string;
  currency: string;
  amountMinor: number;
}
export interface CreateProductMediaUploadIntentInput {
  productId: string;
  variantId?: string;
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  fileName?: string;
}
export interface RegisterProductMediaInput extends IdempotentWrite {
  productId: string;
  variantId?: string;
  bucket: string;
  path: string;
  altText?: string;
  position?: number;
  isPrimary?: boolean;
}
export interface ArchiveProductMediaInput extends IdempotentWrite {
  productId: string;
  mediaId: string;
}

export interface PublicCatalogListQuery {
  tenantId: string;
  brandId?: string;
  limit?: number;
}
export interface PublicProductQuery {
  tenantId: string;
  slug: string;
}

/** Tenant-scoped management surface, obtained via `client.withTenant(tenantId)`. */
export interface TenantCommerceClient {
  readonly tenantId: string;
  getContext(): Promise<MeContextResponse>;
  listProducts(query?: ProductListQuery): Promise<ProductListResponse>;
  getProduct(productId: string): Promise<ProductDetailResponse>;
  createProduct(input: CreateProductInput): Promise<ProductWriteResponse>;
  updateProduct(input: UpdateProductInput): Promise<ProductUpdatedResponse>;
  setProductStatus(input: SetProductStatusInput): Promise<ProductWriteResponse>;
  publishProduct(input: PublishProductInput): Promise<PublishProductResponse>;
  unpublishProduct(input: PublishProductInput): Promise<UnpublishProductResponse>;
  createVariant(input: CreateVariantInput): Promise<CreateVariantResponse>;
  setVariantPrice(input: SetVariantPriceInput): Promise<SetVariantPriceResponse>;
  createProductMediaUploadIntent(
    input: CreateProductMediaUploadIntentInput,
  ): Promise<MediaUploadIntentResponse>;
  registerProductMedia(input: RegisterProductMediaInput): Promise<RegisterProductMediaResponse>;
  archiveProductMedia(input: ArchiveProductMediaInput): Promise<ArchiveProductMediaResponse>;
  listInventory(query?: InventoryListQuery): Promise<InventoryListResponse>;
  listSuppliers(query?: SupplierListQuery): Promise<SupplierListResponse>;
  getSupplier(supplierId: string): Promise<Supplier>;
  createSupplier(input: CreateSupplierInput): Promise<Supplier>;
  updateSupplier(input: UpdateSupplierInput): Promise<Supplier>;
  listSupplierReceipts(
    supplierId: string,
    query?: SupplierReceiptsQuery,
  ): Promise<SupplierReceiptsResponse>;
  listStaff(query?: StaffListQuery): Promise<StaffListResponse>;
  findEligibleStaffIdentitiesByEmail(
    lookup: EligibleStaffIdentityLookup,
  ): Promise<EligibleIdentitiesResponse>;
  getStaffMember(membershipId: string): Promise<StaffDetail>;
  createStaff(input: CreateStaffInput): Promise<StaffDetail>;
  updateStaffStatus(input: UpdateStaffStatusInput): Promise<StaffDetail>;
  assignStaffRole(input: AssignStaffRoleInput): Promise<StaffDetail>;
  unassignStaffRole(input: UnassignStaffRoleInput): Promise<StaffDetail>;
  receiveInventory(input: ReceiveInventoryInput): Promise<ReceiveInventoryResponse>;
  adjustInventory(input: AdjustInventoryInput): Promise<AdjustInventoryResponse>;
  transferInventory(input: TransferInventoryInput): Promise<TransferInventoryResponse>;
  listOrders(query?: OrderListQuery): Promise<OrderListResponse>;
  getOrder(orderId: string): Promise<OrderDetailResponse>;
  getReturnEligibility(orderId: string): Promise<ReturnEligibilityResponse>;
  listReturns(
    orderId: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<ReturnHistoryResponse>;
  getReturn(returnId: string): Promise<ReturnDetailResponse>;
  createReturn(input: CreateReturnInput): Promise<ReturnDetailResponse>;
  settleRefund(input: SettleRefundInput): Promise<ReturnDetailResponse>;
  getPosContext(): Promise<PosContextResponse>;
  createPosSale(input: CreatePosSaleInput): Promise<CreatePosSaleResponse>;
  enrollPosDevice(input: EnrollPosDeviceInput): Promise<PosDeviceResponse>;
  rotatePosDeviceCredential(input: RotatePosDeviceCredentialInput): Promise<PosDeviceResponse>;
  revokePosDevice(input: RevokePosDeviceInput): Promise<PosDeviceResponse>;
  createOfflineBootstrap(input: OfflineBootstrapInput): Promise<OfflineBootstrapResponse>;
  ingestOfflineSale(input: IngestOfflineSaleInput): Promise<IngestOfflineSaleResponse>;
}

export interface CommerceClient {
  checkout(input: CheckoutRequest & { idempotencyKey: string }): Promise<CheckoutResult>;
  getHealth(): Promise<HealthResponse>;
  /** Identity bootstrap: the caller's own selectable tenants (no tenant context required). */
  getMyTenants(): Promise<MeTenantsResponse>;
  /** Returns an immutable client bound to a tenant; the original is unchanged. */
  withTenant(tenantId: string): TenantCommerceClient;
  /**
   * Public Storefront catalog reads. Unauthenticated: no session and no tenant context header. The
   * tenant the storefront serves is an explicit query parameter and only published products are
   * returned.
   */
  listPublishedProducts(query: PublicCatalogListQuery): Promise<PublicProductListResponse>;
  getPublishedProduct(query: PublicProductQuery): Promise<PublicProductDetailResponse>;
}

export class CommerceSdkError extends Error {}

export class ApiNetworkError extends CommerceSdkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiNetworkError";
  }
}

export class ApiHttpError extends CommerceSdkError {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
    readonly details?: ReadonlyArray<{
      path: ReadonlyArray<string | number>;
      message: string;
      value?: number;
    }>,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export class ApiContractError extends CommerceSdkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiContractError";
  }
}

function clientHeaders(client?: ClientMetadata): Record<string, string> {
  return {
    Accept: "application/json",
    ...(client
      ? {
          "X-Client-Type": client.type,
          "X-Client-Version": client.version,
        }
      : {}),
  };
}

function buildQuery(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const serialized = params.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

async function parseHttpError(response: Response): Promise<ApiHttpError> {
  let code = "HTTP_ERROR";
  let message = `Request failed with status ${response.status}`;
  let requestId = response.headers.get("X-Request-Id");
  let details: ApiHttpError["details"];
  try {
    const parsed = ApiErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
      requestId = parsed.data.error.requestId;
      details = parsed.data.error.details;
    }
  } catch {
    // Non-JSON or empty error body: keep the status-derived defaults.
  }
  return new ApiHttpError(message, response.status, code, requestId, details);
}

export function createCommerceClient({
  baseUrl,
  client,
  getToken,
  fetch: fetchImplementation = globalThis.fetch,
}: CommerceClientOptions): CommerceClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function authHeaders(): Promise<Record<string, string>> {
    if (getToken === undefined) {
      return {};
    }
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      tenantId?: string;
      method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      body?: unknown;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...clientHeaders(client),
      ...(await authHeaders()),
      ...(options.tenantId ? { "X-Tenant-Id": options.tenantId } : {}),
      ...(options.idempotencyKey !== undefined
        ? { "Idempotency-Key": options.idempotencyKey }
        : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    };

    let response: Response;
    try {
      response = await fetchImplementation(`${normalizedBaseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new ApiNetworkError("Unable to reach the Commerce API", { cause: error });
    }

    if (!response.ok) {
      throw await parseHttpError(response);
    }

    try {
      return schema.parse(await response.json());
    } catch (error) {
      throw new ApiContractError("Response violated the API contract", { cause: error });
    }
  }

  function withTenant(tenantId: string): TenantCommerceClient {
    return {
      tenantId,
      getContext: () => request("/api/v1/me/context", MeContextResponseSchema, { tenantId }),
      listProducts: (query = {}) =>
        request(
          `/api/v1/products${buildQuery({
            brandId: query.brandId,
            status: query.status,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          ProductListResponseSchema,
          { tenantId },
        ),
      getProduct: (productId: string) =>
        request(`/api/v1/products/${encodeURIComponent(productId)}`, ProductDetailResponseSchema, {
          tenantId,
        }),
      createProduct: ({ idempotencyKey, ...body }: CreateProductInput) =>
        request("/api/v1/products", ProductWriteResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateProduct: ({ idempotencyKey, productId, ...body }: UpdateProductInput) =>
        request(`/api/v1/products/${encodeURIComponent(productId)}`, ProductUpdatedResponseSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      setProductStatus: ({ idempotencyKey, productId, ...body }: SetProductStatusInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/status`,
          ProductWriteResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      publishProduct: ({ idempotencyKey, productId }: PublishProductInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/publication`,
          PublishProductResponseSchema,
          { tenantId, method: "POST", body: {}, idempotencyKey },
        ),
      unpublishProduct: ({ idempotencyKey, productId }: PublishProductInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/publication`,
          UnpublishProductResponseSchema,
          { tenantId, method: "DELETE", body: {}, idempotencyKey },
        ),
      createVariant: ({ idempotencyKey, productId, ...body }: CreateVariantInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/variants`,
          CreateVariantResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      setVariantPrice: ({ idempotencyKey, variantId, ...body }: SetVariantPriceInput) =>
        request(
          `/api/v1/variants/${encodeURIComponent(variantId)}/price`,
          SetVariantPriceResponseSchema,
          { tenantId, method: "PUT", body, idempotencyKey },
        ),
      createProductMediaUploadIntent: ({
        productId,
        ...body
      }: CreateProductMediaUploadIntentInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/media/upload-intent`,
          MediaUploadIntentResponseSchema,
          { tenantId, method: "POST", body },
        ),
      registerProductMedia: ({ idempotencyKey, productId, ...body }: RegisterProductMediaInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/media`,
          RegisterProductMediaResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      archiveProductMedia: ({ idempotencyKey, productId, mediaId }: ArchiveProductMediaInput) =>
        request(
          `/api/v1/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(mediaId)}`,
          ArchiveProductMediaResponseSchema,
          { tenantId, method: "DELETE", body: {}, idempotencyKey },
        ),
      listInventory: (query = {}) =>
        request(
          `/api/v1/inventory${buildQuery({
            inventoryLocationId: query.inventoryLocationId,
            variantId: query.variantId,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          InventoryListResponseSchema,
          { tenantId },
        ),
      listSuppliers: (query: SupplierListQuery = {}) =>
        request(
          `/api/v1/suppliers${buildQuery({ search: query.search, status: query.status, limit: query.limit, cursor: query.cursor })}`,
          SupplierListResponseSchema,
          { tenantId },
        ),
      getSupplier: (supplierId: string) =>
        request(`/api/v1/suppliers/${encodeURIComponent(supplierId)}`, SupplierSchema, {
          tenantId,
        }),
      createSupplier: ({ idempotencyKey, ...body }: CreateSupplierInput) =>
        request("/api/v1/suppliers", SupplierSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateSupplier: ({ supplierId, idempotencyKey, ...body }: UpdateSupplierInput) =>
        request(`/api/v1/suppliers/${encodeURIComponent(supplierId)}`, SupplierSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      listSupplierReceipts: (supplierId: string, query: SupplierReceiptsQuery = {}) =>
        request(
          `/api/v1/suppliers/${encodeURIComponent(supplierId)}/receipts${buildQuery({ limit: query.limit, cursor: query.cursor })}`,
          SupplierReceiptsResponseSchema,
          { tenantId },
        ),
      listStaff: (query: StaffListQuery = {}) =>
        request(
          `/api/v1/staff${buildQuery({ search: query.search, status: query.status, roleId: query.roleId, limit: query.limit, cursor: query.cursor })}`,
          StaffListResponseSchema,
          { tenantId },
        ),
      findEligibleStaffIdentitiesByEmail: (lookup: EligibleStaffIdentityLookup) =>
        request(
          `/api/v1/staff/eligible-identities${buildQuery({ email: lookup.email })}`,
          EligibleIdentitiesResponseSchema,
          { tenantId },
        ),
      getStaffMember: (membershipId: string) =>
        request(`/api/v1/staff/${encodeURIComponent(membershipId)}`, StaffDetailSchema, {
          tenantId,
        }),
      createStaff: ({ idempotencyKey, ...body }: CreateStaffInput) =>
        request("/api/v1/staff", StaffDetailSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      updateStaffStatus: ({ membershipId, idempotencyKey, ...body }: UpdateStaffStatusInput) =>
        request(`/api/v1/staff/${encodeURIComponent(membershipId)}`, StaffDetailSchema, {
          tenantId,
          method: "PATCH",
          body,
          idempotencyKey,
        }),
      assignStaffRole: ({ membershipId, idempotencyKey, ...body }: AssignStaffRoleInput) =>
        request(
          `/api/v1/staff/${encodeURIComponent(membershipId)}/role-assignments`,
          StaffDetailSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      unassignStaffRole: ({
        membershipId,
        assignmentId,
        idempotencyKey,
        ...body
      }: UnassignStaffRoleInput) =>
        request(
          `/api/v1/staff/${encodeURIComponent(membershipId)}/role-assignments/${encodeURIComponent(assignmentId)}`,
          StaffDetailSchema,
          { tenantId, method: "DELETE", body, idempotencyKey },
        ),
      receiveInventory: ({ idempotencyKey, ...body }: ReceiveInventoryInput) =>
        request("/api/v1/inventory/receipts", ReceiveInventoryResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      adjustInventory: ({ idempotencyKey, ...body }: AdjustInventoryInput) =>
        request("/api/v1/inventory/adjustments", AdjustInventoryResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      transferInventory: ({ idempotencyKey, ...body }: TransferInventoryInput) =>
        request("/api/v1/inventory/transfers", TransferInventoryResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      listOrders: (query = {}) =>
        request(
          `/api/v1/orders${buildQuery({
            channel: query.channel,
            brandId: query.brandId,
            branchId: query.branchId,
            status: query.status,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
          OrderListResponseSchema,
          { tenantId },
        ),
      getOrder: (orderId: string) =>
        request(`/api/v1/orders/${encodeURIComponent(orderId)}`, OrderDetailResponseSchema, {
          tenantId,
        }),
      getPosContext: () => request("/api/v1/pos/context", PosContextResponseSchema, { tenantId }),
      getReturnEligibility: (orderId: string) =>
        request(
          `/api/v1/orders/${encodeURIComponent(orderId)}/return-eligibility`,
          ReturnEligibilityResponseSchema,
          { tenantId },
        ),
      listReturns: (orderId: string, query = {}) =>
        request(
          `/api/v1/orders/${encodeURIComponent(orderId)}/returns${buildQuery(query)}`,
          ReturnHistoryResponseSchema,
          { tenantId },
        ),
      getReturn: (returnId: string) =>
        request(`/api/v1/returns/${encodeURIComponent(returnId)}`, ReturnDetailResponseSchema, {
          tenantId,
        }),
      createReturn: ({ orderId, idempotencyKey, ...body }: CreateReturnInput) =>
        request(
          `/api/v1/orders/${encodeURIComponent(orderId)}/returns`,
          ReturnDetailResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      settleRefund: ({ returnId, idempotencyKey, ...body }: SettleRefundInput) =>
        request(
          `/api/v1/returns/${encodeURIComponent(returnId)}/refund`,
          ReturnDetailResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      createPosSale: ({ idempotencyKey, ...body }: CreatePosSaleInput) =>
        request("/api/v1/pos/sales", CreatePosSaleResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      enrollPosDevice: ({ idempotencyKey, ...body }: EnrollPosDeviceInput) =>
        request("/api/v1/pos/devices", PosDeviceResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      rotatePosDeviceCredential: ({
        idempotencyKey,
        deviceId,
        ...body
      }: RotatePosDeviceCredentialInput) =>
        request(
          `/api/v1/pos/devices/${encodeURIComponent(deviceId)}/credentials`,
          PosDeviceResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      revokePosDevice: ({ idempotencyKey, deviceId, ...body }: RevokePosDeviceInput) =>
        request(
          `/api/v1/pos/devices/${encodeURIComponent(deviceId)}/revoke`,
          PosDeviceResponseSchema,
          { tenantId, method: "POST", body, idempotencyKey },
        ),
      createOfflineBootstrap: ({ idempotencyKey, ...body }: OfflineBootstrapInput) =>
        request("/api/v1/pos/offline-bootstrap", OfflineBootstrapResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
      ingestOfflineSale: ({ idempotencyKey, ...body }: IngestOfflineSaleInput) =>
        request("/api/v1/pos/offline-sales", IngestOfflineSaleResponseSchema, {
          tenantId,
          method: "POST",
          body,
          idempotencyKey,
        }),
    };
  }

  return {
    checkout: ({ idempotencyKey, ...intent }) =>
      request("/api/v1/storefront/checkout", CheckoutResultSchema, {
        method: "POST",
        body: intent,
        idempotencyKey,
      }),
    getHealth: () => request("/api/v1/health", HealthResponseSchema),
    getMyTenants: () => request("/api/v1/me/tenants", MeTenantsResponseSchema),
    withTenant,
    listPublishedProducts: (query: PublicCatalogListQuery) =>
      request(
        `/api/v1/storefront/products${buildQuery({
          tenantId: query.tenantId,
          brandId: query.brandId,
          limit: query.limit,
        })}`,
        PublicProductListResponseSchema,
      ),
    getPublishedProduct: (query: PublicProductQuery) =>
      request(
        `/api/v1/storefront/products/${encodeURIComponent(query.slug)}${buildQuery({
          tenantId: query.tenantId,
        })}`,
        PublicProductDetailResponseSchema,
      ),
  };
}

export type {
  HealthResponse,
  MeTenantsResponse,
  MeContextResponse,
  ProductListResponse,
  ProductDetailResponse,
  InventoryListResponse,
  ReceiveInventoryResponse,
  AdjustInventoryResponse,
  TransferInventoryResponse,
  OrderListResponse,
  OrderDetailResponse,
  PosContextResponse,
  CreatePosSaleResponse,
  PosDeviceResponse,
  OfflineBootstrapResponse,
  OfflineSaleCommand,
  IngestOfflineSaleResponse,
  ProductWriteResponse,
  ProductUpdatedResponse,
  PublishProductResponse,
  UnpublishProductResponse,
  CreateVariantResponse,
  SetVariantPriceResponse,
  MediaUploadIntentResponse,
  RegisterProductMediaResponse,
  ArchiveProductMediaResponse,
  PublicProduct,
  PublicProductListResponse,
  PublicProductDetailResponse,
  StorefrontStatus,
};
import {
  ReturnDetailResponseSchema,
  ReturnEligibilityResponseSchema,
  ReturnHistoryResponseSchema,
  type CreateReturnRequest,
  type SettleRefundRequest,
  type ReturnDetailResponse,
  type ReturnEligibilityResponse,
  type ReturnHistoryResponse,
} from "../../../src/contracts/management/returns";
export type {
  CreateReturnRequest,
  SettleRefundRequest,
  ReturnDetailResponse,
  ReturnEligibilityResponse,
  ReturnHistoryResponse,
  Refund,
  OrderReturnSummary,
} from "../../../src/contracts/management/returns";
export type CreateReturnInput = CreateReturnRequest & { orderId: string; idempotencyKey: string };
export type SettleRefundInput = SettleRefundRequest & { returnId: string; idempotencyKey: string };
