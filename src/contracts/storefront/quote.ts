import { z } from "zod";
import { PositiveIntegerSchema } from "../common/serialization";
import { PricingBreakdownSchema, PromotionCodeInputSchema } from "../common/promotion-pricing";

// Non-consuming Storefront pricing quote. Mirrors checkout's basket shape but authors no money and
// reserves nothing.
export const StorefrontQuoteRequestSchema = z.strictObject({
  tenantId: z.uuid(),
  brandId: z.uuid(),
  lines: z
    .array(z.strictObject({ variantId: z.uuid(), quantity: PositiveIntegerSchema.max(10000) }))
    .min(1)
    .max(100),
  promotionCode: PromotionCodeInputSchema.nullable().optional(),
});
export type StorefrontQuoteRequest = z.infer<typeof StorefrontQuoteRequestSchema>;

export const StorefrontQuoteResponseSchema = PricingBreakdownSchema;
export type StorefrontQuoteResponse = z.infer<typeof StorefrontQuoteResponseSchema>;
