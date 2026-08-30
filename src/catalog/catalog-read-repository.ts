import type { ProductDetailResponse, ProductStatus, ProductSummary } from "../contracts";
import type { ProductCursorKey } from "../management/cursor";
import type { CatalogReadVisibility } from "../management/visibility";

export interface ProductListFilters {
  readonly brandId?: string;
  readonly status?: ProductStatus;
}

export interface ProductListQuery {
  readonly tenantId: string;
  /** Derived in trusted application code; the repository never computes authorization. */
  readonly visibility: CatalogReadVisibility;
  readonly filters: ProductListFilters;
  /** Number of rows to fetch (the service passes limit + 1 to detect a further page). */
  readonly fetchLimit: number;
  readonly cursor: ProductCursorKey | null;
}

export interface ProductListRow {
  readonly summary: ProductSummary;
  readonly cursor: ProductCursorKey;
}

/**
 * The catalog read surface for the management API. Every method is tenant-scoped and, for lists, applies
 * the derived visibility predicate BEFORE the ORDER BY / cursor condition / LIMIT. It exposes no write
 * method and no raw-row escape hatch.
 */
export interface CatalogReadRepository {
  /** Minimal tenant-contained existence lookup for an explicit brand filter (selects id only). */
  brandExistsInTenant(tenantId: string, brandId: string): Promise<boolean>;
  listProducts(query: ProductListQuery): Promise<ProductListRow[]>;
  /** Tenant-filtered routing lookup: productId -> persisted brandId, or null if not in tenant. */
  findProductBrandId(tenantId: string, productId: string): Promise<string | null>;
  loadProductDetail(tenantId: string, productId: string): Promise<ProductDetailResponse | null>;
}
