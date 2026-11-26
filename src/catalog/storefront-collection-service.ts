import { z } from "zod";

import type {
  PublicCollectionDetail,
  PublicCollectionListResponse,
  PublicCollectionSummary,
} from "../contracts/storefront/collections";
import { CatalogError } from "./catalog-errors";
import { IntegerLikeSchema, shapePublicProduct as shapeProduct } from "./public-product-shape";
import type { StorefrontCollectionRepository } from "./storefront-collection-repository";

/**
 * Public Storefront collection read service. It consumes the DB-enforced published-only projection and
 * shapes it into the public contract. The product shaping deliberately mirrors the catalog read service
 * so a product carries the identical Storefront-safe surface whether it is browsed in the grid or inside
 * a collection. No internal lifecycle, cost, or exact stock is ever present in the projection.
 */

const DbCoverSchema = z
  .object({ bucket: z.string(), path: z.string(), altText: z.string().nullable() })
  .nullable();

const DbCollectionSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  productCount: IntegerLikeSchema,
  cover: DbCoverSchema,
});

const DbCollectionDetailSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  cover: DbCoverSchema.optional(),
  products: z.array(z.unknown()),
});

export function shapeCollectionSummary(raw: unknown): PublicCollectionSummary {
  const parsed = DbCollectionSummarySchema.parse(raw);
  return {
    id: parsed.id,
    slug: parsed.slug,
    name: parsed.name,
    description: parsed.description,
    productCount: parsed.productCount,
    cover: parsed.cover,
  };
}

function shapeDetail(raw: unknown): PublicCollectionDetail {
  const parsed = DbCollectionDetailSchema.parse(raw);
  return {
    id: parsed.id,
    slug: parsed.slug,
    name: parsed.name,
    description: parsed.description,
    cover: parsed.cover ?? null,
    products: parsed.products.map(shapeProduct),
  };
}

export class StorefrontCollectionService {
  constructor(private readonly repository: StorefrontCollectionRepository) {}

  async listPublishedCollections(
    tenantId: string,
    limit: number,
  ): Promise<PublicCollectionListResponse> {
    const rows = await this.repository.listPublishedCollections(tenantId, limit);
    return { collections: rows.map(shapeCollectionSummary) };
  }

  async getPublishedCollection(tenantId: string, slug: string): Promise<PublicCollectionDetail> {
    const row = await this.repository.getPublishedCollection(tenantId, slug);
    if (row === null || row === undefined) {
      throw new CatalogError("COLLECTION_NOT_FOUND");
    }
    return shapeDetail(row);
  }
}
