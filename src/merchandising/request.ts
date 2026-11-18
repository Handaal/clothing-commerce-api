import { z } from "zod";

export const SalePathSchema = z.object({ saleId: z.string().uuid() });
export const StorefrontContentQuerySchema = z.object({
  tenantId: z.string().uuid(),
  brandId: z.string().uuid().optional(),
});
