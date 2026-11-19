import { z } from "zod";

/**
 * Storefront sign-ups as seen by the brand's owners/managers (SDK 0.47). Newest first. Gated by the
 * same commerce read permission as customers (`orders.read`), since these are customer contacts.
 */
export const SubscriberSummarySchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  brandId: z.string().uuid().nullable(),
  source: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type SubscriberSummary = z.infer<typeof SubscriberSummarySchema>;

export const SubscriberListResponseSchema = z.object({
  subscribers: z.array(SubscriberSummarySchema),
  // Every sign-up for the tenant, not just this page.
  total: z.number().int().nonnegative(),
});
export type SubscriberListResponse = z.infer<typeof SubscriberListResponseSchema>;

export const SubscriberListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional().default(200),
});
