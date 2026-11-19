import { z } from "zod";
import {
  ReturnRequestPreferenceSchema,
  ReturnRequestReasonSchema,
  ReturnRequestStatusSchema,
} from "../storefront/after-purchase";

/**
 * Customer return requests as staff see them (SDK 0.48). Listing needs `returns.read`; deciding needs
 * `returns.create` in the order's brand. A request moves no stock or money: staff arrange the pickup or
 * exchange, then mark it completed.
 */
export const ReturnRequestSchema = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  orderId: z.string().uuid(),
  orderNumber: z.string(),
  brandId: z.string().uuid(),
  status: ReturnRequestStatusSchema,
  preference: ReturnRequestPreferenceSchema,
  customerNote: z.string().nullable(),
  staffNote: z.string().nullable(),
  customerName: z.string().nullable(),
  customerPhone: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
  lines: z.array(
    z.object({
      lineNumber: z.number().int().positive(),
      productName: z.string(),
      variantName: z.string().nullable(),
      optionSummary: z.string().nullable(),
      sku: z.string(),
      quantity: z.number().int().positive(),
      reason: ReturnRequestReasonSchema,
    }),
  ),
});
export type ReturnRequest = z.infer<typeof ReturnRequestSchema>;

export const ReturnRequestListQuerySchema = z.object({
  status: z.enum(["open", "requested", "approved", "declined", "completed", "all"]).default("open"),
  orderId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export type ReturnRequestListQuery = z.input<typeof ReturnRequestListQuerySchema>;

export const ReturnRequestListResponseSchema = z.object({
  requests: z.array(ReturnRequestSchema),
  // Requests waiting for a first decision (status "requested"), across the tenant.
  awaitingDecision: z.number().int().nonnegative(),
});
export type ReturnRequestListResponse = z.infer<typeof ReturnRequestListResponseSchema>;

export const UpdateReturnRequestStatusSchema = z
  .object({
    status: z.enum(["approved", "declined", "completed"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type UpdateReturnRequestStatus = z.infer<typeof UpdateReturnRequestStatusSchema>;
