# Staff Management Core (Phase 2O)

Operational access management for the staff who use the platform. Staff management lets an authorized
owner/manager add staff, control their access status, and assign the roles and access scopes that grant
authority. It is **not** an HR/payroll system.

- **Migrations:** [`20260922180000_create_staff_management.sql`](../../supabase/migrations/20260922180000_create_staff_management.sql)
  (core), [`20260923180000_create_staff_assignment_catalogs.sql`](../../supabase/migrations/20260923180000_create_staff_assignment_catalogs.sql)
  (assignment catalogs)
- **Contracts:** [`src/contracts/management/staff.ts`](../../src/contracts/management/staff.ts)
- **Domain:** [`src/staff/`](../../src/staff) (`service.ts`, `repository.ts`, `request.ts`, `errors.ts`)
- **Routes:** [`app/api/v1/staff/`](../../app/api/v1/staff)
- **SDK:** `@shifted/clothing-commerce-sdk@0.11.0` (`listStaff`, `findEligibleStaffIdentitiesByEmail`,
  `listAssignableStaffRoles`, `listAssignableStaffScopes`, `getStaffMember`, `createStaff`,
  `updateStaffStatus`, `assignStaffRole`, `unassignStaffRole`)
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

### Identity resolution by exact email (making Add Staff usable)

Because `POST /api/v1/staff` needs an `identityId`, a manager must be able to find one without typing a
raw UUID. Add Staff uses **exact existing-account email lookup only** —
`GET /api/v1/staff/eligible-identities?email=<email>`. The manager enters the staff member's exact email;
the API normalizes it and returns the matching eligible account. This is deliberately a **confirmation
lookup, not a browsable directory**:

- requires the same **tenant-wide `staff.manage`** grant as adding staff;
- **exact email match only** — email is trimmed and lowercased (the same `lower(btrim(...))` convention
  roles/scopes use, normalized once in the security-definer function). There is **no display-name search,
  no partial/substring search, no wildcard search, and no pagination** — you cannot browse the global
  identity store;
- returns a **minimal projection** — `{ identityId, displayName, primaryEmail, status }` — and **never**
  provider bindings, tokens, roles, scopes, or any tenant/membership relationship;
- **excludes** identities that already hold a membership in this tenant (any status — the
  `(tenant, identity)` unique constraint would otherwise block re-linking);
- **eligibility rule (identity status):** only globally `active` identities are returned. A `suspended`
  or `deactivated` `UserIdentity` cannot authorize (the context resolver rejects a non-active identity),
  so linking one would create a membership that can never be used. `create_staff` independently rejects a
  non-active identity with `IDENTITY_INACTIVE` (`ST423`) as defense in depth;
- **enumeration-resistant:** an unknown email, an inactive/suspended/deactivated identity, and an
  identity that already holds a membership in this tenant are **indistinguishable** — all return an empty
  list. No reason-specific state is disclosed for an ineligible result.

#### Response multiplicity (frozen 0/1/N contract)

`primary_email` is **not unique** in the schema (nullable, only a not-empty check), so an exact match can
legitimately resolve more than one active, non-member identity. The response is therefore an **explicit
`0..N` list** — `{ items: EligibleIdentity[] }` — and this multiplicity is a **frozen part of the
contract**, not an implementation accident:

| `items.length` | Meaning                                  | Client requirement                                                   |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `0`            | No eligible account for that email       | Nothing to link (indistinguishable from inactive / already-a-member) |
| `1`            | An unambiguous eligible account          | May proceed to `POST /staff` with that `identityId`                  |
| `> 1`          | Several identities share the exact email | **MUST require explicit selection; MUST NOT silently choose one**    |

- **Order is deterministic:** identity id ascending (the `jsonb_agg(... order by u.id)` in the
  security-definer function). Two calls return the same order.
- **The server never collapses or prefers a match** — it does not pick the first, newest, or
  best-looking identity. Disambiguation is the client's responsibility.
- **Bounded, not paginated:** the set is capped server-side at 50 exact matches; there is no cursor and
  no `pageInfo`. Pagination is intentionally not offered for this exact-email lookup.

Resolution **does not** create identities, send invitations, browse a directory, or modify Clerk. Raw
UUID entry is not part of the normal workflow.

> **Multi-tenant note (reviewed):** `UserIdentity` is platform-global and one identity may participate in
> several tenants. An identity that is a member of Tenant B is still eligible for Tenant A (until it holds
> a Tenant A membership). Because the caller must already know the person's exact email, and the projection
> carries no tenant/membership field, **no cross-tenant membership relationship is ever revealed** — the
> lookup only confirms the account behind an email the manager already has.

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

### Assignment catalogs — the canonical source of selectable roles and scopes

Assignment consumes **existing** ids, so a manager needs a server-backed list of what exists. Two
read-only operations are that list, and they are the **only** canonical source:

| Operation                             | Returns                                                          |
| ------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/v1/staff/assignable-roles`  | `{ roleId, roleName, description, isProtected, permissionKeys }` |
| `GET /api/v1/staff/assignable-scopes` | `{ accessScopeId, scopeName, description, scopeMode, targets }`  |

Clients must **not** derive selectable options from assignments other staff already hold. That
derivation is wrong in three ways: a fresh tenant has no assignments to derive from, a valid but
currently-unused role or scope disappears, and one member's options come to depend on another member's
memberships. (Admin Mobile used that derivation as a temporary measure; these endpoints replace it.)

Shared properties:

- both require the same tenant-wide **`staff.manage`** grant as the assignment write — they are
  management-only, and a `staff.read`-only caller is denied (`PERMISSION_DENIED`);
- **current tenant only**, from the authorization proof — never a client-supplied tenant;
- **read-only.** No creation, editing or deletion of roles, scopes, targets or permissions (§5);
- only **`active`** rows are listed, because `assign_role` rejects an archived role or scope (`ST409`);
- **bounded and deterministic:** the common `{ items, pageInfo }` envelope, ordered by the tenant-unique
  `normalized_name`, with an opaque keyset cursor over that same name. Repeated reads return the same
  order; a page never repeats or skips a row.

**Role catalog anti-delegation.** A role is listed only when **every active permission it carries is
already held by the caller tenant-wide** — the identical subset predicate `assign_role` enforces,
computed from the same `staff_private.tenant_permission_keys` source of truth. So the catalog never
offers an assignment the write would reject. This is a **convenience filter, not the authorization
boundary**: `POST /role-assignments` re-runs the check independently, so a caller who guesses or
remembers a filtered-out role id still gets `STAFF_PRIVILEGE_ESCALATION` (403). A role with no active
permissions is trivially a subset and is listed — assigning it confers nothing. **No role _name_ is ever
matched or interpreted**; selection is by id and authority comes only from `role_permissions`.

**Scope catalog is not caller-filtered**, deliberately. An `AccessScope` carries no authority of its own —
it only **narrows** where an assigned role's permissions apply. Authority comes from the role, which is
already subset-filtered, so listing every active tenant scope cannot widen what a manager can grant.

**Explicit target projection.** An `explicit` scope carries its existing targets as
`{ kind, id, name }` where `kind` is `brand` / `branch` / `warehouse` / `inventory_location` and `name` is
the `display_name` read from that record. **No label is invented** — if the source has no name, there is
no name. Targets are tenant-bound twice over: `access_scope_targets` composite foreign keys pin each
target to the scope's own tenant, and the projection joins re-assert `tenant_id`. A `tenant`-mode scope
has no targets by construction.

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

### Add Staff is two commands — partial-state and recovery analysis (reviewed, retained for V1)

Adding a staff member with authority is `POST /staff` (create membership) followed by
`POST /staff/{id}/role-assignments` (assign role + scope). These are **two independent idempotent
commands, not one atomic command**, and that is retained for V1 because the intermediate state grants
**no authority at all**:

> An `active` membership with **zero** current role assignments has **zero** effective permissions.

That is a property of the authorization model, not a convention. The context resolver builds
`context.assignments` from current `membership_role_assignments`; `AuthorizationService.authorize`
rejects with `PERMISSION_DENIED` as soon as no assignment carries the requested permission, so an
assignment-less membership fails **every** permission check. Tenant membership by itself is not a grant.
The partial state therefore cannot leak authority, cannot be escalated into one, and is not a privileged
window — it is an inert record.

Given that, the two-command flow satisfies each condition required to keep it:

| Condition                      | How it holds                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independently idempotent       | Both writes require `Idempotency-Key` and go through the shared `staff_commands` ledger keyed by `(tenant, normalized_key)` (§8).                                                                                             |
| Retry is safe                  | An exact replay returns the stored response; it never creates a second membership or a second active assignment (also backstopped by the `(tenant, identity)` unique constraint and the current-assignment unique index).     |
| Partial success is recoverable | If create succeeds and assign fails, the membership persists and is visible in `GET /staff` (status `active`, `roles: []`). The manager re-issues only the assignment — no cleanup, no orphan, no repair command needed.      |
| Assignable later               | `POST /staff/{id}/role-assignments` is a standalone operation on an existing membership; the catalogs above supply the selectable role and scope. Nothing about the assignment depends on having just created the membership. |
| No accidental authority        | Zero assignments ⇒ zero permissions, as above. A member stuck in the partial state can authenticate into the tenant and do nothing.                                                                                           |

**An atomic create+assign command is therefore not proposed.** It would add a third write path and a
second escalation/last-admin checkpoint for no security or integrity gain. Clients should render the
partial state honestly — a staff member with no roles is a real, valid, powerless state, not an error —
and offer "assign a role" rather than hiding or auto-deleting the membership.

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
- `staff.manage` — add, activate/suspend/revoke, assign roles/scopes, and read the assignment catalogs.

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
  (`search_path=''`); only the transport (`service_role`) may execute the eight entry points (six core +
  the two assignment catalogs), and the internal idempotency/permission/admin-count helpers are not
  granted to anyone.
- A dedicated `staff_writer` role (nologin, **never** `bypassrls`, never a table owner) owns the functions
  and is granted exactly the DML it needs plus `using(true)` read/write policies on the managed foundational
  tables. Tenant isolation comes from the proof-supplied tenant id in every `WHERE`, identical to the
  suppliers domain. `staff_writer` has **no** `DELETE` on memberships or assignments (history is preserved)
  and cannot mint roles.
- The assignment-catalog migration adds **only `SELECT`** — on `brands`, `branches`, `warehouses` and
  `inventory_locations`, so explicit scope targets can be labelled with their real `display_name`. It
  grants no `INSERT`/`UPDATE`/`DELETE` anywhere, so role, scope, scope-target and role-permission
  **authoring remains impossible** for `staff_writer` (asserted in the RLS suite).
- Clients (`anon`, `authenticated`) retain no direct mutation path; `service_role` cannot read the private
  command-intent ledger.

## 10. Testing

- `pnpm test:staff:persistence` — real-PostgreSQL behaviour proof: exact-email identity resolution
  (Runtime J: exact hit, case/whitespace normalization, partial/display-name miss, inactive- and
  unknown-email neutrality, the `N > 1` shared-email case — both matches returned in deterministic
  id-ascending order with neither preferred, post-link per-tenant exclusion, foreign-tenant still-eligible
  with no linkage leaked), create + idempotent replay/conflict,
  inactive-identity and duplicate-membership rejection, tenant-isolated list/search, subset assignment,
  anti-escalation block, cross-tenant role/membership rejection, history-preserving unassign, full
  lifecycle (suspend → reactivate → revoke → terminal), last-admin protection on suspend and unassign,
  and the two-admin case (an admin may step down while another admin satisfies the invariant).
  Assignment catalogs: an eligible subset role and a permissionless role are offered with their
  permission keys; a role carrying a permission the caller lacks is absent **and** the direct write still
  returns `ST403`; archived roles/scopes are absent; no foreign-tenant role or scope appears in either
  direction; ordering is name-ascending and stable across repeated reads, and the keyset cursor resumes
  after the last delivered row without repeating it; every active current-tenant scope is offered with
  its mode; explicit targets project the real `display_name`, a tenant-mode scope has no targets, and a
  foreign tenant's scope targets stay bound to that foreign tenant. Wired into
  Linux CI alongside `pnpm test:staff:rls`. Real authorization-layer denial of suspended/deactivated
  memberships is covered by `tests/authorization/tenant-lifecycle.test.ts` (`MEMBERSHIP_INACTIVE`).
- `pnpm test:staff:rls` — pgTAP grant/policy/role-privilege assertions on an ownership-validated disposable
  Supabase project (Linux CI authoritative; the local Supabase stack is required).
- `pnpm test` — contract/service unit tests (`tests/staff/`, `packages/sdk/src/staff.test.ts`) plus the
  OpenAPI structure/drift snapshot including the six staff paths. The service tests assert the catalogs
  require tenant-wide `staff.manage` (a `staff.read`-only caller and a brand/branch-scoped `staff.manage`
  caller are both denied **before** any persistence call), and that the catalog query accepts paging only
  — no search, filter or role parameter.

## 11. Development vs production & known limitations

Development uses disposable, ownership-marked databases per
[test infrastructure safety](../platform/current-v1-state.md#h-test-infrastructure-safety-mandatory-lesson).
Production authorization semantics are identical; only the identity provider configuration differs.

**Deferred (not HR):** payroll, salaries, attendance, shifts, scheduling, leave, timesheets, performance
reviews, recruitment/ATS, employee files, contracts, commissions, and HR documents are explicitly out of
scope and no HR domain exists. Also deferred: external invitation/email delivery and self-service
identity provisioning.

**Role/scope authoring remains deferred (Phase 2R or later).** Creating, editing or deleting a role;
editing role permissions; creating or editing an access scope; and creating or editing scope targets are
all still out of scope. This phase adds **selection** of existing authorization resources only — the
assignment catalogs are read projections and the database grants make authoring impossible, not merely
unexposed. A tenant's roles and scopes are still provisioned out-of-band.

**Phase 2O remains in progress** until the Admin Mobile staff integration and its runtime acceptance
merge. The API core and these assignment catalogs are the backend half; until the client half lands and
is accepted at runtime, treat 2O as incomplete.
