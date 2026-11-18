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

// Response target: the same identity plus display names resolved from the catalog (optional so older
// API builds still parse).
export const PromotionTargetDetailSchema = z
  .object({
    productId: z.uuid().nullable(),
    variantId: z.uuid().nullable(),
    productName: z.string().nullable().optional(),
    variantName: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
  })
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
  buyQuantity: z.number().int().positive().nullable().optional(),
  getQuantity: z.number().int().positive().nullable().optional(),
  minSubtotalMinor: z.number().int().nullable(),
  maxDiscountMinor: z.number().int().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  brandId: z.uuid().nullable(),
  branchId: z.uuid().nullable(),
  remainingRedemptions: z.number().int().min(0).nullable(),
  targets: z.array(PromotionTargetDetailSchema),
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
    buyQuantity?: unknown;
    getQuantity?: unknown;
    channel?: unknown;
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
  if (value.benefitType === "buy_x_get_y") {
    if (value.buyQuantity == null || value.getQuantity == null) {
      ctx.addIssue({
        code: "custom",
        message: "buy_x_get_y benefit requires buyQuantity and getQuantity",
      });
    }
    if (value.channel != null && value.channel !== "online") {
      ctx.addIssue({ code: "custom", message: "buy_x_get_y offers are online-only" });
    }
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
    buyQuantity: z.number().int().min(1).max(100).optional(),
    getQuantity: z.number().int().min(1).max(100).optional(),
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

// Every setting is editable at any time (owner decision 2026-11-18): sale-time history snapshots the
// discount actually granted, so edits only affect future sales. Absent keys keep their stored value.
// Switching benefitType must send the new type's fields; sending `targets` replaces the selection.
export const UpdatePromotionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000).nullable(),
    startsAt: z.string().datetime({ offset: true }).nullable(),
    endsAt: z.string().datetime({ offset: true }).nullable(),
    benefitType: PromotionBenefitTypeSchema,
    benefitPercentBp: PercentBpSchema,
    benefitAmountMinor: PositiveIntegerSchema,
    benefitCurrency: z.string().regex(/^[A-Z]{3}$/),
    buyQuantity: z.number().int().min(1).max(100),
    getQuantity: z.number().int().min(1).max(100),
    minSubtotalMinor: MinorSchema.nullable(),
    maxDiscountMinor: PositiveIntegerSchema.nullable(),
    channel: PromotionChannelSchema.nullable(),
    brandId: z.uuid().nullable(),
    branchId: z.uuid().nullable(),
    globalRedemptionLimit: PositiveIntegerSchema.nullable(),
    activationType: PromotionActivationSchema,
    targetType: PromotionTargetTypeSchema,
    targets: z.array(PromotionTargetSchema).max(500),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.")
  .superRefine((value, ctx) => {
    if (value.benefitType === "percentage" && value.benefitPercentBp == null) {
      ctx.addIssue({
        code: "custom",
        message: "switching to percentage requires benefitPercentBp",
      });
    }
    if (
      value.benefitType === "fixed_amount" &&
      (value.benefitAmountMinor == null || value.benefitCurrency == null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "switching to fixed_amount requires benefitAmountMinor and benefitCurrency",
      });
    }
    if (value.benefitType === "buy_x_get_y") {
      if (value.buyQuantity == null || value.getQuantity == null) {
        ctx.addIssue({
          code: "custom",
          message: "switching to buy_x_get_y requires buyQuantity and getQuantity",
        });
      }
      if (value.channel != null && value.channel !== "online") {
        ctx.addIssue({ code: "custom", message: "buy_x_get_y offers are online-only" });
      }
    }
    if (value.targetType === "variant_scope" && value.targets?.length === 0) {
      ctx.addIssue({ code: "custom", message: "variant_scope requires at least one target" });
    }
  });

/** Never-used promotions are deleted; promotions with sale-time history are archived. */
export const DeletePromotionResponseSchema = z.object({
  promotionId: z.uuid(),
  outcome: z.enum(["deleted", "archived"]),
});

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
export type DeletePromotionResponse = z.infer<typeof DeletePromotionResponseSchema>;
export type SetPromotionStatusRequest = z.infer<typeof SetPromotionStatusRequestSchema>;
export type CreatePromotionCodeRequest = z.infer<typeof CreatePromotionCodeRequestSchema>;
export type SetPromotionCodeStatusRequest = z.infer<typeof SetPromotionCodeStatusRequestSchema>;

// ADR-042 §5: per-channel voucher limits and POS offline terms. Counters are server-maintained.
export const PromotionChannelPolicySchema = z.object({
  channel: PromotionChannelSchema,
  usageLimit: z.number().int().positive().nullable(),
  redeemedCount: z.number().int().nonnegative(),
  reservedCount: z.number().int().nonnegative(),
  offlineEnabled: z.boolean(),
  offlineQuotaPerGrant: z.number().int().positive().nullable(),
  requiresAdminCredentials: z.boolean(),
  // ADR-042 D-7 owner caps. Offline is offered only when both are set.
  maxDiscountPerRedemptionMinor: z.number().int().positive().nullable(),
  maxDiscountPerGrantMinor: z.number().int().positive().nullable(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
});
export const PromotionCodeChannelLimitSchema = z.object({
  codeId: z.string().uuid(),
  code: z.string(),
  channel: PromotionChannelSchema,
  usageLimit: z.number().int().positive(),
  redeemedCount: z.number().int().nonnegative(),
  reservedCount: z.number().int().nonnegative(),
});
export const PromotionChannelPoliciesResponseSchema = z.object({
  promotionId: z.string().uuid(),
  policies: z.array(PromotionChannelPolicySchema),
  codeLimits: z.array(PromotionCodeChannelLimitSchema),
});
export const UpsertPromotionChannelPolicyRequestSchema = z
  .object({
    usageLimit: z.number().int().positive().nullable(),
    offlineEnabled: z.boolean().default(false),
    offlineQuotaPerGrant: z.number().int().positive().nullable().default(null),
    requiresAdminCredentials: z.boolean().default(false),
    maxDiscountPerRedemptionMinor: z.number().int().positive().nullable().default(null),
    maxDiscountPerGrantMinor: z.number().int().positive().nullable().default(null),
  })
  .strict();
export const UpsertPromotionCodeChannelLimitRequestSchema = z
  .object({ usageLimit: z.number().int().positive().nullable() })
  .strict();
export const OfflineVoucherExceptionSchema = z.object({
  orderId: z.string().uuid(),
  promotionId: z.string().uuid().nullable(),
  codeId: z.string().uuid().nullable(),
  code: z.string(),
  discountTotalMinor: z.number().int().positive(),
  createdAt: z.string(),
});
export const OfflineVoucherExceptionListResponseSchema = z.object({
  items: z.array(OfflineVoucherExceptionSchema),
});
export type PromotionChannel = z.infer<typeof PromotionChannelSchema>;
export type PromotionChannelPolicy = z.infer<typeof PromotionChannelPolicySchema>;
export type PromotionChannelPoliciesResponse = z.infer<
  typeof PromotionChannelPoliciesResponseSchema
>;
export type UpsertPromotionChannelPolicyRequest = z.infer<
  typeof UpsertPromotionChannelPolicyRequestSchema
>;
export type UpsertPromotionCodeChannelLimitRequest = z.infer<
  typeof UpsertPromotionCodeChannelLimitRequestSchema
>;
export type OfflineVoucherExceptionListResponse = z.infer<
  typeof OfflineVoucherExceptionListResponseSchema
>;
