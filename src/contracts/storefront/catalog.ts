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
  // The price the shopper pays online today (sale-adjusted when a catalog sale applies). Checkout and
  // quote charge exactly this figure.
  amountMinor: NonNegativeIntegerSchema,
  // The original list price when a sale applies (render it struck through); null/absent when not on
  // sale. Always greater than amountMinor when present.
  compareAtAmountMinor: NonNegativeIntegerSchema.nullable().optional(),
});
export type PublicProductPrice = z.infer<typeof PublicProductPriceSchema>;

// One selected option value of a variant, e.g. { name: "Size", value: "M" }. Names match the
// product's `options` dimensions exactly.
export const PublicVariantOptionValueSchema = z.object({
  name: z.string(),
  value: z.string(),
});
export type PublicVariantOptionValue = z.infer<typeof PublicVariantOptionValueSchema>;

export const PublicProductVariantSchema = z.object({
  id: UuidSchema,
  sku: z.string(),
  displayName: z.string().nullable(),
  optionSignature: z.string(),
  // The variant's value for each option dimension, in the product's option order. Empty for a
  // product without options.
  optionValues: z.array(PublicVariantOptionValueSchema).optional(),
  prices: z.array(PublicProductPriceSchema),
  // Conservative availability: true when the canonical on-hand across the tenant's locations is
  // positive. Exact quantity is intentionally not exposed publicly.
  inStock: z.boolean(),
  // SDK 0.46: true when only a few units remain (1..LOW_STOCK_THRESHOLD) — a coarse "few left" hint
  // for urgency copy; the exact quantity stays private.
  lowStock: z.boolean().optional(),
});
export type PublicProductVariant = z.infer<typeof PublicProductVariantSchema>;

// A live automatic Buy-X-Get-Y offer that applies to this product online (e.g. "Buy 2 get 1 free").
export const PublicProductOfferSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  buyQuantity: z.number().int().positive(),
  getQuantity: z.number().int().positive(),
});
export type PublicProductOffer = z.infer<typeof PublicProductOfferSchema>;

// A product option dimension (e.g. Size, Colour) with the values its publicly listed variants use,
// in display order. `swatchHex` (lowercase #rrggbb) is set when the brand gave the value a colour.
export const PublicProductOptionSchema = z.object({
  name: z.string(),
  values: z.array(
    z.object({
      value: z.string(),
      swatchHex: z
        .string()
        .regex(/^#[0-9a-f]{6}$/u)
        .nullable(),
    }),
  ),
});
export type PublicProductOption = z.infer<typeof PublicProductOptionSchema>;

// A category the product belongs to (active categories only).
export const PublicProductCategorySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
});
export type PublicProductCategory = z.infer<typeof PublicProductCategorySchema>;

// A size chart (SDK 0.46). Brands attach one to a category; a product shows the guide of its nearest
// category that has one. `columns` are measurement names (e.g. Chest, Length); each row gives one size's
// measurements in column order, as display text (e.g. "104" or "102–106").
const SizeGuideCellSchema = z.string().trim().max(24);
export const SizeGuideSchema = z
  .object({
    title: z.string().trim().min(1).max(120).nullable(),
    unit: z.enum(["cm", "in"]),
    columns: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
    rows: z
      .array(
        z.object({
          size: z.string().trim().min(1).max(24),
          values: z.array(SizeGuideCellSchema).max(8),
        }),
      )
      .min(1)
      .max(30),
    note: z.string().trim().min(1).max(500).nullable(),
  })
  .refine((guide) => guide.rows.every((row) => row.values.length === guide.columns.length), {
    message: "Every size row needs one value per column.",
    path: ["rows"],
  });
export type SizeGuide = z.infer<typeof SizeGuideSchema>;

export const PublicProductSchema = z.object({
  id: UuidSchema,
  brandId: UuidSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  media: z.array(PublicProductMediaSchema),
  variants: z.array(PublicProductVariantSchema),
  offers: z.array(PublicProductOfferSchema).optional(),
  options: z.array(PublicProductOptionSchema).optional(),
  categories: z.array(PublicProductCategorySchema).optional(),
  sizeGuide: SizeGuideSchema.nullable().optional(),
});
export type PublicProduct = z.infer<typeof PublicProductSchema>;

export const PublicProductListResponseSchema = z.object({
  products: z.array(PublicProductSchema),
});
export type PublicProductListResponse = z.infer<typeof PublicProductListResponseSchema>;

export const PublicProductDetailResponseSchema = PublicProductSchema;
export type PublicProductDetailResponse = z.infer<typeof PublicProductDetailResponseSchema>;

// ---- Public category list (navigation + filtering) ----
// Active categories that hold at least one publicly visible product (directly or in a descendant).
// `parentId` builds the tree (null = top level, e.g. Men); `productCount` includes descendants.
export const PublicCategorySchema = z.object({
  id: UuidSchema,
  parentId: UuidSchema.nullable(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  position: NonNegativeIntegerSchema,
  productCount: NonNegativeIntegerSchema,
});
export type PublicCategory = z.infer<typeof PublicCategorySchema>;

export const PublicCategoryListResponseSchema = z.object({
  categories: z.array(PublicCategorySchema),
});
export type PublicCategoryListResponse = z.infer<typeof PublicCategoryListResponseSchema>;

// ---- Public best sellers (SDK 0.46) ----
// Publicly visible products ranked by units sold on placed orders (POS + online) over the last `days`,
// best first. Only the ranking is public; unit counts are never exposed. Empty when nothing has sold.
export const PublicBestSellersResponseSchema = z.object({
  productIds: z.array(UuidSchema),
});
export type PublicBestSellersResponse = z.infer<typeof PublicBestSellersResponseSchema>;
