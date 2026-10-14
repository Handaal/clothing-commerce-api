import { z } from "zod";
import { SupplierStatusSchema } from "../contracts/management/suppliers";
export const SupplierPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(1000).optional(),
  })
  .strict();
export const SupplierListQuerySchema = SupplierPageQuerySchema.extend({
  search: z.string().trim().min(1).max(200).optional(),
  status: SupplierStatusSchema.optional(),
});
export const SupplierPathSchema = z.object({ supplierId: z.uuid() });
export const SupplierPurchasePathSchema = z.object({ purchaseId: z.uuid() });
export const SupplierReminderPathSchema = z.object({ reminderId: z.uuid() });
export const SupplierPurchaseListQuerySchema = SupplierPageQuerySchema.extend({
  supplierId: z.uuid().optional(),
});
export const SupplierReminderListQuerySchema = z
  .object({
    supplierId: z.uuid().optional(),
    status: z.enum(["pending", "done"]).optional(),
    dueOnly: z.coerce.boolean().optional(),
  })
  .strict();
export type SupplierListQuery = z.infer<typeof SupplierListQuerySchema>;
export type SupplierPageQuery = z.infer<typeof SupplierPageQuerySchema>;
export type SupplierPurchaseListQuery = z.infer<typeof SupplierPurchaseListQuerySchema>;
export type SupplierReminderListQuery = z.infer<typeof SupplierReminderListQuerySchema>;
