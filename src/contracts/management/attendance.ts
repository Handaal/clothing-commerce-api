import { z } from "zod";
import { paginated } from "../common/pagination";
import { NonNegativeIntegerSchema } from "../common/serialization";

const DateTimeSchema = z.string().datetime({ offset: true });

/**
 * A single attendance entry as projected on read. `workedMinutes` is derived from clock_in/clock_out by
 * the database (never stored) and is null while the entry is still open. Member and branch display
 * fields are joined for presentation and may be null (e.g. an identity with no display name yet).
 */
export const AttendanceEntrySchema = z.object({
  id: z.uuid(),
  membershipId: z.uuid(),
  memberDisplayName: z.string().nullable(),
  memberEmail: z.string().nullable(),
  branchId: z.uuid().nullable(),
  branchName: z.string().nullable(),
  clockIn: DateTimeSchema,
  clockOut: DateTimeSchema.nullable(),
  workedMinutes: NonNegativeIntegerSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});

/** Response of clock-in / clock-out: the entry that was opened or closed. */
export const AttendanceClockResponseSchema = z.object({ entry: AttendanceEntrySchema });

/** The signed-in member's own attendance: current open entry (if any) + recent entries, newest first. */
export const MyAttendanceResponseSchema = z.object({
  openEntry: AttendanceEntrySchema.nullable(),
  entries: z.array(AttendanceEntrySchema),
});

/** Tenant-wide, keyset-paginated management list of attendance entries. */
export const AttendanceListResponseSchema = paginated(AttendanceEntrySchema);

/**
 * Clock-in request body. `branchId` is optional context — the POS register's branch — recorded on the
 * entry for reporting. Clock-out carries no body (the open entry is resolved from the actor).
 */
export const ClockInRequestSchema = z
  .object({ branchId: z.uuid().nullable().optional() })
  .strict();
export const ClockOutRequestSchema = z.object({}).strict();

export type AttendanceEntry = z.infer<typeof AttendanceEntrySchema>;
export type AttendanceClockResponse = z.infer<typeof AttendanceClockResponseSchema>;
export type MyAttendanceResponse = z.infer<typeof MyAttendanceResponseSchema>;
export type AttendanceListResponse = z.infer<typeof AttendanceListResponseSchema>;
export type ClockInRequest = z.infer<typeof ClockInRequestSchema>;
export type ClockOutRequest = z.infer<typeof ClockOutRequestSchema>;
