# Staff Management Core (Phase 2O)

Operational access management for the staff who use the platform. Staff management lets an authorized
owner/manager add staff, control their access status, and assign the roles and access scopes that grant
authority. It is **not** an HR/payroll system.

- **Migration:** [`supabase/migrations/20260922180000_create_staff_management.sql`](../../supabase/migrations/20260922180000_create_staff_management.sql)
- **Contracts:** [`src/contracts/management/staff.ts`](../../src/contracts/management/staff.ts)
- **Domain:** [`src/staff/`](../../src/staff) (`service.ts`, `repository.ts`, `request.ts`, `errors.ts`)
- **Routes:** [`app/api/v1/staff/`](../../app/api/v1/staff)
- **SDK:** `@shifted/clothing-commerce-sdk@0.10.0` (`listStaff`, `listEligibleStaffIdentities`,
  `getStaffMember`, `createStaff`, `updateStaffStatus`, `assignStaffRole`, `unassignStaffRole`)
- **DB/behaviour proof:** `pnpm test:staff:persistence`; **RLS:** `pnpm test:staff:rls`

## 1. Staff is a projection, not a new model

Phase 2O introduces **no** new identity or RBAC model and **no** `Employee` table. It manages the
existing foundational tables directly, projecting them into a "Staff" view:

| Staff field               | Source                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `membershipId`            | `memberships.id`                                                                          |
| `identityId`              | `memberships.user_identity_id`                                                            |
| `tenantId`                | `memberships.tenant_id`                                                                   |
| `displayName`, `email`    | `user_identities.display_name`, `user_identities.primary_email`                           |
| `status`                  | `memberships.status`                                                                      |
| `createdAt` / `updatedAt` | `memberships` timestamps                                                                  |
| `roles`                   | current (`unassigned_at is null`) `membership_role_assignments` → `roles`                 |
| `assignments` (detail)    | role + `access_scopes` (mode + brand/branch/warehouse/location targets) + permission keys |

`UserIdentity` ≠ `Membership` and `Role` ≠ `Permission` ≠ `Scope` are preserved. Phone is not projected
because `user_identities` stores none. Clerk identity data is not duplicated.

## 2. Invitation / provisioning decision

There is **no Clerk invitation integration** in the platform — Clerk is only a request verifier. V1 staff
management therefore operates **membership-side over already-provisioned identities**: `POST /api/v1/staff`
creates a `Membership` for an existing `UserIdentity` referenced by `identityId`. The new membership is
created **active** (there is no acceptance handshake to gate it). External invitation/email delivery is
**explicitly deferred** — no fake invite flow, no passwords, no local credential store.

### Identity discovery (making Add Staff usable)

Because `POST /api/v1/staff` needs an `identityId`, a manager must be able to find one without typing a
raw UUID. `GET /api/v1/staff/eligible-identities` provides that lookup:

- requires the same **tenant-wide `staff.manage`** grant as adding staff;
- bounded, keyset-paginated, stable id order; case-insensitive literal substring `search` on display
  name / email (`position()`, never interpolated LIKE);
- returns a **minimal projection** — `{ identityId, displayName, primaryEmail, status }` — and **never**
  provider bindings, tokens, or any tenant/membership relationship;
- **excludes** identities that already hold a membership in this tenant (any status — the
  `(tenant, identity)` unique constraint would otherwise block re-linking);
- **eligibility rule (identity status):** only globally `active` identities are returned. A `suspended`
  or `deactivated` `UserIdentity` cannot authorize (the context resolver rejects a non-active identity),
  so linking one would create a membership that can never be used. `create_staff` independently rejects a
  non-active identity with `IDENTITY_INACTIVE` (`ST423`) as defense in depth.

Discovery **does not** create identities, send invitations, or modify Clerk.

> **Directory-exposure note (reviewed):** `UserIdentity` is platform-global, and the "link existing
> identity" model inherently requires a global lookup, so an authorized `staff.manage` manager can
> discover any active, non-member identity — including people who are staff only in another tenant. The
> projection deliberately carries no tenant/membership field, so **no cross-tenant membership relationship
> is ever revealed** (only the same name/email you would need to invite someone). Exclusion is strictly
> per-tenant. Narrowing discovery further (e.g. exact-email-only lookup) is a possible future hardening if
> a stricter directory-privacy posture is required.

## 3. Membership lifecycle

The existing `memberships.status` enum drives lifecycle. V1 exposes three transition targets and maps
them to the canonical states:

| Target (API)  | Stored status | Meaning                     | Reversible?       |
| ------------- | ------------- | --------------------------- | ----------------- |
| `active`      | `active`      | can exercise permissions    | —                 |
| `suspended`   | `suspended`   | INACTIVE — cannot authorize | yes → `active`    |
| `deactivated` | `deactivated` | REVOKED — cannot authorize  | **no (terminal)** |

`invited` is an internal initial state and is never a transition target. The context resolver already
rejects any membership whose status is not `active`, so a suspended or revoked staff member cannot
exercise application permissions immediately and server-side. Transitions never delete rows, so
historical order/receipt/return actor references remain interpretable. `PATCH /api/v1/staff/{id}` performs
the transition; `deactivated → active` is refused (`STAFF_CONFLICT`).

## 4. Role and scope assignment

Roles carry permissions (`role_permissions`); a **role + access scope** pair is assigned to a membership
via `membership_role_assignments`. V1 assigns **existing** roles and **existing** access scopes by id
(creating roles/scopes/targets is out of scope). A membership may hold multiple assignments.

- `POST /api/v1/staff/{membershipId}/role-assignments` — assign `{ roleId, accessScopeId }`.
- `DELETE /api/v1/staff/{membershipId}/role-assignments/{assignmentId}` — revoke (history-preserving:
  sets `unassigned_at`, never deletes).

Protected roles (`roles.is_protected`) are preserved: assignment is allowed only within the
anti-escalation rule below, and role **mutation/deletion** remains out of scope (guarded elsewhere by
`role-governance.ts`). Assignments are tenant-safe — the role, scope and membership must all belong to the
caller's tenant (enforced by tenant-filtered `WHERE` clauses and composite FKs), so scope can never
silently escalate across tenants. Scope changes take effect on the next authorization because the context
resolver reads assignments live.

## 5. Anti-escalation rule (V1)

**Managing staff requires a tenant-wide `staff.manage` grant** (a brand/branch-scoped grant is
insufficient — the shared authorizer denies a permission-only request without a tenant-wide covering
assignment).

**Subset-of-own-permissions:** a caller may assign a role only if **every active permission the role
carries is a permission the caller themselves currently holds tenant-wide**. The caller's permission set
is computed in SQL from the actor membership (never trusted from the client); a role carrying any
permission outside that set is rejected with `STAFF_PRIVILEGE_ESCALATION` (403). This prevents a manager
from granting authority they do not themselves hold.

## 6. Self-lockout / last-admin protection

There is **no "owner" role-name** concept; ownership is expressed purely through permissions. The V1
invariant is defined against the real permission model:

> A tenant must always retain **at least one `active` membership that holds `staff.manage` tenant-wide.**

Every lifecycle change (`suspend`/`deactivate`) and every unassignment recomputes the count of such
"staff administrator" memberships **after** applying the change, inside the same serialized transaction,
and rolls back with `LAST_STAFF_ADMIN` (409) if it would reach zero. This protects against deactivating,
suspending, or de-privileging the final staff administrator — including yourself.

## 7. Permissions

Two permissions are seeded (append-only, `on conflict do nothing`):

- `staff.read` — read staff memberships, roles, scopes and status.
- `staff.manage` — add, activate/suspend/revoke, and assign roles/scopes.

Both are reported as tenant-wide capability guidance on `GET /me/context` under `access.staff`
(`{ canRead, canManage }`). This is UX guidance only — every endpoint re-authorizes server-side.

## 8. Idempotency

All four writes require an `Idempotency-Key` header. The shared `public.staff_commands` ledger stores the
canonical intent + response per `(tenant, normalized_key)`; an exact replay returns the original response,
and the same key with a different intent returns `IDEMPOTENCY_CONFLICT` (409). Retries never create
duplicate memberships or duplicate active assignments (the latter is additionally backstopped by the
existing current-assignment unique index).

## 9. Database security

- New private schema `staff_private` holds all logic in hardened `security definer` functions
  (`search_path=''`); only the transport (`service_role`) may execute the six entry points, and the
  internal idempotency/permission/admin-count helpers are not granted to anyone.
- A dedicated `staff_writer` role (nologin, **never** `bypassrls`, never a table owner) owns the functions
  and is granted exactly the DML it needs plus `using(true)` read/write policies on the managed foundational
  tables. Tenant isolation comes from the proof-supplied tenant id in every `WHERE`, identical to the
  suppliers domain. `staff_writer` has **no** `DELETE` on memberships or assignments (history is preserved)
  and cannot mint roles.
- Clients (`anon`, `authenticated`) retain no direct mutation path; `service_role` cannot read the private
  command-intent ledger.

## 10. Testing

- `pnpm test:staff:persistence` — real-PostgreSQL behaviour proof: identity discovery (search hit,
  deactivated-never-eligible, post-link per-tenant exclusion), create + idempotent replay/conflict,
  inactive-identity and duplicate-membership rejection, tenant-isolated list/search, subset assignment,
  anti-escalation block, cross-tenant role/membership rejection, history-preserving unassign, full
  lifecycle (suspend → reactivate → revoke → terminal), last-admin protection on suspend and unassign,
  and the two-admin case (an admin may step down while another admin satisfies the invariant). Wired into
  Linux CI alongside `pnpm test:staff:rls`. Real authorization-layer denial of suspended/deactivated
  memberships is covered by `tests/authorization/tenant-lifecycle.test.ts` (`MEMBERSHIP_INACTIVE`).
- `pnpm test:staff:rls` — pgTAP grant/policy/role-privilege assertions on an ownership-validated disposable
  Supabase project (Linux CI authoritative; the local Supabase stack is required).
- `pnpm test` — contract/service unit tests (`tests/staff/`, `packages/sdk/src/staff.test.ts`) plus the
  OpenAPI structure/drift snapshot including the four staff paths.

## 11. Development vs production & known limitations

Development uses disposable, ownership-marked databases per
[test infrastructure safety](../platform/current-v1-state.md#h-test-infrastructure-safety-mandatory-lesson).
Production authorization semantics are identical; only the identity provider configuration differs.

**Deferred (not HR):** payroll, salaries, attendance, shifts, scheduling, leave, timesheets, performance
reviews, recruitment/ATS, employee files, contracts, commissions, and HR documents are explicitly out of
scope and no HR domain exists. Also deferred: external invitation/email delivery, self-service identity
provisioning, and creating/editing roles, access scopes, or scope targets (assignment consumes existing
ones). Admin Mobile integration of this surface lands in a later change.
