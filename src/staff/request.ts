import { z } from "zod";
import { StaffStatusSchema } from "../contracts/management/staff";

export const StaffListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(1000).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    status: StaffStatusSchema.optional(),
    roleId: z.uuid().optional(),
  })
  .strict();

export const EligibleIdentityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(1000).optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const StaffPathSchema = z.object({ membershipId: z.uuid() });
export const StaffAssignmentPathSchema = z.object({
  membershipId: z.uuid(),
  assignmentId: z.uuid(),
});

export type StaffListQuery = z.infer<typeof StaffListQuerySchema>;
export type EligibleIdentityQuery = z.infer<typeof EligibleIdentityQuerySchema>;
