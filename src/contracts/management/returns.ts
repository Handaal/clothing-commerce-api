import { z } from "zod";
import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "../common/serialization";

export const ReturnLineInputSchema = z.strictObject({
  orderLineId: z.uuid(),
  quantity: PositiveIntegerSchema,
  reason: z.string().trim().min(1).max(500),
  disposition: z.enum(["restock", "non_restock"]),
});
export const CreateReturnRequestSchema = z.strictObject({
  lines: z.array(ReturnLineInputSchema).min(1).max(100),
  inventoryLocationId: z.uuid().nullable().default(null),
  refundMode: z.enum(["pending", "manual_confirmed"]).default("pending"),
  settlementReference: z.string().trim().min(1).max(200).nullable().default(null),
});
export type CreateReturnRequest = z.input<typeof CreateReturnRequestSchema>;
export type ReturnCommand = z.output<typeof CreateReturnRequestSchema>;
export const SettleRefundRequestSchema = z.strictObject({
  settlementReference: z.string().trim().min(1).max(200),
});
export type SettleRefundRequest = z.infer<typeof SettleRefundRequestSchema>;
export const RefundSchema = z.object({
  id: z.uuid(),
  paymentId: z.uuid(),
  returnId: z.uuid(),
  method: z.enum(["cash", "cash_on_delivery", "electronic"]),
  status: z.enum(["pending", "succeeded", "failed"]),
  amountMinor: NonNegativeIntegerSchema,
  currency: CurrencySchema,
  settlementReference: z.string().nullable(),
  settledAt: IsoDateTimeSchema.nullable(),
});
export type Refund = z.infer<typeof RefundSchema>;
export const ReturnDetailResponseSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  channel: z.enum(["pos", "online"]),
  source: z.enum(["admin-mobile", "pos", "management"]),
  actorMembershipId: z.uuid(),
  status: z.literal("accepted"),
  currency: CurrencySchema,
  amountMinor: NonNegativeIntegerSchema,
  inventoryLocationId: z.uuid().nullable(),
  inventoryOperationId: z.uuid().nullable(),
  createdAt: IsoDateTimeSchema,
  lines: z.array(
    ReturnLineInputSchema.extend({
      lineNumber: PositiveIntegerSchema,
      variantId: z.uuid(),
      amountMinor: NonNegativeIntegerSchema,
    }),
  ),
  refund: RefundSchema,
});
export type ReturnDetailResponse = z.infer<typeof ReturnDetailResponseSchema>;
export const ReturnEligibilityResponseSchema = z.object({
  orderId: z.uuid(),
  currency: CurrencySchema,
  eligible: z.boolean(),
  reason: z.string().nullable(),
  maxRefundableMinor: NonNegativeIntegerSchema,
  policy: z.object({
    windowDays: NonNegativeIntegerSchema.nullable(),
    allowedReasons: z.array(z.string()).nullable(),
    manualRefundsEnabled: z.boolean(),
    maxManualRefundMinor: NonNegativeIntegerSchema.nullable(),
  }),
  lines: z.array(
    z.object({
      orderLineId: z.uuid(),
      lineNumber: PositiveIntegerSchema,
      variantId: z.uuid(),
      purchasedQuantity: PositiveIntegerSchema,
      fulfilledQuantity: NonNegativeIntegerSchema,
      returnedQuantity: NonNegativeIntegerSchema,
      eligibleQuantity: NonNegativeIntegerSchema,
      unitPriceMinor: NonNegativeIntegerSchema,
    }),
  ),
});
export type ReturnEligibilityResponse = z.infer<typeof ReturnEligibilityResponseSchema>;
export const ReturnHistoryResponseSchema = z.object({
  items: z.array(ReturnDetailResponseSchema),
  pageInfo: z.object({ hasMore: z.boolean(), nextCursor: z.uuid().nullable() }),
});
export type ReturnHistoryResponse = z.infer<typeof ReturnHistoryResponseSchema>;
export const OrderReturnSummarySchema = z.object({
  lines: z.array(
    z.object({
      orderLineId: z.uuid(),
      lineNumber: PositiveIntegerSchema,
      returnedQuantity: NonNegativeIntegerSchema,
    }),
  ),
  pendingRefundMinor: NonNegativeIntegerSchema,
  refundedMinor: NonNegativeIntegerSchema,
});
export type OrderReturnSummary = z.infer<typeof OrderReturnSummarySchema>;
