import { z } from "zod";
import { paginated } from "../common/pagination";

/**
 * Staff management transport contracts (Phase 2O).
 *
 * "Staff" is a management projection over the existing identity + membership + RBAC model — it is NOT a
 * new identity store and NOT an HR/payroll domain. A staff member IS a tenant Membership joined to its
 * global UserIdentity, with its current Role/AccessScope assignments. Membership lifecycle, role and
 * scope assignment are managed here; identities are provisioned out-of-band (there is no invitation
 * integration in V1), so "add staff" links an already-provisioned identity by id.
 */

const UuidSchema = z.string().uuid();
const DateTimeSchema = z.string().datetime({ offset: true });

export const StaffStatusSchema = z.enum(["invited", "active", "suspended", "deactivated"]);

/** Lifecycle transitions a manager may request. 'invited' is an internal initial state, never a target. */
export const StaffStatusTargetSchema = z.enum(["active", "suspended", "deactivated"]);

export const StaffRoleRefSchema = z.object({
  roleId: UuidSchema,
  roleName: z.string(),
  isProtected: z.boolean(),
});

export const StaffScopeTargetSchema = z.object({
  kind: z.enum(["brand", "branch", "warehouse", "inventory_location"]),
  id: UuidSchema,
});

export const StaffAssignmentSchema = z.object({
  assignmentId: UuidSchema,
  roleId: UuidSchema,
  roleName: z.string(),
  isProtectedRole: z.boolean(),
  accessScopeId: UuidSchema,
  scopeName: z.string(),
  scopeMode: z.enum(["tenant", "explicit"]),
  targets: z.array(StaffScopeTargetSchema),
  permissionKeys: z.array(z.string()),
  assignedAt: DateTimeSchema,
});

export const StaffSummarySchema = z.object({
  membershipId: UuidSchema,
  identityId: UuidSchema,
  tenantId: UuidSchema,
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  status: StaffStatusSchema,
  roles: z.array(StaffRoleRefSchema),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});

export const StaffDetailSchema = StaffSummarySchema.extend({
  invitedAt: DateTimeSchema,
  activatedAt: DateTimeSchema.nullable(),
  suspendedAt: DateTimeSchema.nullable(),
  deactivatedAt: DateTimeSchema.nullable(),
  assignments: z.array(StaffAssignmentSchema),
});

export const StaffListResponseSchema = paginated(StaffSummarySchema);

/**
 * An already-provisioned identity that may be linked as staff for this tenant. Only global-status
 * `active` identities that do NOT already hold a membership in the tenant are returned. The projection is
 * deliberately minimal and never reveals another tenant's membership relationships.
 */
export const EligibleIdentitySchema = z.object({
  identityId: UuidSchema,
  displayName: z.string().nullable(),
  primaryEmail: z.string().nullable(),
  status: z.enum(["active", "suspended", "deactivated"]),
});

export const EligibleIdentitiesResponseSchema = paginated(EligibleIdentitySchema);

const reasonField = z.string().trim().min(1).max(500).optional();

export const CreateStaffRequestSchema = z.object({ identityId: UuidSchema }).strict();

export const UpdateStaffStatusRequestSchema = z
  .object({ status: StaffStatusTargetSchema, reason: reasonField })
  .strict();

export const AssignStaffRoleRequestSchema = z
  .object({ roleId: UuidSchema, accessScopeId: UuidSchema, reason: reasonField })
  .strict();

export const UnassignStaffRoleRequestSchema = z.object({ reason: reasonField }).strict();

export type StaffStatus = z.infer<typeof StaffStatusSchema>;
export type StaffStatusTarget = z.infer<typeof StaffStatusTargetSchema>;
export type StaffRoleRef = z.infer<typeof StaffRoleRefSchema>;
export type StaffScopeTarget = z.infer<typeof StaffScopeTargetSchema>;
export type StaffAssignment = z.infer<typeof StaffAssignmentSchema>;
export type StaffSummary = z.infer<typeof StaffSummarySchema>;
export type StaffDetail = z.infer<typeof StaffDetailSchema>;
export type StaffListResponse = z.infer<typeof StaffListResponseSchema>;
export type EligibleIdentity = z.infer<typeof EligibleIdentitySchema>;
export type EligibleIdentitiesResponse = z.infer<typeof EligibleIdentitiesResponseSchema>;
export type CreateStaffRequest = z.infer<typeof CreateStaffRequestSchema>;
export type UpdateStaffStatusRequest = z.infer<typeof UpdateStaffStatusRequestSchema>;
export type AssignStaffRoleRequest = z.infer<typeof AssignStaffRoleRequestSchema>;
export type UnassignStaffRoleRequest = z.infer<typeof UnassignStaffRoleRequestSchema>;
