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
 * An already-provisioned identity that may be linked as staff for this tenant, resolved by an EXACT
 * email lookup (not a directory search). Only global-status `active` identities that do NOT already hold
 * a membership in the tenant are returned. The projection is deliberately minimal and never reveals
 * another tenant's membership relationships. `status` is always `active` in practice (the lookup filters
 * to active identities); it is retained so the client can render the confirmed account state.
 */
export const EligibleIdentitySchema = z.object({
  identityId: UuidSchema,
  displayName: z.string().nullable(),
  primaryEmail: z.string().nullable(),
  status: z.enum(["active", "suspended", "deactivated"]),
});

/**
 * Exact-email lookup is a bounded confirmation, not a browsable page: there is no cursor and no
 * `pageInfo`. `primary_email` is not unique in the schema, so the result is an explicit 0..N list — this
 * multiplicity is a frozen part of the contract, not an implementation accident:
 *
 * - `items.length === 0` — no eligible account for that email.
 * - `items.length === 1` — an unambiguous eligible account.
 * - `items.length > 1`  — multiple provisioned identities share the exact same (normalized) email; the
 *   client MUST require explicit selection and MUST NOT silently choose one. The server never collapses
 *   the result or prefers a match.
 *
 * Order is deterministic: identity id ascending. The set is bounded server-side (currently 50 exact
 * matches); pagination is intentionally not offered for this lookup.
 */
export const EligibleIdentitiesResponseSchema = z.object({
  items: z.array(EligibleIdentitySchema),
});

/**
 * Assignment catalogs (read-only). `assign_role` consumes an EXISTING role id and an EXISTING access
 * scope id; these two lists are the canonical server-backed source of those ids. They exist so a client
 * never has to derive selectable options from assignments other staff already hold — a derivation that
 * is empty on a fresh tenant, silently drops valid-but-unused roles/scopes, and makes one member's
 * options depend on another member's memberships.
 *
 * Both catalogs are strictly SELECTION surfaces: they create, edit and delete nothing. Authoring roles,
 * scopes, scope targets and role permissions remains deferred.
 */

/**
 * A role the caller may potentially assign. Listed only when every active permission the role carries is
 * already held by the caller tenant-wide — the same subset rule `POST /role-assignments` enforces, so the
 * catalog never offers an assignment the write would reject. This is a convenience filter, NOT the
 * authorization boundary: the write re-runs the check independently, so knowing a role id grants nothing.
 * `permissionKeys` is included so a manager can see what the role actually confers before assigning it.
 * Archived roles are excluded (assignment rejects them).
 */
export const AssignableStaffRoleSchema = z.object({
  roleId: UuidSchema,
  roleName: z.string(),
  description: z.string().nullable(),
  isProtected: z.boolean(),
  permissionKeys: z.array(z.string()),
});

export const AssignableStaffRolesResponseSchema = paginated(AssignableStaffRoleSchema);

/**
 * An existing explicit scope target, projected with the `display_name` read from the referenced
 * brand/branch/warehouse/inventory location. No label is invented; every target is tenant-bound by
 * composite foreign key. This is a richer projection than `StaffScopeTarget` (which is id-only) because
 * a manager choosing a scope needs to read what it covers, not merely identify it.
 */
export const AssignableStaffScopeTargetSchema = z.object({
  kind: z.enum(["brand", "branch", "warehouse", "inventory_location"]),
  id: UuidSchema,
  name: z.string(),
});

/**
 * An existing access scope selectable for a Role+Scope assignment. Unlike roles, scopes are NOT filtered
 * against the caller: a scope carries no authority of its own, it only narrows where an assigned role's
 * permissions apply, so listing every active tenant scope cannot widen what a manager can grant. A
 * `tenant`-mode scope has no targets by construction. Archived scopes are excluded.
 */
export const AssignableStaffScopeSchema = z.object({
  accessScopeId: UuidSchema,
  scopeName: z.string(),
  description: z.string().nullable(),
  scopeMode: z.enum(["tenant", "explicit"]),
  targets: z.array(AssignableStaffScopeTargetSchema),
});

export const AssignableStaffScopesResponseSchema = paginated(AssignableStaffScopeSchema);

const reasonField = z.string().trim().min(1).max(500).optional();

export const CreateStaffRequestSchema = z.object({ identityId: UuidSchema }).strict();

/**
 * Provision a brand-new, EMAIL-LESS staff login (Connected POS floor staff) and link it as active staff in
 * one step. Unlike {@link CreateStaffRequestSchema} (which links an already-provisioned identity by id),
 * this creates the external account, the platform identity + binding, the membership, and the initial
 * role+scope assignment together — the only onboarding path for staff who have no email.
 *
 * The provider subject is deliberately NOT part of this contract: the server mints the external account
 * and records the verified subject itself. A client can never inject or choose an identity subject.
 *
 * `pin` is the sign-in secret (the external provider stores it; it is never persisted by Commerce). It is
 * constrained to a 4–8 digit numeric PIN so it is usable on a POS number pad; the external instance must be
 * configured to accept it. `username` is the instance-global sign-in identifier shown on the POS roster.
 */
export const CreateStaffLoginRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{1,30}$/, "Username must be 2–31 chars: letters, digits, . _ -"),
    pin: z.string().regex(/^[0-9]{4,8}$/, "PIN must be 4–8 digits"),
    roleId: UuidSchema,
    accessScopeId: UuidSchema,
  })
  .strict();

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
export type AssignableStaffRole = z.infer<typeof AssignableStaffRoleSchema>;
export type AssignableStaffRolesResponse = z.infer<typeof AssignableStaffRolesResponseSchema>;
export type AssignableStaffScopeTarget = z.infer<typeof AssignableStaffScopeTargetSchema>;
export type AssignableStaffScope = z.infer<typeof AssignableStaffScopeSchema>;
export type AssignableStaffScopesResponse = z.infer<typeof AssignableStaffScopesResponseSchema>;
export type CreateStaffRequest = z.infer<typeof CreateStaffRequestSchema>;
export type CreateStaffLoginRequest = z.infer<typeof CreateStaffLoginRequestSchema>;
export type UpdateStaffStatusRequest = z.infer<typeof UpdateStaffStatusRequestSchema>;
export type AssignStaffRoleRequest = z.infer<typeof AssignStaffRoleRequestSchema>;
export type UnassignStaffRoleRequest = z.infer<typeof UnassignStaffRoleRequestSchema>;
