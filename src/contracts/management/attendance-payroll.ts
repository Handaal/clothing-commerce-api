import { z } from "zod";
import { CurrencySchema, NonNegativeIntegerSchema, SafeIntegerSchema } from "../common/serialization";

const DateTimeSchema = z.string().datetime({ offset: true });
// Calendar date (YYYY-MM-DD) as projected by the payroll/adjustment read RPCs.
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NonNegativeNumber = z.number().nonnegative();

// ── Payroll report ────────────────────────────────────────────────────────────
// Money is integer minor units; hours/days are numeric. `netPayMinor` is signed (deductions can
// exceed earnings). All figures are derived on read — see attendance_private.payroll.
export const PayrollRowSchema = z.object({
  membershipId: z.uuid(),
  memberDisplayName: z.string().nullable(),
  memberEmail: z.string().nullable(),
  workedMinutes: NonNegativeIntegerSchema,
  workedHours: NonNegativeNumber,
  workedDays: NonNegativeNumber.nullable(),
  normalHours: NonNegativeNumber,
  overtimeHours: NonNegativeNumber,
  baseSalaryMinor: NonNegativeIntegerSchema,
  overtimeRateMinor: NonNegativeIntegerSchema,
  overtimeAmountMinor: NonNegativeIntegerSchema,
  bonusMinor: NonNegativeIntegerSchema,
  deductionMinor: NonNegativeIntegerSchema,
  netPayMinor: SafeIntegerSchema,
  currency: CurrencySchema,
});
export const PayrollTotalsSchema = z.object({
  baseSalaryMinor: SafeIntegerSchema,
  overtimeAmountMinor: SafeIntegerSchema,
  bonusMinor: SafeIntegerSchema,
  deductionMinor: SafeIntegerSchema,
  netPayMinor: SafeIntegerSchema,
});
export const PayrollReportResponseSchema = z.object({
  items: z.array(PayrollRowSchema),
  totals: PayrollTotalsSchema,
});

// ── Compensation ────────────────────────────────────────────────────────────
export const EmployeeCompensationSchema = z.object({
  membershipId: z.uuid(),
  baseSalaryMinor: NonNegativeIntegerSchema,
  overtimeRateMinor: NonNegativeIntegerSchema,
  normalHours: NonNegativeNumber,
  currency: CurrencySchema,
  updatedAt: DateTimeSchema,
});
export const SetCompensationRequestSchema = z
  .object({
    baseSalaryMinor: NonNegativeIntegerSchema,
    overtimeRateMinor: NonNegativeIntegerSchema,
    normalHours: NonNegativeNumber.max(10000),
    currency: CurrencySchema,
  })
  .strict();

// ── Payroll settings (tenant singleton) ───────────────────────────────────────
export const PayrollSettingsSchema = z.object({
  normalHours: NonNegativeNumber,
  shiftDurationHours: z.number().positive(),
});
export const UpdatePayrollSettingsRequestSchema = z
  .object({
    normalHours: NonNegativeNumber.max(10000),
    shiftDurationHours: z.number().positive().max(24),
  })
  .strict();

// ── Adjustments (bonus / deduction) ───────────────────────────────────────────
export const AdjustmentTypeSchema = z.enum(["bonus", "deduction"]);
export const AdjustmentSchema = z.object({
  id: z.uuid(),
  membershipId: z.uuid(),
  memberDisplayName: z.string().nullable(),
  type: AdjustmentTypeSchema,
  amountMinor: NonNegativeIntegerSchema,
  reason: z.string().nullable(),
  effectiveDate: CalendarDateSchema,
  hours: NonNegativeNumber.nullable(),
  createdAt: DateTimeSchema,
});
export const AdjustmentListResponseSchema = z.object({ items: z.array(AdjustmentSchema) });
export const CreateAdjustmentRequestSchema = z
  .object({
    membershipId: z.uuid(),
    type: AdjustmentTypeSchema,
    amountMinor: NonNegativeIntegerSchema,
    reason: z.string().trim().min(1).max(500).nullable().optional(),
    effectiveDate: CalendarDateSchema.optional(),
    hours: NonNegativeNumber.max(10000).nullable().optional(),
  })
  .strict();

// ── Leave (mid-shift permission) ──────────────────────────────────────────────
export const LeaveEntrySchema = z.object({
  id: z.uuid(),
  membershipId: z.uuid(),
  memberDisplayName: z.string().nullable(),
  branchId: z.uuid().nullable(),
  branchName: z.string().nullable(),
  leftAt: DateTimeSchema,
  returnedAt: DateTimeSchema.nullable(),
  minutes: NonNegativeIntegerSchema.nullable(),
});
export const LeaveListResponseSchema = z.object({ items: z.array(LeaveEntrySchema) });
export const LeaveClockResponseSchema = z.object({ entry: LeaveEntrySchema });
export const LeaveStartRequestSchema = z.object({ branchId: z.uuid().nullable().optional() }).strict();
export const LeaveEndRequestSchema = z.object({}).strict();

// ── Manager-sanctioned manual attendance entries ──────────────────────────────
export const CreateAttendanceEntryRequestSchema = z
  .object({
    membershipId: z.uuid(),
    branchId: z.uuid().nullable().optional(),
    clockIn: DateTimeSchema,
    clockOut: DateTimeSchema.nullable().optional(),
  })
  .strict();
export const UpdateAttendanceEntryRequestSchema = z
  .object({
    clockIn: DateTimeSchema.optional(),
    clockOut: DateTimeSchema.nullable().optional(),
    branchId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");

/** Shared response for resource deletions (adjustment / manual entry). */
export const AttendanceDeletedResponseSchema = z.object({ id: z.uuid() });

export type PayrollRow = z.infer<typeof PayrollRowSchema>;
export type PayrollTotals = z.infer<typeof PayrollTotalsSchema>;
export type PayrollReportResponse = z.infer<typeof PayrollReportResponseSchema>;
export type EmployeeCompensation = z.infer<typeof EmployeeCompensationSchema>;
export type SetCompensationRequest = z.infer<typeof SetCompensationRequestSchema>;
export type PayrollSettings = z.infer<typeof PayrollSettingsSchema>;
export type UpdatePayrollSettingsRequest = z.infer<typeof UpdatePayrollSettingsRequestSchema>;
export type AdjustmentType = z.infer<typeof AdjustmentTypeSchema>;
export type Adjustment = z.infer<typeof AdjustmentSchema>;
export type AdjustmentListResponse = z.infer<typeof AdjustmentListResponseSchema>;
export type CreateAdjustmentRequest = z.infer<typeof CreateAdjustmentRequestSchema>;
export type LeaveEntry = z.infer<typeof LeaveEntrySchema>;
export type LeaveListResponse = z.infer<typeof LeaveListResponseSchema>;
export type LeaveClockResponse = z.infer<typeof LeaveClockResponseSchema>;
export type LeaveStartRequest = z.infer<typeof LeaveStartRequestSchema>;
export type CreateAttendanceEntryRequest = z.infer<typeof CreateAttendanceEntryRequestSchema>;
export type UpdateAttendanceEntryRequest = z.infer<typeof UpdateAttendanceEntryRequestSchema>;
