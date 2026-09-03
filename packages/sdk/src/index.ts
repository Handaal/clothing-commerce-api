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
  ReceiveInventoryResponseSchema,
  TransferInventoryResponseSchema,
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
  type ReceiveInventoryResponse,
  type TransferInventoryResponse,
} from "../../../src/contracts";
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

/** Tenant-scoped management surface, obtained via `client.withTenant(tenantId)`. */
export interface TenantCommerceClient {
  readonly tenantId: string;
  getContext(): Promise<MeContextResponse>;
  listProducts(query?: ProductListQuery): Promise<ProductListResponse>;
  getProduct(productId: string): Promise<ProductDetailResponse>;
  listInventory(query?: InventoryListQuery): Promise<InventoryListResponse>;
  receiveInventory(input: ReceiveInventoryInput): Promise<ReceiveInventoryResponse>;
  adjustInventory(input: AdjustInventoryInput): Promise<AdjustInventoryResponse>;
  transferInventory(input: TransferInventoryInput): Promise<TransferInventoryResponse>;
  listOrders(query?: OrderListQuery): Promise<OrderListResponse>;
  getOrder(orderId: string): Promise<OrderDetailResponse>;
}

export interface CommerceClient {
  getHealth(): Promise<HealthResponse>;
  /** Identity bootstrap: the caller's own selectable tenants (no tenant context required). */
  getMyTenants(): Promise<MeTenantsResponse>;
  /** Returns an immutable client bound to a tenant; the original is unchanged. */
  withTenant(tenantId: string): TenantCommerceClient;
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
  try {
    const parsed = ApiErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
      requestId = parsed.data.error.requestId;
    }
  } catch {
    // Non-JSON or empty error body: keep the status-derived defaults.
  }
  return new ApiHttpError(message, response.status, code, requestId);
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
      method?: "GET" | "POST";
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
    };
  }

  return {
    getHealth: () => request("/api/v1/health", HealthResponseSchema),
    getMyTenants: () => request("/api/v1/me/tenants", MeTenantsResponseSchema),
    withTenant,
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
};
