import { z } from "zod";

import type { PublicProduct, PublicProductListResponse } from "../contracts/storefront/catalog";
import { CatalogError } from "./catalog-errors";
import type { StorefrontCatalogRepository } from "./storefront-catalog-repository";

/**
 * Public Storefront read service. It consumes the DB-enforced published-only projection and shapes it
 * into the public contract, applying the conservative availability policy: the DB reports the canonical
 * on-hand across the tenant's locations, and this service exposes only an `inStock` boolean — exact
 * quantities are never returned publicly. No internal lifecycle, cost, or history is present in the
 * projection to begin with.
 */

const IntegerLikeSchema = z.union([z.number(), z.string()]).transform((value) => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
});

const DbPriceSchema = z.object({
  currency: z.string(),
  amountMinor: IntegerLikeSchema,
});

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

function shapeProduct(raw: unknown): PublicProduct {
  const parsed = DbProductSchema.parse(raw);
  return {
    id: parsed.id,
    brandId: parsed.brandId,
    slug: parsed.slug,
    name: parsed.name,
    description: parsed.description,
    // Postgres renders timestamptz with a numeric offset (e.g. "...+00:00"); normalize to a canonical
    // UTC ISO-8601 instant so the public contract's date-time validation accepts it.
    publishedAt: parsed.publishedAt === null ? null : new Date(parsed.publishedAt).toISOString(),
    media: parsed.media.map((media) => ({
      id: media.id,
      variantId: media.variantId,
      bucket: media.bucket,
      path: media.path,
      altText: media.altText,
      position: media.position,
      isPrimary: media.isPrimary,
    })),
    variants: parsed.variants.map((variant) => ({
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
}
