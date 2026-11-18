import { z } from "zod";
import {
  CurrencySchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
} from "../common/serialization";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PayrollCycleSettingsSchema = z.object({
  enabled: z.boolean(),
  anchorDay: z.number().int().min(1).max(28),
});
export const PayrollCyclePaymentSchema = z.object({
  id: z.uuid(),
  periodStart: DateSchema,
  periodEnd: DateSchema,
  totalMinor: NonNegativeIntegerSchema,
  currency: CurrencySchema,
  paidBy: z.uuid(),
  paidAt: IsoDateTimeSchema,
  notes: z.string().nullable(),
});
export const PayrollDueSchema = z.object({
  due: z.boolean(),
  periodStart: DateSchema,
  periodEnd: DateSchema,
  totalMinor: NonNegativeIntegerSchema,
  currency: CurrencySchema,
  payment: PayrollCyclePaymentSchema.nullable(),
});
export const MarkPayrollPaidRequestSchema = z
  .object({ notes: z.string().trim().max(500).nullable().optional() })
  .strict();

export type PayrollCycleSettings = z.infer<typeof PayrollCycleSettingsSchema>;
export type PayrollCyclePayment = z.infer<typeof PayrollCyclePaymentSchema>;
export type PayrollDue = z.infer<typeof PayrollDueSchema>;
export type MarkPayrollPaidRequest = z.infer<typeof MarkPayrollPaidRequestSchema>;
