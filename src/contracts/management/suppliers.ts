import { z } from "zod";
import { paginated } from "../common/pagination";
import { PositiveIntegerSchema } from "../common/serialization";

export const SupplierStatusSchema = z.enum(["active", "inactive"]);
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const fields = {
  name: z.string().trim().min(1).max(200),
  code: optionalText(100),
  contactPerson: optionalText(200),
  phone: optionalText(50),
  email: z.email().max(254).nullable().optional(),
  address: optionalText(1000),
  notes: optionalText(2000),
};
export const CreateSupplierRequestSchema = z.object(fields).strict();
export const UpdateSupplierRequestSchema = z
  .object({ ...fields, status: SupplierStatusSchema })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");
export const SupplierSummarySchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: fields.name,
  code: z.string().nullable(),
  status: SupplierStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export const SupplierSchema = SupplierSummarySchema.extend({
  contactPerson: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
});
export const SupplierListResponseSchema = paginated(SupplierSummarySchema);
export const SupplierReceiptSchema = z.object({
  operationId: z.uuid(),
  receivedAt: z.string().datetime({ offset: true }),
  supplierId: z.uuid(),
  supplierName: z.string(),
  supplierCode: z.string().nullable(),
  supplierReference: z.string().nullable(),
  actorMembershipId: z.uuid().nullable(),
  lines: z.array(
    z.object({
      variantId: z.uuid(),
      sku: z.string(),
      productName: z.string(),
      quantity: PositiveIntegerSchema,
      inventoryLocationId: z.uuid(),
      inventoryLocationName: z.string(),
      branchId: z.uuid().nullable(),
    }),
  ),
});
export const SupplierReceiptsResponseSchema = paginated(SupplierReceiptSchema);
export type Supplier = z.infer<typeof SupplierSchema>;
export type SupplierSummary = z.infer<typeof SupplierSummarySchema>;
export type SupplierStatus = z.infer<typeof SupplierStatusSchema>;
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequestSchema>;
export type UpdateSupplierRequest = z.infer<typeof UpdateSupplierRequestSchema>;
export type SupplierListResponse = z.infer<typeof SupplierListResponseSchema>;
export type SupplierReceipt = z.infer<typeof SupplierReceiptSchema>;
export type SupplierReceiptsResponse = z.infer<typeof SupplierReceiptsResponseSchema>;
