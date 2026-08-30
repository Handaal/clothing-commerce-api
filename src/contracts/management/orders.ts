import { z } from "zod";

import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "../common/serialization";
import { paginated } from "../common/pagination";

/**
 * Orders management DTOs. The list summary carries no fulfillment data and is served by a single query.
 * Order detail composes the order aggregate with its fulfillment progress summary, but never exposes
 * inventory-operation ids, idempotency keys, payload fingerprints, routing descriptors, or actor
 * membership internals.
 */

const UuidSchema = z.string().uuid();

export const OrderChannelSchema = z.enum(["pos", "online"]);
export type OrderChannel = z.infer<typeof OrderChannelSchema>;

export const OrderStatusSchema = z.enum(["placed", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSummarySchema = z.object({
  id: UuidSchema,
  orderNumber: z.string(),
  channel: OrderChannelSchema,
  status: OrderStatusSchema,
  brandId: UuidSchema,
  branchId: UuidSchema.nullable(),
  currency: CurrencySchema,
  totalMinor: NonNegativeIntegerSchema,
  placedAt: IsoDateTimeSchema,
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
});

export const OrderCancellationSchema = z.object({
  cancelledAt: IsoDateTimeSchema,
  reason: z.string().nullable(),
});

export const FulfillmentProgressStatusSchema = z.enum([
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
]);

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
  header: OrderSummarySchema,
  lines: z.array(OrderDetailLineSchema),
  cancellation: OrderCancellationSchema.nullable(),
  fulfillmentProgress: FulfillmentProgressSchema,
});

export type OrderDetailResponse = z.infer<typeof OrderDetailResponseSchema>;
