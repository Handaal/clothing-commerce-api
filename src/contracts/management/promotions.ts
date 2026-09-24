import { z } from "zod";
import { PositiveIntegerSchema } from "../common/serialization";
import {
  PromotionActivationSchema,
  PromotionBenefitTypeSchema,
  PromotionCodeInputSchema,
} from "../common/promotion-pricing";

export const PromotionStatusSchema = z.enum(["active", "inactive"]);
export const PromotionTargetTypeSchema = z.enum(["order", "variant_scope"]);
export const PromotionCodeStatusSchema = z.enum(["active", "disabled"]);
export const PromotionChannelSchema = z.enum(["pos", "online"]);

const PercentBpSchema = z.number().int().min(1).max(10000);
const MinorSchema = z.number().int().min(0).max(9007199254740991);

// Selected product/variant scope: exactly one of productId / variantId per target.
export const PromotionTargetSchema = z
  .object({ productId: z.uuid().nullable(), variantId: z.uuid().nullable() })
  .refine(
    (t) => (t.productId === null) !== (t.variantId === null),
    "Exactly one of productId/variantId.",
  );

export const PromotionCodeSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  status: PromotionCodeStatusSchema,
  maxRedemptions: z.number().int().positive().nullable(),
  redemptionCount: z.number().int().min(0),
  remainingRedemptions: z.number().int().min(0).nullable(),
});

export const PromotionSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: PromotionStatusSchema,
  benefitType: PromotionBenefitTypeSchema,
  targetType: PromotionTargetTypeSchema,
  activationType: PromotionActivationSchema,
  channel: PromotionChannelSchema.nullable(),
  redemptionCount: z.number().int().min(0),
  globalRedemptionLimit: z.number().int().positive().nullable(),
  economicsLocked: z.boolean(),
  createdAt: z.string(),
});

export const PromotionDetailSchema = PromotionSummarySchema.extend({
  description: z.string().nullable(),
  benefitPercentBp: z.number().int().nullable(),
  benefitAmountMinor: z.number().int().nullable(),
  benefitCurrency: z.string().nullable(),
  minSubtotalMinor: z.number().int().nullable(),
  maxDiscountMinor: z.number().int().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  brandId: z.uuid().nullable(),
  branchId: z.uuid().nullable(),
  remainingRedemptions: z.number().int().min(0).nullable(),
  targets: z.array(PromotionTargetSchema),
  codes: z.array(PromotionCodeSchema),
});

export const PromotionListResponseSchema = z.object({
  total: z.number().int().min(0),
  items: z.array(PromotionSummarySchema),
});

// --- write requests ---
const benefitRefine = <
  T extends {
    benefitType?: string;
    benefitPercentBp?: unknown;
    benefitAmountMinor?: unknown;
    benefitCurrency?: unknown;
  },
>(
  value: T,
  ctx: z.RefinementCtx,
) => {
  if (value.benefitType === "percentage" && value.benefitPercentBp == null) {
    ctx.addIssue({ code: "custom", message: "percentage benefit requires benefitPercentBp" });
  }
  if (
    value.benefitType === "fixed_amount" &&
    (value.benefitAmountMinor == null || value.benefitCurrency == null)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "fixed_amount benefit requires benefitAmountMinor and benefitCurrency",
    });
  }
};

export const CreatePromotionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000).nullable().optional(),
    benefitType: PromotionBenefitTypeSchema,
    benefitPercentBp: PercentBpSchema.optional(),
    benefitAmountMinor: PositiveIntegerSchema.optional(),
    benefitCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    targetType: PromotionTargetTypeSchema,
    activationType: PromotionActivationSchema,
    minSubtotalMinor: MinorSchema.nullable().optional(),
    maxDiscountMinor: PositiveIntegerSchema.nullable().optional(),
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    channel: PromotionChannelSchema.nullable().optional(),
    brandId: z.uuid().nullable().optional(),
    branchId: z.uuid().nullable().optional(),
    globalRedemptionLimit: PositiveIntegerSchema.nullable().optional(),
    status: PromotionStatusSchema.optional(),
    targets: z.array(PromotionTargetSchema).max(500).optional(),
    codes: z
      .array(
        z.object({
          code: PromotionCodeInputSchema,
          maxRedemptions: PositiveIntegerSchema.nullable().optional(),
        }),
      )
      .max(50)
      .optional(),
  })
  .strict()
  .superRefine(benefitRefine);

// Metadata is always editable; economic fields are rejected server-side after the first redemption.
export const UpdatePromotionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000).nullable(),
    startsAt: z.string().datetime({ offset: true }).nullable(),
    endsAt: z.string().datetime({ offset: true }).nullable(),
    benefitPercentBp: PercentBpSchema,
    benefitAmountMinor: PositiveIntegerSchema,
    minSubtotalMinor: MinorSchema.nullable(),
    maxDiscountMinor: PositiveIntegerSchema.nullable(),
    channel: PromotionChannelSchema.nullable(),
    brandId: z.uuid().nullable(),
    branchId: z.uuid().nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");

export const SetPromotionStatusRequestSchema = z.object({ status: PromotionStatusSchema }).strict();
export const CreatePromotionCodeRequestSchema = z
  .object({
    code: PromotionCodeInputSchema,
    maxRedemptions: PositiveIntegerSchema.nullable().optional(),
  })
  .strict();
export const SetPromotionCodeStatusRequestSchema = z
  .object({ status: PromotionCodeStatusSchema })
  .strict();

export type PromotionSummary = z.infer<typeof PromotionSummarySchema>;
export type PromotionDetail = z.infer<typeof PromotionDetailSchema>;
export type PromotionListResponse = z.infer<typeof PromotionListResponseSchema>;
export type CreatePromotionRequest = z.infer<typeof CreatePromotionRequestSchema>;
export type UpdatePromotionRequest = z.infer<typeof UpdatePromotionRequestSchema>;
export type SetPromotionStatusRequest = z.infer<typeof SetPromotionStatusRequestSchema>;
export type CreatePromotionCodeRequest = z.infer<typeof CreatePromotionCodeRequestSchema>;
export type SetPromotionCodeStatusRequest = z.infer<typeof SetPromotionCodeStatusRequestSchema>;
