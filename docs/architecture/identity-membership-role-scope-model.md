# Identity, Membership, Role, Permission, and Scope Model

## Separation of concerns

```text
UserIdentity -> Membership -> Tenant
Membership -> Role assignment -> Role -> Permission
Role assignment -> AccessScope -> explicit resource targets
```

- **CONFIRMED:** UserIdentity is global; it is not owned by a Tenant and is not Clerk.
- **CONFIRMED:** Membership is the tenant-local relationship between one UserIdentity and one
  Tenant.
- **CONFIRMED:** Roles aggregate permissions. Permissions answer “what”; access scopes answer
  “where.”
- **CONFIRMED:** UI role names and client-side checks are never authoritative.

## UserIdentity

**RECOMMENDED:** UserIdentity has an immutable internal identifier, lifecycle status, and normalized
profile concepts such as primary display name and verified contact references where appropriate.
External identity-provider subjects are linked by provider plus provider subject, allowing Clerk or
another provider without making either the domain identity.

A UserIdentity may belong to multiple Tenants through distinct Memberships. External email is not
the primary key, may change, and must not be trusted without provider verification. Provisioning,
account merging, and provider migration are **DEFERRED**.

## Membership

Membership identity is distinct from user identity and is unique for the active relationship of
`Tenant + UserIdentity`. It conceptually tracks invited, active, suspended, and deactivated states;
inviter/creator provenance; invitation and activation times; and deactivation reason/time.

- **RECOMMENDED:** A membership can have multiple Roles through explicit assignments. This avoids
  a hard one-role ceiling while keeping normal tenants simple with one assignment.
- **RECOMMENDED:** Onboarding or an invitation may propose default Role and AccessScope assignments,
  but activation persists them explicitly; there is no hidden role derived from membership status.
- **RECOMMENDED:** Invitations can exist before provider linkage is complete, but invitation
  matching and takeover protections are deferred to identity implementation.
- **RECOMMENDED:** Suspending/deactivating a membership immediately prevents new tenant-scoped
  authorization without changing the global UserIdentity or memberships in other tenants.
- **RECOMMENDED:** A deactivated membership is preserved. Re-invitation should reactivate or create
  a versioned relationship according to future audit requirements, never erase history.

## Permission

Permissions are platform-defined, stable capabilities enforced by application services. Names use
lowercase dotted `resource.action` form, for example `orders.read`, `orders.refund`,
`inventory.transfer`, or `staff.manage`. Names are immutable once released; replacement uses a new
permission plus deprecation.

**RECOMMENDED:** The Permission catalog is platform-global because enforcement code must understand
every permission. Tenants cannot invent executable permission names. Phase 1B intentionally does
not freeze the complete catalog.

## Role

Roles are tenant-owned named aggregations of Permissions. Role names are normalized and unique
within a tenant across active and archived records.

- **RECOMMENDED:** Tenant administrators may create custom roles from the platform Permission
  catalog.
- **RECOMMENDED:** Future default/system roles are provisioned as tenant roles from platform-managed
  templates and marked protected. They are not string comparisons in application code.
- **RECOMMENDED:** Protected roles may restrict rename/archive/permission editing; exact policy is
  deferred. Authorization always evaluates permission grants, never `role === "manager"`.
- **RECOMMENDED:** A role cannot be archived while active assignments remain unless an explicit
  replacement/removal workflow completes. Archived roles retain historical assignments and names.

## AccessScope

**RECOMMENDED:** AccessScope is a tenant-owned, named bundle of explicit scope targets. A
MembershipRoleAssignment connects one Membership, one Role, and one AccessScope. This permits the
same “Branch Manager” role at different branches and permits one membership to carry different
permissions in different places without cloning roles.

An access scope may be:

- the entire tenant; or
- an allowlist containing selected Brands, Branches, Warehouses, and/or InventoryLocations.

Tenant-wide scope is exclusive: it is not mixed with narrower targets. Phase 1D adopts conservative
exact-target semantics: Branch and Warehouse targets do not implicitly cover child
InventoryLocations, and Brand targets do not grant facility access. Callers list every protected
resource. This replaces the earlier recommendation to infer facility descendants.

For an operation spanning resources, such as a future transfer, the member needs the permission and
scope coverage for every protected resource (for example both origin and destination). Scope never
overrides tenant isolation or grants a permission absent from the assigned Role.

- **CONFIRMED:** A scope may combine Branch and Warehouse targets. This is an explicit union, not a
  new role and not an implicit “all locations.”
- **RECOMMENDED:** Scope targets must belong to the same tenant as the scope, role, membership, and
  assignment.
- **DEFERRED:** Conditions based on amount, time, device posture, or arbitrary attributes. No ABAC or
  policy language is introduced in Phase 1B.

## Evaluation contract for a future authorization service

Authorization requires all of the following:

1. active Tenant, UserIdentity, Membership, Role assignment, Role, and AccessScope;
2. a platform-known Permission granted by the assigned Role;
3. tenant match for every target resource; and
4. AccessScope coverage for every protected resource involved.

Deny is the default for missing, ambiguous, cross-tenant, archived, suspended, or unrecognized
state. Phase 1D implements this evaluation in internal authorization services. No public protected
route or role-management workflow exists yet.

## Decisions and deferrals

- **IMPLEMENTED FOUNDATION:** `roles.is_protected` blocks runtime
  rename/archive/delete/Permission changes. No tenant service bypass exists. High-risk Permission
  classification and delegation still require founder approval before staff administration ships.
- **IMPLEMENTED FOUNDATION:** Brand and physical-location targets are orthogonal. An operation that
  supplies both must receive Permission-coupled coverage for both; no intersection or hierarchy is
  inferred beyond the listed resources.
- **LOW — DEFERRED:** Full permission catalog, invitation workflow, provider-account linking, and
  emergency support access.
