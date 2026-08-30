import type { AuthorizationContext } from "../authorization";
import { AuthorizationError } from "../authorization/errors";
import type { Paginated, ProductDetailResponse, ProductStatus, ProductSummary } from "../contracts";
import { decodeProductCursor, encodeProductCursor } from "../management/cursor";
import { ManagementNotFoundError } from "../management/errors";
import { buildPage, emptyPage } from "../management/pagination";
import { ManagementReadPermission, deriveCatalogReadVisibility } from "../management/visibility";
import type { CatalogReadRepository } from "./catalog-read-repository";

export interface ProductListParams {
  readonly brandId?: string;
  readonly status?: ProductStatus;
  readonly limit: number;
  readonly cursor: string | null;
}

/**
 * Catalog read application service for the management API. It derives catalog visibility from the
 * verified context, enforces the explicit-filter 404-then-403 sequence, and always applies the
 * visibility predicate before pagination (delegated to the repository query).
 */
export class CatalogReadService {
  constructor(private readonly repository: CatalogReadRepository) {}

  async listProducts(
    context: AuthorizationContext,
    params: ProductListParams,
  ): Promise<Paginated<ProductSummary>> {
    // Cursor validity is request validation: decode first so a malformed token is a deterministic 400.
    const cursorKey = params.cursor !== null ? decodeProductCursor(params.cursor) : null;

    const visibility = deriveCatalogReadVisibility(context);
    const hasPermission = context.assignments.some((assignment) =>
      assignment.permissionKeys.includes(ManagementReadPermission.catalog),
    );

    if (params.brandId !== undefined) {
      // §18 sequence: tenant-contained existence BEFORE authorization, so a foreign/nonexistent brand is
      // a 404 and an in-tenant-but-out-of-scope brand is a 403.
      const exists = await this.repository.brandExistsInTenant(context.tenant.id, params.brandId);
      if (!exists) {
        throw new ManagementNotFoundError();
      }
      const authorized =
        hasPermission && (visibility.tenantWide || visibility.brandIds.includes(params.brandId));
      if (!authorized) {
        throw new AuthorizationError(hasPermission ? "SCOPE_DENIED" : "PERMISSION_DENIED");
      }
    } else {
      if (!hasPermission) {
        throw new AuthorizationError("PERMISSION_DENIED");
      }
      // Permission present but no usable read scope (e.g. wrong-kind-only): zero authorized rows.
      if (!visibility.canRead) {
        return emptyPage();
      }
    }

    const rows = await this.repository.listProducts({
      tenantId: context.tenant.id,
      visibility,
      filters: {
        ...(params.brandId !== undefined ? { brandId: params.brandId } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
      },
      fetchLimit: params.limit + 1,
      cursor: cursorKey,
    });

    return buildPage(
      rows,
      params.limit,
      (row) => row.summary,
      (row) => encodeProductCursor(row.cursor),
    );
  }

  async getProduct(
    context: AuthorizationContext,
    productId: string,
  ): Promise<ProductDetailResponse> {
    // Routing lookup: resolve the persisted brand, tenant-filtered. A miss is a safe 404 (never leaked
    // as a scope denial).
    const brandId = await this.repository.findProductBrandId(context.tenant.id, productId);
    if (brandId === null) {
      throw new ManagementNotFoundError();
    }

    const hasPermission = context.assignments.some((assignment) =>
      assignment.permissionKeys.includes(ManagementReadPermission.catalog),
    );
    const visibility = deriveCatalogReadVisibility(context);
    const authorized =
      hasPermission && (visibility.tenantWide || visibility.brandIds.includes(brandId));
    if (!authorized) {
      throw new AuthorizationError(hasPermission ? "SCOPE_DENIED" : "PERMISSION_DENIED");
    }

    const detail = await this.repository.loadProductDetail(context.tenant.id, productId);
    if (detail === null) {
      throw new ManagementNotFoundError();
    }
    return detail;
  }
}
