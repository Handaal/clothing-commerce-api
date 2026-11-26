import { z } from "zod";
import {
  CurrencySchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "../common/serialization";
import { AppliedPromotionSchema, PromotionCodeInputSchema } from "../common/promotion-pricing";
import { DeliveryZoneCodeSchema, DeliveryZoneRefSchema } from "./delivery";

export const CustomerContactSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).nullable(),
  // Require an explicit international number; never guess a country from an address.
  phone: z
    .string()
    .trim()
    .max(25)
    .regex(/^\+[1-9](?:[ ()-]*[0-9]){6,14}$/),
});
export const DeliveryAddressSchema = z.strictObject({
  recipientName: z.string().trim().min(1).max(200),
  phone: CustomerContactSchema.shape.phone,
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullable(),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().max(100).nullable(),
  postalCode: z.string().trim().max(30).nullable(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  notes: z.string().trim().max(500).nullable(),
  // Delivery area (e.g. "EG-C"). Required when the brand has delivery zones; drives the delivery fee.
  zoneCode: DeliveryZoneCodeSchema.optional(),
});
export const CheckoutRequestSchema = z.strictObject({
  tenantId: z.uuid(),
  brandId: z.uuid(),
  lines: z
    .array(z.strictObject({ variantId: z.uuid(), quantity: PositiveIntegerSchema.max(10000) }))
    .min(1)
    .max(100),
  customer: CustomerContactSchema,
  delivery: DeliveryAddressSchema,
  paymentMethod: z.literal("cash_on_delivery"),
  // expectedTotalMinor is the NET total the client last previewed (after any promotion). A stale value
  // (price OR promotion changed) deterministically re-quotes via PRICE_CHANGED.
  expectedTotalMinor: NonNegativeIntegerSchema,
  expectedCurrency: CurrencySchema,
  // At most one entered code. A code that does not apply fails the checkout with PROMOTION_UNAVAILABLE.
  promotionCode: PromotionCodeInputSchema.nullable().optional(),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
export const PaymentStatusSchema = z.enum([
  "pending",
  "authorized",
  "captured",
  "failed",
  "cancelled",
  "refunded",
]);
export const PaymentSummarySchema = z.object({
  method: z.enum(["cash", "cash_on_delivery", "electronic"]),
  provider: z.string().nullable(),
  status: PaymentStatusSchema,
  amountMinor: NonNegativeIntegerSchema,
  currency: CurrencySchema,
  // When the payment was captured (online cash on delivery: when staff marked it collected).
  capturedAt: z.string().nullable().optional(),
});
export const CheckoutResultSchema = z.object({
  orderReference: z.string().min(1),
  channel: z.literal("online"),
  status: z.literal("placed"),
  totalMinor: NonNegativeIntegerSchema,
  currency: CurrencySchema,
  // Promotion breakdown (additive; existing non-strict consumers ignore these). totalMinor is the net.
  grossSubtotalMinor: NonNegativeIntegerSchema,
  discountTotalMinor: NonNegativeIntegerSchema,
  // Delivery fee included in totalMinor (absent on results placed before delivery fees existed).
  deliveryFeeMinor: NonNegativeIntegerSchema.optional(),
  deliveryZone: DeliveryZoneRefSchema.nullable().optional(),
  promotion: AppliedPromotionSchema.nullable(),
  payment: PaymentSummarySchema,
  fulfillmentStatus: z.literal("unfulfilled"),
});
export type CheckoutResult = z.infer<typeof CheckoutResultSchema>;
export const OrderCommerceDetailsSchema = z.object({
  // Delivery fee included in the order total (0 when free or not charged).
  deliveryFeeMinor: NonNegativeIntegerSchema.optional(),
  customerId: z.uuid().nullable(),
  customer: CustomerContactSchema.nullable(),
  delivery: DeliveryAddressSchema.nullable(),
  payment: PaymentSummarySchema.nullable(),
  reservations: z.array(
    z.object({
      variantId: z.uuid(),
      inventoryLocationId: z.uuid(),
      quantity: PositiveIntegerSchema,
      consumedQuantity: NonNegativeIntegerSchema,
      status: z.enum(["active", "consumed", "released", "expired"]),
      expiresAt: z.string().nullable(),
    }),
  ),
});
export type OrderCommerceDetails = z.infer<typeof OrderCommerceDetailsSchema>;
