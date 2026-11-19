import { z } from "zod";

import type {
  PublicBestSellersResponse,
  PublicProduct,
  PublicProductListResponse,
} from "../contracts/storefront/catalog";
import { CatalogError } from "./catalog-errors";
import { shapePublicProduct as shapeProduct } from "./public-product-shape";
import type { StorefrontCatalogRepository } from "./storefront-catalog-repository";

/**
 * Public Storefront read service. It consumes the DB-enforced published-only projection and shapes it
 * into the public contract, applying the conservative availability policy: the DB reports the canonical
 * on-hand across the tenant's locations, and this service exposes only an `inStock` boolean — exact
 * quantities are never returned publicly. No internal lifecycle, cost, or history is present in the
 * projection to begin with.
 */

export class StorefrontCatalogService {
  constructor(private readonly repository: StorefrontCatalogRepository) {}

  async listPublishedProducts(
    tenantId: string,
    brandId: string | null,
    limit: number,
  ): Promise<PublicProductListResponse> {
    const rows = await this.repository.listPublishedProducts(tenantId, brandId, limit);
    return { products: rows.map(shapeProduct) };
  }

  async getPublishedProduct(tenantId: string, slug: string): Promise<PublicProduct> {
    const row = await this.repository.getPublishedProduct(tenantId, slug);
    if (row === null || row === undefined) {
      throw new CatalogError("PRODUCT_NOT_FOUND");
    }
    return shapeProduct(row);
  }

  /** Ranking only (best first); unit counts never leave the database. */
  async listBestSellers(
    tenantId: string,
    brandId: string | null,
    days: number,
    limit: number,
  ): Promise<PublicBestSellersResponse> {
    const raw = await this.repository.listBestSellingProductIds(tenantId, brandId, days, limit);
    return { productIds: z.array(z.string().uuid()).parse(raw ?? []) };
  }
}
