# Phase 1C-A Foundational Persistence

## Scope and authority

Phase 1C-A creates the first append-only PostgreSQL schema for the approved organizational,
identity/access, and Register/Device models. The ordered files in `supabase/migrations/` are the
authoritative schema history. No consolidated `schema.sql` is introduced because the repository has
no established snapshot workflow.

This phase creates no public API, SDK method, business-domain table, seed data, RLS policy,
authentication integration, or authorization evaluator.

## Reading and operating the implementation

This document records the architecture and physical-design boundary. Use the focused guides for
day-to-day work:

- [Foundational schema](../database/foundational-schema.md) explains each entity and relationship in
  plain language.
- [Database migrations](../database/migrations.md) defines naming, ordering, review, compatibility,
  and fix-forward policy.
- [Docker database testing](../docker/database-testing.md) documents the disposable PostgreSQL
  runner and troubleshooting.
- [Development testing](../development/testing.md) describes every validation layer and current CI
  coverage.
- [Docker strategy](../docker/strategy.md) separates today's local test container from future
  Supabase and production deployment work.

## Migration sequence

1. `20260819161500_create_foundational_organization.sql` creates Tenant, Brand, Branch, Warehouse,
   BranchBrand, InventoryLocation, and Register persistence.
2. `20260819161600_create_foundational_identity_access.sql` creates global UserIdentity,
   provider-neutral identity binding, Membership, Role, Permission, RolePermission, AccessScope,
   AccessScopeTarget, and MembershipRoleAssignment persistence.
3. `20260819161700_create_foundational_devices.sql` creates Device persistence and effective-dated
   RegisterDeviceAssignment history.

The split follows dependency direction. Constraints and indexes stay next to the tables whose
invariants they enforce.

## Tables and ownership

| Table                             | Ownership       | Purpose                                                            |
| --------------------------------- | --------------- | ------------------------------------------------------------------ |
| `tenants`                         | Platform root   | SaaS customer identity, defaults, onboarding, and lifecycle        |
| `brands`                          | Tenant          | Trading and merchandising identity                                 |
| `branches`                        | Tenant          | Retail/business location and optional default POS source           |
| `warehouses`                      | Tenant          | Separate logistics and stock-holding facility                      |
| `branch_brands`                   | Tenant          | Explicit supported-brand relationship                              |
| `inventory_locations`             | Tenant          | Flat physical stock location under exactly one Branch or Warehouse |
| `registers`                       | Tenant          | Branch checkout context and default branch InventoryLocation       |
| `user_identities`                 | Platform-global | Provider-neutral person identity                                   |
| `user_identity_provider_bindings` | Platform-global | Unique provider-plus-subject linkage                               |
| `memberships`                     | Tenant          | One logical UserIdentity/Tenant relationship                       |
| `roles`                           | Tenant          | Named Permission aggregation                                       |
| `permissions`                     | Platform-global | Stable `resource.action` capability names                          |
| `role_permissions`                | Tenant          | Tenant-safe Role-to-Permission relationship                        |
| `access_scopes`                   | Tenant          | Tenant-wide or explicit resource boundary                          |
| `access_scope_targets`            | Tenant          | One concrete Brand, Branch, Warehouse, or InventoryLocation target |
| `membership_role_assignments`     | Tenant          | Effective-dated Membership/Role/AccessScope relationship           |
| `devices`                         | Tenant          | Enrolled installation identity and diagnostic metadata             |
| `register_device_assignments`     | Tenant          | Effective-dated, sequential Register/Device assignment history     |

The provider binding is a separate table because the approved readiness model treats external
provider accounts as links to a provider-neutral UserIdentity. It is not Clerk-specific.

## Identifier implementation

All internal IDs use PostgreSQL `uuid`. Database defaults use the built-in `gen_random_uuid()`
UUIDv4 function because PostgreSQL 17 is the compatibility target and native `uuidv7()` begins in
PostgreSQL 18. The schema accepts trusted UUIDv7 values supplied by a future authoritative creation
boundary. No custom extension or handwritten UUID algorithm is installed.

This is the documented compatibility fallback from the preferred Phase 1B UUIDv7 convention. See
[ADR-011](../decisions/ADR-011-foundational-postgresql-physical-design.md).

Human codes remain separate. Stored generated normalization columns currently apply trim plus
lowercase comparison. Unique constraints cover all lifecycle states, so archiving does not free a
code. More advanced Unicode/display normalization remains a contract decision before external
imports or printing.

## Tenant-safe integrity

Every tenant-owned entity and relationship carries direct `tenant_id`. Tenant-owned entity tables
declare `UNIQUE (tenant_id, id)`, and dependent rows use composite foreign keys such as:

- BranchBrand to `(tenant_id, branch_id)` and `(tenant_id, brand_id)`;
- InventoryLocation to either `(tenant_id, branch_id)` or `(tenant_id, warehouse_id)`;
- Register to `(tenant_id, branch_id)`;
- Register defaults to `(tenant_id, branch_id, default_inventory_location_id)`, which also proves
  the location belongs to the Register's Branch;
- RolePermission to `(tenant_id, role_id)`;
- MembershipRoleAssignment to tenant-safe Membership, Role, and AccessScope keys;
- AccessScopeTarget to its tenant-safe AccessScope and one concrete tenant-owned resource;
- RegisterDeviceAssignment to tenant-safe Register, Device, and optional actor Membership keys.

These constraints reject a relationship even when every individual UUID exists but belongs to a
different tenant.

## Structural invariants

- InventoryLocation uses a CHECK constraint requiring exactly one non-null Branch/Warehouse parent.
- InventoryLocation codes are unique within Tenant; Register codes are unique within Branch; other
  approved business codes are unique within Tenant.
- One Membership per Tenant/UserIdentity is preserved across lifecycle states. One global
  UserIdentity may have Memberships in many Tenants.
- Active Registers require a default InventoryLocation. Its composite foreign key enforces the same
  Tenant and Branch. Multiple Registers may reference the same location.
- AccessScopeTarget uses four concrete nullable foreign keys and an exactly-one-target CHECK.
  Including constant `scope_mode = 'explicit'` in its AccessScope foreign key prevents targets on a
  tenant-wide scope.
- Partial unique indexes allow at most one current RegisterDeviceAssignment per Register and per
  Device while retaining ended assignment rows.
- MembershipRoleAssignment similarly prevents duplicate current Membership/Role/Scope assignments
  while retaining ended rows.

The database does not attempt to evaluate permissions. Active/sellable suitability when changing a
Register or Branch default location remains a controlled application-service lifecycle rule; the
schema enforces the stable ownership and same-Branch boundary.

## Index and uniqueness strategy

Unique constraints cover global tenant slug, provider-plus-subject binding, Device installation ID,
Permission key, tenant codes/names, Membership identity, and relationship pairs. Query indexes are
limited to approved access paths:

- BranchBrand reverse lookup by Brand;
- Branch/Warehouse InventoryLocation listings by tenant, parent, and status;
- Register listings by tenant, Branch, and status;
- RolePermission reverse lookup by Permission;
- AccessScope target lookup in both scope-to-target and target-to-scope directions;
- current and historical MembershipRoleAssignment lookup;
- Device status within Tenant; and
- current and historical RegisterDeviceAssignment lookup.

## Lifecycle, timestamps, and deletion

Lifecycle values use text plus table-specific CHECK constraints. Archive, suspension, deactivation,
and revocation metadata are present only on relevant entities. Time-order constraints protect
effective-dated assignments and lifecycle timestamps.

Every meaningful foreign key uses `ON DELETE RESTRICT`. Parent deletion cannot cascade into
organizational, identity, authorization, or assignment history. Pure relationship rows are not
configured for cascading deletion either. A privileged, separately governed maintenance process
may still purge a proven-empty provisioning mistake; no ordinary application delete path exists.

`created_at` and `updated_at` are timezone-aware. No update trigger is introduced; future reviewed
persistence services must update `updated_at` explicitly with each mutation.

## Verification

`pnpm test:persistence` verifies the complete migration history twice against isolated PostgreSQL
17.6. Operational steps, configuration, and failure diagnosis live in
[Docker database testing](../docker/database-testing.md); the full repository validation sequence
and current CI boundary live in [Development testing](../development/testing.md).

The tests prove:

- cross-tenant BranchBrand, InventoryLocation parent, Register default, MembershipRoleAssignment,
  AccessScopeTarget, and RegisterDeviceAssignment relationships are rejected;
- branch-owned and warehouse-owned InventoryLocations are accepted, while both-parent and
  no-parent rows are rejected;
- one UserIdentity can join two Tenants while duplicate same-Tenant Membership is rejected;
- two Registers can share one InventoryLocation;
- tenant slug, tenant-scoped Branch code, and Permission key uniqueness;
- same Branch code in separate Tenants;
- one current Device per Register and one current Register per Device; and
- ended Register/Device assignments remain as history and permit sequential reassignment.

The test also confirms all 18 expected tables exist, RLS and policies are absent, and representative
business tables are absent. Fixtures exist only inside a rolled-back test transaction. Production
seed data remains empty.

## Explicit Phase 1C-B and later deferrals

Not implemented:

- PostgreSQL RLS enablement or policies;
- server-established tenant/authorization database context;
- Clerk or other authentication-provider workflows;
- permission evaluation and authorization middleware;
- protected-role governance and a business Permission catalog;
- tenant suspension enforcement;
- offline POS authentication, authorization windows, or Device revocation behavior;
- immutable audit-event tables;
- products, variants, inventory quantities or ledger, orders, customers, suppliers, payments,
  vouchers, returns, reporting, storefronts, POS workflows, or mobile workflows.
