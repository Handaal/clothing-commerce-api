import { z } from "zod";

/**
 * Storefront email sign-up (drop alerts / newsletter), SDK 0.47. Public and unauthenticated. The
 * response is the same whether or not the address was already on the list, so it never reveals who
 * has signed up.
 */
export const StorefrontSubscribeRequestSchema = z
  .object({
    tenantId: z.string().uuid(),
    brandId: z.string().uuid().optional(),
    email: z.string().trim().toLowerCase().email().max(254),
    // Where on the site the sign-up came from (e.g. "home", "footer"); kebab-case.
    source: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/u)
      .optional(),
  })
  .strict();
export type StorefrontSubscribeRequest = z.infer<typeof StorefrontSubscribeRequestSchema>;

export const StorefrontSubscribeResponseSchema = z.object({ subscribed: z.literal(true) });
export type StorefrontSubscribeResponse = z.infer<typeof StorefrontSubscribeResponseSchema>;
