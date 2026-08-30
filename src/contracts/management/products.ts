import { z } from "zod";

import { NonNegativeIntegerSchema } from "../common/serialization";
import { paginated } from "../common/pagination";

/**
 * Catalog management DTOs. These are intentionally mapped, task-oriented projections of the catalog
 * aggregate — never raw product/variant/price rows. The list summary is deliberately lightweight so a
 * single SQL statement can serve it without per-row variant/price service calls.
 */

const UuidSchema = z.string().uuid();

export const ProductStatusSchema = z.enum(["draft", "active", "archived"]);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const ProductSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  styleCode: z.string().nullable(),
  status: ProductStatusSchema,
  brandId: UuidSchema,
});

export type ProductSummary = z.infer<typeof ProductSummarySchema>;

export const ProductListResponseSchema = paginated(ProductSummarySchema);
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;

export const ProductVariantSummarySchema = z.object({
  id: UuidSchema,
  sku: z.string(),
  displayName: z.string().nullable(),
  status: ProductStatusSchema,
});

export const ProductOptionValueSchema = z.object({
  id: UuidSchema,
  value: z.string(),
});

export const ProductOptionSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  values: z.array(ProductOptionValueSchema),
});

export const ProductPriceSchema = z.object({
  variantId: UuidSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountMinor: NonNegativeIntegerSchema,
});

export const ProductDetailResponseSchema = z.object({
  product: ProductSummarySchema,
  variants: z.array(ProductVariantSummarySchema),
  options: z.array(ProductOptionSchema),
  prices: z.array(ProductPriceSchema),
});

export type ProductDetailResponse = z.infer<typeof ProductDetailResponseSchema>;
