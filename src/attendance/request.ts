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

export type AttendanceListQuery = z.infer<typeof AttendanceListQuerySchema>;
export type MyAttendanceQuery = z.infer<typeof MyAttendanceQuerySchema>;
