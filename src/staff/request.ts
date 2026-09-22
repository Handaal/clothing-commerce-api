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

/**
 * Add Staff is an exact-email lookup, never a directory search: the only input is a required `email`.
 * Whitespace is trimmed here; case is normalized in the security-definer function (single source of
 * truth). There is deliberately no display-name, partial/substring, or wildcard parameter, and no
 * pagination — the endpoint confirms a specific account, it does not browse the global identity store.
 */
export const EligibleIdentityLookupSchema = z
  .object({
    email: z.string().trim().min(1).max(320),
  })
  .strict();

export const StaffPathSchema = z.object({ membershipId: z.uuid() });
export const StaffAssignmentPathSchema = z.object({
  membershipId: z.uuid(),
  assignmentId: z.uuid(),
});

export type StaffListQuery = z.infer<typeof StaffListQuerySchema>;
export type EligibleIdentityLookup = z.infer<typeof EligibleIdentityLookupSchema>;
