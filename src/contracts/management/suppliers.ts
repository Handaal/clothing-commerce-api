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
const MoneyMinorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PositiveMoneyMinorSchema = MoneyMinorSchema.refine((value) => value > 0, {
  message: "Amount must be greater than zero.",
});
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/u);
const SupplierPurchaseLineRequestSchema = z
  .object({
    variantId: z.uuid(),
    quantity: PositiveIntegerSchema,
    unitCostMinor: MoneyMinorSchema,
  })
  .strict();
export const RecordSupplierPurchaseRequestSchema = z
  .object({
    supplierId: z.uuid(),
    inventoryLocationId: z.uuid(),
    supplierReference: z.string().trim().min(1).max(200).nullable().optional(),
    paidMinor: MoneyMinorSchema.optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().min(1).max(500).nullable().optional(),
    lines: z.array(SupplierPurchaseLineRequestSchema).min(1).max(100),
  })
  .strict();
export const SupplierPurchaseItemSchema = z.object({
  id: z.uuid(),
  lineNumber: z.number().int().positive(),
  variantId: z.uuid(),
  sku: z.string(),
  productName: z.string(),
  quantity: PositiveIntegerSchema,
  unitCostMinor: MoneyMinorSchema,
  lineTotalMinor: MoneyMinorSchema,
});
export const SupplierPurchaseSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  supplierCode: z.string().nullable(),
  inventoryOperationId: z.uuid(),
  inventoryLocationId: z.uuid(),
  inventoryLocationName: z.string(),
  supplierReference: z.string().nullable(),
  currency: CurrencySchema,
  totalMinor: MoneyMinorSchema,
  initialPaidMinor: MoneyMinorSchema,
  effectivePaidMinor: MoneyMinorSchema,
  outstandingMinor: MoneyMinorSchema,
  occurredAt: z.string().datetime({ offset: true }),
  notes: z.string().nullable(),
  actorMembershipId: z.uuid(),
  createdAt: z.string().datetime({ offset: true }),
});
export const SupplierPurchasesResponseSchema = paginated(SupplierPurchaseSchema);
export const SupplierPurchaseItemsResponseSchema = z.object({
  items: z.array(SupplierPurchaseItemSchema),
});
export const RecordSupplierPaymentRequestSchema = z
  .object({
    amountMinor: PositiveMoneyMinorSchema,
    paidAt: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();
export const SupplierPaymentSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  currency: CurrencySchema,
  amountMinor: PositiveMoneyMinorSchema,
  paidAt: z.string().datetime({ offset: true }),
  notes: z.string().nullable(),
  actorMembershipId: z.uuid(),
  createdAt: z.string().datetime({ offset: true }),
});
export const SupplierPaymentsResponseSchema = paginated(SupplierPaymentSchema);
export const SupplierDueSchema = z.object({
  supplierId: z.uuid(),
  supplierName: z.string(),
  supplierCode: z.string().nullable(),
  supplierStatus: SupplierStatusSchema,
  currency: CurrencySchema,
  purchasedMinor: MoneyMinorSchema,
  paidMinor: MoneyMinorSchema,
  outstandingMinor: MoneyMinorSchema,
});
export const SupplierDuesResponseSchema = z.object({ items: z.array(SupplierDueSchema) });
export const SupplierReminderStatusSchema = z.enum(["pending", "done"]);
export const CreateSupplierReminderRequestSchema = z
  .object({
    supplierId: z.uuid(),
    dueDate: z.iso.date(),
    amountMinor: PositiveMoneyMinorSchema.nullable().optional(),
    note: z.string().trim().min(1).max(500).nullable().optional(),
    leadDays: z.number().int().min(0).max(365).default(3),
    notify: z.boolean().default(true),
  })
  .strict();
export const UpdateSupplierReminderRequestSchema = z
  .object({
    supplierId: z.uuid().optional(),
    dueDate: z.iso.date().optional(),
    amountMinor: PositiveMoneyMinorSchema.nullable().optional(),
    note: z.string().trim().min(1).max(500).nullable().optional(),
    leadDays: z.number().int().min(0).max(365).optional(),
    notify: z.boolean().optional(),
    status: SupplierReminderStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");
export const SupplierReminderSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  dueDate: z.iso.date(),
  amountMinor: MoneyMinorSchema.nullable(),
  currency: CurrencySchema,
  note: z.string().nullable(),
  leadDays: z.number().int().min(0).max(365),
  notify: z.boolean(),
  status: SupplierReminderStatusSchema,
  isDue: z.boolean(),
  isOverdue: z.boolean(),
  actorMembershipId: z.uuid(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export const SupplierRemindersResponseSchema = z.object({ items: z.array(SupplierReminderSchema) });
export const DeleteSupplierReminderResponseSchema = z.object({ id: z.uuid() });
export type Supplier = z.infer<typeof SupplierSchema>;
export type SupplierSummary = z.infer<typeof SupplierSummarySchema>;
export type SupplierStatus = z.infer<typeof SupplierStatusSchema>;
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequestSchema>;
export type UpdateSupplierRequest = z.infer<typeof UpdateSupplierRequestSchema>;
export type SupplierListResponse = z.infer<typeof SupplierListResponseSchema>;
export type SupplierReceipt = z.infer<typeof SupplierReceiptSchema>;
export type SupplierReceiptsResponse = z.infer<typeof SupplierReceiptsResponseSchema>;
export type RecordSupplierPurchaseRequest = z.infer<typeof RecordSupplierPurchaseRequestSchema>;
export type SupplierPurchase = z.infer<typeof SupplierPurchaseSchema>;
export type SupplierPurchaseItem = z.infer<typeof SupplierPurchaseItemSchema>;
export type SupplierPurchasesResponse = z.infer<typeof SupplierPurchasesResponseSchema>;
export type SupplierPurchaseItemsResponse = z.infer<typeof SupplierPurchaseItemsResponseSchema>;
export type RecordSupplierPaymentRequest = z.infer<typeof RecordSupplierPaymentRequestSchema>;
export type SupplierPayment = z.infer<typeof SupplierPaymentSchema>;
export type SupplierPaymentsResponse = z.infer<typeof SupplierPaymentsResponseSchema>;
export type SupplierDue = z.infer<typeof SupplierDueSchema>;
export type SupplierDuesResponse = z.infer<typeof SupplierDuesResponseSchema>;
export type CreateSupplierReminderRequest = z.infer<typeof CreateSupplierReminderRequestSchema>;
export type UpdateSupplierReminderRequest = z.infer<typeof UpdateSupplierReminderRequestSchema>;
export type SupplierReminder = z.infer<typeof SupplierReminderSchema>;
export type SupplierReminderStatus = z.infer<typeof SupplierReminderStatusSchema>;
export type SupplierRemindersResponse = z.infer<typeof SupplierRemindersResponseSchema>;
