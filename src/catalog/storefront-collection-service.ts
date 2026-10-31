import { z } from "zod";

import type {
  PublicCollectionDetail,
  PublicCollectionListResponse,
  PublicCollectionSummary,
} from "../contracts/storefront/collections";
import { CatalogError } from "./catalog-errors";
import type { StorefrontCollectionRepository } from "./storefront-collection-repository";

/**
 * Public Storefront collection read service. It consumes the DB-enforced published-only projection and
 * shapes it into the public contract. The product shaping deliberately mirrors the catalog read service
 * so a product carries the identical Storefront-safe surface whether it is browsed in the grid or inside
 * a collection. No internal lifecycle, cost, or exact stock is ever present in the projection.
 */

const IntegerLikeSchema = z.union([z.number(), z.string()]).transform((value) => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
});

const DbPriceSchema = z.object({ currency: z.string(), amountMinor: IntegerLikeSchema });

const DbMediaSchema = z.object({
  id: z.string(),
  variantId: z.string().nullable(),
  bucket: z.string(),
  path: z.string(),
  altText: z.string().nullable(),
  position: IntegerLikeSchema,
  isPrimary: z.boolean(),
});

const DbVariantSchema = z.object({
  id: z.string(),
  sku: z.string(),
  displayName: z.string().nullable(),
  optionSignature: z.string(),
  prices: z.array(DbPriceSchema),
  availableQuantity: IntegerLikeSchema,
});

const DbProductSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  publishedAt: z.string().nullable(),
  media: z.array(DbMediaSchema),
  variants: z.array(DbVariantSchema),
});

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
  products: z.array(DbProductSchema),
});

function shapeProduct(raw: z.infer<typeof DbProductSchema>) {
  return {
    id: raw.id,
    brandId: raw.brandId,
    slug: raw.slug,
    name: raw.name,
    description: raw.description,
    publishedAt: raw.publishedAt === null ? null : new Date(raw.publishedAt).toISOString(),
    media: raw.media.map((media) => ({
      id: media.id,
      variantId: media.variantId,
      bucket: media.bucket,
      path: media.path,
      altText: media.altText,
      position: media.position,
      isPrimary: media.isPrimary,
    })),
    variants: raw.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      displayName: variant.displayName,
      optionSignature: variant.optionSignature,
      prices: variant.prices.map((price) => ({
        currency: price.currency,
        amountMinor: price.amountMinor,
      })),
      inStock: variant.availableQuantity > 0,
    })),
  };
}

function shapeSummary(raw: unknown): PublicCollectionSummary {
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
    return { collections: rows.map(shapeSummary) };
  }

  async getPublishedCollection(tenantId: string, slug: string): Promise<PublicCollectionDetail> {
    const row = await this.repository.getPublishedCollection(tenantId, slug);
    if (row === null || row === undefined) {
      throw new CatalogError("COLLECTION_NOT_FOUND");
    }
    return shapeDetail(row);
  }
}
