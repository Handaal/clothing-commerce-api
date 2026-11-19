import { z } from "zod";
import {
  CurrencySchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "../common/serialization";

/**
 * After purchase (SDK 0.48): order tracking and customer return requests. Public and
 * unauthenticated. The shopper proves an order is theirs with its order number plus the phone given at
 * checkout (customer or delivery phone). A wrong number and a wrong phone get the same
 * ORDER_NOT_FOUND, and repeated misses for one order number are refused with TOO_MANY_ATTEMPTS for
 * 15 minutes. Responses carry no street address, email, or internal ids.
 */
const OrderLookupFields = {
  tenantId: z.string().uuid(),
  brandId: z.string().uuid().optional(),
  // The order number as shown at checkout; a leading "#" is accepted.
  orderReference: z.string().trim().min(1).max(40),
  phone: z
    .string()
    .trim()
    .max(25)
    .regex(/^\+?[0-9 ()-]{8,25}$/u),
};

export const StorefrontTrackOrderRequestSchema = z.object(OrderLookupFields).strict();
export type StorefrontTrackOrderRequest = z.infer<typeof StorefrontTrackOrderRequestSchema>;

export const ReturnRequestReasonSchema = z.enum([
  "too_small",
  "too_big",
  "not_as_pictured",
  "damaged",
  "wrong_item",
  "changed_mind",
  "other",
]);
export type ReturnRequestReason = z.infer<typeof ReturnRequestReasonSchema>;

export const ReturnRequestStatusSchema = z.enum(["requested", "approved", "declined", "completed"]);
export type ReturnRequestStatus = z.infer<typeof ReturnRequestStatusSchema>;

export const ReturnRequestPreferenceSchema = z.enum(["refund", "exchange"]);
export type ReturnRequestPreference = z.infer<typeof ReturnRequestPreferenceSchema>;

/** Why a return request can't be opened right now. */
export const ReturnRequestRefusalSchema = z.enum([
  "RETURNS_DISABLED",
  "ORDER_CANCELLED",
  "RETURN_WINDOW_EXPIRED",
  "NOT_YET_DELIVERED",
  "NOTHING_TO_RETURN",
]);
export type ReturnRequestRefusal = z.infer<typeof ReturnRequestRefusalSchema>;

/**
 * Where the order is, derived from the order, its fulfilments and payment:
 * cancelled; confirmed (nothing handed over yet); partially_shipped; shipped (everything handed to
 * delivery); delivered (cash collected / paid after shipping).
 */
export const TrackingStageSchema = z.enum([
  "cancelled",
  "confirmed",
  "partially_shipped",
  "shipped",
  "delivered",
]);
export type TrackingStage = z.infer<typeof TrackingStageSchema>;

const IsoString = z.string().datetime({ offset: true });

export const StorefrontTrackedOrderSchema = z.object({
  orderReference: z.string(),
  stage: TrackingStageSchema,
  placedAt: IsoString,
  cancelledAt: IsoString.nullable(),
  lastShippedAt: IsoString.nullable(),
  currency: CurrencySchema,
  totalMinor: NonNegativeIntegerSchema,
  grossSubtotalMinor: NonNegativeIntegerSchema,
  discountTotalMinor: NonNegativeIntegerSchema,
  deliveryFeeMinor: NonNegativeIntegerSchema,
  payment: z
    .object({
      method: z.enum(["cash", "cash_on_delivery", "electronic"]),
      status: z.enum(["pending", "authorized", "captured", "failed", "cancelled", "refunded"]),
    })
    .nullable(),
  // First name only.
  recipientName: z.string(),
  deliveryCity: z.string().nullable(),
  deliveryRegion: z.string().nullable(),
  lines: z.array(
    z.object({
      lineNumber: PositiveIntegerSchema,
      productName: z.string(),
      variantName: z.string().nullable(),
      optionSummary: z.string().nullable(),
      quantity: PositiveIntegerSchema,
      unitPriceMinor: NonNegativeIntegerSchema,
      lineTotalMinor: NonNegativeIntegerSchema,
      shippedQuantity: NonNegativeIntegerSchema,
      returnedQuantity: NonNegativeIntegerSchema,
      // In open (requested/approved) return requests.
      requestedQuantity: NonNegativeIntegerSchema,
      // What a new return request may still include (0 when returns aren't accepted).
      returnableQuantity: NonNegativeIntegerSchema,
    }),
  ),
  returns: z.object({
    accepting: z.boolean(),
    reason: ReturnRequestRefusalSchema.nullable(),
    windowDays: NonNegativeIntegerSchema.nullable(),
    windowEndsAt: IsoString.nullable(),
  }),
  returnRequests: z.array(
    z.object({
      reference: z.string(),
      status: ReturnRequestStatusSchema,
      preference: ReturnRequestPreferenceSchema,
      createdAt: IsoString,
      lines: z.array(
        z.object({ lineNumber: PositiveIntegerSchema, quantity: PositiveIntegerSchema }),
      ),
    }),
  ),
});
export type StorefrontTrackedOrder = z.infer<typeof StorefrontTrackedOrderSchema>;

export const StorefrontReturnRequestSchema = z
  .object({
    ...OrderLookupFields,
    preference: ReturnRequestPreferenceSchema.default("refund"),
    note: z.string().trim().max(500).optional(),
    lines: z
      .array(
        z
          .object({
            lineNumber: PositiveIntegerSchema,
            quantity: PositiveIntegerSchema.max(999),
            reason: ReturnRequestReasonSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type StorefrontReturnRequest = z.input<typeof StorefrontReturnRequestSchema>;

export const StorefrontReturnRequestResponseSchema = z.object({
  reference: z.string(),
  status: z.literal("requested"),
});
export type StorefrontReturnRequestResponse = z.infer<typeof StorefrontReturnRequestResponseSchema>;
