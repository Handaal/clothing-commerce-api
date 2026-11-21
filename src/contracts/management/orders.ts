import { OrderCommerceDetailsSchema } from "../storefront/checkout";
import { z } from "zod";
import { OrderReturnSummarySchema } from "./returns";

import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "../common/serialization";
import { paginated } from "../common/pagination";

/**
 * Orders management DTOs. The list summary carries the order-level fulfillment status and the customer
 * contact shown in queues (SDK 0.51), served by the list query plus one batched line read per page.
 * Order detail composes the order aggregate with its fulfillment progress summary, but never exposes
 * inventory-operation ids, idempotency keys, payload fingerprints, routing descriptors, or actor
 * membership internals.
 */

const UuidSchema = z.string().uuid();

export const OrderChannelSchema = z.enum(["pos", "online"]);
export type OrderChannel = z.infer<typeof OrderChannelSchema>;

export const OrderStatusSchema = z.enum(["placed", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const FulfillmentProgressStatusSchema = z.enum([
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
]);

export const OrderSummarySchema = z.object({
  id: UuidSchema,
  orderNumber: z.string(),
  channel: OrderChannelSchema,
  status: OrderStatusSchema,
  brandId: UuidSchema,
  branchId: UuidSchema.nullable(),
  currency: CurrencySchema,
  totalMinor: NonNegativeIntegerSchema,
  // Delivery fee included in totalMinor (online orders; 0 for POS).
  deliveryFeeMinor: NonNegativeIntegerSchema.optional(),
  placedAt: IsoDateTimeSchema,
  // SDK 0.51: enough to triage a queue without one detail read per order. Fulfilment progress of the
  // whole order, and the customer's name/phone and delivery city from the order's own snapshots.
  fulfillmentStatus: FulfillmentProgressStatusSchema.optional(),
  customerName: z.string().nullable().optional(),
  customerPhone: z.string().nullable().optional(),
  deliveryCity: z.string().nullable().optional(),
});

export type OrderSummary = z.infer<typeof OrderSummarySchema>;

export const OrderListResponseSchema = paginated(OrderSummarySchema);
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;

export const OrderDetailLineSchema = z.object({
  lineNumber: PositiveIntegerSchema,
  variantId: UuidSchema,
  productName: z.string(),
  sku: z.string(),
  quantity: PositiveIntegerSchema,
  unitPriceMinor: NonNegativeIntegerSchema,
  lineTotalMinor: NonNegativeIntegerSchema,
  // SDK 0.51: what to pick, readable — the variant name at sale ("M") and the chosen options
  // ("M · White"), resolved from the line's snapshot. Null when the line recorded none.
  variantName: z.string().nullable().optional(),
  optionSummary: z.string().nullable().optional(),
});

export const OrderCancellationSchema = z.object({
  cancelledAt: IsoDateTimeSchema,
  reason: z.string().nullable(),
});

export const FulfillmentProgressLineSchema = z.object({
  lineNumber: PositiveIntegerSchema,
  variantId: UuidSchema,
  orderedQuantity: NonNegativeIntegerSchema,
  fulfilledQuantity: NonNegativeIntegerSchema,
  status: FulfillmentProgressStatusSchema,
});

export const FulfillmentProgressSchema = z.object({
  status: FulfillmentProgressStatusSchema,
  lines: z.array(FulfillmentProgressLineSchema),
});

export const OrderDetailResponseSchema = z.object({
  returns: OrderReturnSummarySchema.optional(),
  commerce: OrderCommerceDetailsSchema.optional(),
  header: OrderSummarySchema,
  lines: z.array(OrderDetailLineSchema),
  cancellation: OrderCancellationSchema.nullable(),
  fulfillmentProgress: FulfillmentProgressSchema,
});

export type OrderDetailResponse = z.infer<typeof OrderDetailResponseSchema>;

/**
 * Staff fulfillment of an ONLINE order (POST /orders/{orderId}/fulfillments). The client names the lines
 * and quantities explicitly (so an Idempotency-Key replay carries the identical intent); the server
 * resolves the stock location from the order's own reservations, and the client never chooses it.
 */
export const FulfillOrderRequestSchema = z
  .object({
    lines: z
      .array(
        z.object({ lineNumber: PositiveIntegerSchema, quantity: PositiveIntegerSchema }).strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type FulfillOrderRequest = z.infer<typeof FulfillOrderRequestSchema>;

/** Staff cancellation of an unfulfilled ONLINE order (POST /orders/{orderId}/cancel). */
export const CancelOrderRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();
export type CancelOrderRequest = z.infer<typeof CancelOrderRequestSchema>;
