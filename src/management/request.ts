import { z } from "zod";

import { OrderChannelSchema, OrderStatusSchema, ProductStatusSchema } from "../contracts";

/**
 * Inbound query-parameter contracts for the management list routes. `limit` defaults to 25 and is bound
 * to [1, 100]; a bad limit, bad uuid filter, or bad enum is a 400. `cursor` is validated for shape here
 * and decoded (with its own INVALID_CURSOR check) inside the read service.
 */

const LimitSchema = z.coerce.number().int().min(1).max(100).optional().default(25);
const CursorSchema = z.string().optional();

export const ProductListQuerySchema = z.object({
  brandId: z.string().uuid().optional(),
  status: ProductStatusSchema.optional(),
  limit: LimitSchema,
  cursor: CursorSchema,
});

export const InventoryListQuerySchema = z.object({
  inventoryLocationId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  limit: LimitSchema,
  cursor: CursorSchema,
});

export const OrderListQuerySchema = z.object({
  channel: OrderChannelSchema.optional(),
  brandId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  status: OrderStatusSchema.optional(),
  limit: LimitSchema,
  cursor: CursorSchema,
});

export const CustomerListQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  limit: LimitSchema,
  cursor: CursorSchema,
});

export const CustomerOrdersQuerySchema = z.object({
  limit: LimitSchema,
  cursor: CursorSchema,
});

// Phone lookup for the register. Kept permissive here (min length only); the service normalizes to the
// stored E.164 form before matching.
export const CustomerLookupQuerySchema = z.object({
  phone: z.string().trim().min(1).max(32),
});

export const ProductPathSchema = z.object({ productId: z.string().uuid() });
export const OrderPathSchema = z.object({ orderId: z.string().uuid() });
export const CustomerPathSchema = z.object({ customerId: z.string().uuid() });
export const VariantPathSchema = z.object({ variantId: z.string().uuid() });
export const MediaPathSchema = z.object({ mediaId: z.string().uuid() });
export const StorefrontProductSlugPathSchema = z.object({ slug: z.string().min(1).max(200) });

// Public Storefront read query. The tenant the storefront serves is an explicit parameter (published
// catalog is public data); brand is an optional narrowing. limit is bounded to [1, 200].
export const StorefrontListQuerySchema = z.object({
  tenantId: z.string().uuid(),
  brandId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export const StorefrontContextQuerySchema = z.object({
  tenantId: z.string().uuid(),
});

/**
 * Reads exactly the known keys from a URL query string, mapping absent or empty values to undefined so
 * the schemas apply their defaults/optionality cleanly (an empty ?limit= is treated as unset, never 0).
 */
export function queryRecord(
  searchParams: URLSearchParams,
  keys: readonly string[],
): Record<string, string | undefined> {
  const record: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = searchParams.get(key);
    record[key] = value === null || value === "" ? undefined : value;
  }
  return record;
}
