import { z } from "zod";

import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
} from "../common/serialization";

/**
 * Phase 2J PUBLIC Storefront catalog read contracts. This is the Storefront-safe projection: it
 * exposes only published products and their publicly sellable variants. It deliberately omits internal
 * lifecycle status, cost, actor/membership data, idempotency state, price history, and exact stock
 * quantity. Availability is a conservative boolean derived from the single canonical inventory truth;
 * exact quantities are never exposed publicly and no reservation/ATS semantics are introduced.
 */

const UuidSchema = z.string().uuid();

export const PublicProductMediaSchema = z.object({
  id: UuidSchema,
  variantId: UuidSchema.nullable(),
  bucket: z.string(),
  path: z.string(),
  altText: z.string().nullable(),
  position: NonNegativeIntegerSchema,
  isPrimary: z.boolean(),
});
export type PublicProductMedia = z.infer<typeof PublicProductMediaSchema>;

export const PublicProductPriceSchema = z.object({
  currency: CurrencySchema,
  amountMinor: NonNegativeIntegerSchema,
});
export type PublicProductPrice = z.infer<typeof PublicProductPriceSchema>;

export const PublicProductVariantSchema = z.object({
  id: UuidSchema,
  sku: z.string(),
  displayName: z.string().nullable(),
  optionSignature: z.string(),
  prices: z.array(PublicProductPriceSchema),
  // Conservative availability: true when the canonical on-hand across the tenant's locations is
  // positive. Exact quantity is intentionally not exposed publicly.
  inStock: z.boolean(),
});
export type PublicProductVariant = z.infer<typeof PublicProductVariantSchema>;

export const PublicProductSchema = z.object({
  id: UuidSchema,
  brandId: UuidSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  media: z.array(PublicProductMediaSchema),
  variants: z.array(PublicProductVariantSchema),
});
export type PublicProduct = z.infer<typeof PublicProductSchema>;

export const PublicProductListResponseSchema = z.object({
  products: z.array(PublicProductSchema),
});
export type PublicProductListResponse = z.infer<typeof PublicProductListResponseSchema>;

export const PublicProductDetailResponseSchema = PublicProductSchema;
export type PublicProductDetailResponse = z.infer<typeof PublicProductDetailResponseSchema>;
