import { z } from "zod";

import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
} from "../common/serialization";
import { paginated } from "../common/pagination";
import { OrderSummarySchema } from "./orders";

/**
 * Customers management DTOs. A customer is tenant-scoped commerce data (name/phone/email) accumulated by
 * POS captures and online checkout. The list and lookup carry lifetime aggregates (order count + spend)
 * so the storefront UI can rank and summarize without a second query; the per-customer order history is
 * served by the shared order summary shape.
 */

const UuidSchema = z.string().uuid();

export const CustomerSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  orderCount: NonNegativeIntegerSchema,
  totalSpentMinor: NonNegativeIntegerSchema,
  // Null when the customer has no placed orders yet (nothing to total/date).
  lastOrderAt: IsoDateTimeSchema.nullable(),
  currency: CurrencySchema.nullable(),
  // Outstanding installment balance in minor units (0 when nothing is owed).
  outstandingMinor: NonNegativeIntegerSchema,
});
export type CustomerSummary = z.infer<typeof CustomerSummarySchema>;

export const CustomerListResponseSchema = paginated(CustomerSummarySchema);
export type CustomerListResponse = z.infer<typeof CustomerListResponseSchema>;

// Detail is the summary plus the full contact; history is served separately (paginated orders).
export const CustomerDetailResponseSchema = CustomerSummarySchema;
export type CustomerDetailResponse = z.infer<typeof CustomerDetailResponseSchema>;

export const CustomerOrdersResponseSchema = paginated(OrderSummarySchema);
export type CustomerOrdersResponse = z.infer<typeof CustomerOrdersResponseSchema>;

// Phone lookup for the register: returns the matched customer (by normalized phone) or null.
export const CustomerLookupResponseSchema = z.object({
  customer: CustomerSummarySchema.nullable(),
});
export type CustomerLookupResponse = z.infer<typeof CustomerLookupResponseSchema>;

// ---- Installments / accounts receivable ----

// Record a customer payment against their outstanding installment balance.
export const RecordCustomerPaymentRequestSchema = z
  .object({
    amountMinor: z.number().int().positive(),
    paidAt: IsoDateTimeSchema.optional(),
    notes: z.string().trim().min(1).max(500).optional().nullable(),
  })
  .strict();
export type RecordCustomerPaymentRequest = z.infer<typeof RecordCustomerPaymentRequestSchema>;

export const CustomerPaymentSchema = z.object({
  id: UuidSchema,
  customerId: UuidSchema,
  currency: CurrencySchema,
  amountMinor: NonNegativeIntegerSchema,
  // Sourced from a SECURITY DEFINER RPC via jsonb_build_object, which renders timestamptz with a numeric
  // offset (e.g. +00:00), so the offset form must be allowed (plain .datetime() accepts only a Z suffix).
  paidAt: z.string().datetime({ offset: true }),
  notes: z.string().nullable(),
  actorMembershipId: UuidSchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type CustomerPayment = z.infer<typeof CustomerPaymentSchema>;

// record_customer_payment returns the inserted payment plus the new outstanding balance.
export const RecordCustomerPaymentResponseSchema = CustomerPaymentSchema.extend({
  outstandingMinor: NonNegativeIntegerSchema,
});
export type RecordCustomerPaymentResponse = z.infer<typeof RecordCustomerPaymentResponseSchema>;

export const CustomerPaymentsResponseSchema = z.object({
  items: z.array(CustomerPaymentSchema),
});
export type CustomerPaymentsResponse = z.infer<typeof CustomerPaymentsResponseSchema>;

export const CustomerDueSchema = z.object({
  customerId: UuidSchema,
  customerName: z.string(),
  phone: z.string(),
  currency: CurrencySchema.nullable(),
  purchasedMinor: NonNegativeIntegerSchema,
  paidMinor: NonNegativeIntegerSchema,
  outstandingMinor: NonNegativeIntegerSchema,
});
export type CustomerDue = z.infer<typeof CustomerDueSchema>;

export const CustomerDuesResponseSchema = z.object({
  items: z.array(CustomerDueSchema),
});
export type CustomerDuesResponse = z.infer<typeof CustomerDuesResponseSchema>;
