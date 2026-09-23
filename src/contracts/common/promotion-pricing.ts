import { z } from "zod";
import { CurrencySchema, NonNegativeIntegerSchema } from "./serialization";

// Canonical entered-code form: trim + uppercase over [A-Z0-9_-]. Clients may submit any case.
export const PromotionCodeInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "A promotion code may contain only letters, digits, hyphen, underscore.",
  );

export const PromotionActivationSchema = z.enum(["automatic", "code"]);
export const PromotionBenefitTypeSchema = z.enum(["percentage", "fixed_amount"]);

// The immutable summary of the single applied promotion, sufficient for UI acknowledgement.
export const AppliedPromotionSchema = z.object({
  promotionId: z.uuid(),
  name: z.string(),
  benefitType: PromotionBenefitTypeSchema,
  activation: PromotionActivationSchema,
  code: z.string().nullable(),
  discountTotalMinor: NonNegativeIntegerSchema,
});
export type AppliedPromotion = z.infer<typeof AppliedPromotionSchema>;

// Shared server-authoritative pricing breakdown. Identical Storefront and POS quote semantics.
export const PricingBreakdownSchema = z.object({
  currency: CurrencySchema,
  grossSubtotalMinor: NonNegativeIntegerSchema,
  discountTotalMinor: NonNegativeIntegerSchema,
  totalMinor: NonNegativeIntegerSchema,
  // "none" when no code was entered, "valid" when the entered code applied, "invalid" otherwise.
  codeStatus: z.enum(["none", "valid", "invalid"]),
  promotion: AppliedPromotionSchema.nullable(),
});
export type PricingBreakdown = z.infer<typeof PricingBreakdownSchema>;
