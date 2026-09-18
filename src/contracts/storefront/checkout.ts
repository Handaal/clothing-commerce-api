import { z } from "zod";
import {
  CurrencySchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "../common/serialization";

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
  expectedTotalMinor: NonNegativeIntegerSchema,
  expectedCurrency: CurrencySchema,
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
});
export const CheckoutResultSchema = z.object({
  orderReference: z.string().min(1),
  channel: z.literal("online"),
  status: z.literal("placed"),
  totalMinor: NonNegativeIntegerSchema,
  currency: CurrencySchema,
  payment: PaymentSummarySchema,
  fulfillmentStatus: z.literal("unfulfilled"),
});
export type CheckoutResult = z.infer<typeof CheckoutResultSchema>;
export const OrderCommerceDetailsSchema = z.object({
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
