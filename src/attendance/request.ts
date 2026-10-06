import { z } from "zod";

export const AttendanceListQuerySchema = z
  .object({
    membershipId: z.uuid().optional(),
    branchId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const MyAttendanceQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Shared [from, to] calendar-date window for payroll, adjustments and the leave log. Both bounds are
// required and `from` must not be after `to`; the window is small and bounded by the UI's quick ranges.
export const DateRangeQuerySchema = z
  .object({ from: CalendarDate, to: CalendarDate })
  .strict()
  .refine((v) => v.from <= v.to, "`from` must not be after `to`.");

export const MembershipPathSchema = z.object({ membershipId: z.uuid() });
export const AdjustmentPathSchema = z.object({ adjustmentId: z.uuid() });
export const AttendanceEntryPathSchema = z.object({ entryId: z.uuid() });

export type AttendanceListQuery = z.infer<typeof AttendanceListQuerySchema>;
export type MyAttendanceQuery = z.infer<typeof MyAttendanceQuerySchema>;
export type DateRangeQuery = z.infer<typeof DateRangeQuerySchema>;
