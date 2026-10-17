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
