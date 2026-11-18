import { z } from "zod";

import type { PublicProduct } from "../contracts/storefront/catalog";

/**
 * The single shaper from the DB-enforced public product projection (catalog_public.build_published_product)
 * to the public contract. Shared by the catalog, collection, and storefront-content reads so a product
 * carries the identical Storefront-safe surface everywhere: sale-adjusted price + compare-at original,
 * live offers, and a conservative inStock boolean (exact quantity is never exposed).
 */

export const IntegerLikeSchema = z.union([z.number(), z.string()]).transform((value) => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
});

const DbPriceSchema = z.object({
  currency: z.string(),
  amountMinor: IntegerLikeSchema,
  compareAtAmountMinor: IntegerLikeSchema.nullable().optional(),
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

const DbOfferSchema = z.object({
  id: z.string(),
  name: z.string(),
  buyQuantity: IntegerLikeSchema,
  getQuantity: IntegerLikeSchema,
});

export const DbPublicProductSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  publishedAt: z.string().nullable(),
  media: z.array(DbMediaSchema),
  variants: z.array(DbVariantSchema),
  offers: z.array(DbOfferSchema).optional(),
});

export function shapePublicProduct(raw: unknown): PublicProduct {
  const parsed = DbPublicProductSchema.parse(raw);
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
        compareAtAmountMinor:
          price.compareAtAmountMinor != null && price.compareAtAmountMinor > price.amountMinor
            ? price.compareAtAmountMinor
            : null,
      })),
      inStock: variant.availableQuantity > 0,
    })),
    offers: (parsed.offers ?? []).map((offer) => ({
      id: offer.id,
      name: offer.name,
      buyQuantity: offer.buyQuantity,
      getQuantity: offer.getQuantity,
    })),
  };
}
