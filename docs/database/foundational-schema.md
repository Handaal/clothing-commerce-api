# Foundational Database Schema

## Purpose

Phase 1C-A creates the structural records that future commerce features need before products,
inventory quantities, orders, or authentication can exist safely. It answers four foundational
questions:

1. Which customer owns a record?
2. Which physical/business location does a record describe?
3. Which global person participates in which customer account?
4. Which stored Role and AccessScope relationships does the Phase 1D authorization service evaluate?

The five files in `supabase/migrations/` are the authoritative implementation. This guide explains
their meaning; it is not a second schema definition. See the
[Phase 1C-A architecture document](../architecture/phase-1c-a-foundational-persistence.md) for the
design summary and [ADR-011](../decisions/ADR-011-foundational-postgresql-physical-design.md) for
physical choices such as UUID defaults and AccessScope targets.

## Relationship map

The complete conceptual diagram is in the
[Phase 1B domain diagram](../architecture/phase-1b-domain-diagram.md). The implemented foundation can
be read as these connected paths:

```text
Tenant ─┬─ Brand ────────────────┐
        ├─ Branch ─ Register     ├─ AccessScopeTarget
        │    └─ InventoryLocation│
        ├─ Warehouse             │
        │    └─ InventoryLocation│
        ├─ Membership ─ RoleAssignment ─ Role ─ RolePermission ─ Permission
        ├─ AccessScope ──────────┘
        └─ Device ─ RegisterDeviceAssignment ─ Register

UserIdentity ─ Membership ─ Tenant
UserIdentity ─ ProviderBinding
Branch ─ BranchBrand ─ Brand
```

`Tenant` is the ownership root. `UserIdentity`, `Permission`, and provider bindings are
platform-global; participation and grants become tenant-local through Membership and Role records.

## Common persistence patterns

- Internal IDs use PostgreSQL `uuid` with a safe UUIDv4 database default. Human codes remain
  separate from IDs.
- Tenant-owned tables carry direct `tenant_id`. Composite foreign keys prove that related records
  share the same tenant instead of trusting application code.
- Codes and names use generated trim/lower normalization columns for uniqueness. Archived rows
  retain those values, so archive does not free a code for reuse.
- Lifecycle is represented by table-specific text `status` values and relevant suspension,
  archive, deactivation, or revocation timestamps.
- Instants use `timestamptz`. No automatic `updated_at` trigger exists; future writers must update
  it explicitly.
- Referential actions use `ON DELETE RESTRICT`. Deleting a parent cannot cascade through meaningful
  history.
- Phase 1C-B enables RLS on all 18 tables. Composite ownership constraints and RLS are complementary;
  neither substitutes for Phase 1D application authorization.

## Organization and physical structure

### Tenant — `tenants`

**Purpose and ownership:** The SaaS customer and root of an isolated data graph. Tenant itself is
platform-managed and therefore has no `tenant_id`.

**Relationships and constraints:** Brands, Branches, Warehouses, Devices, Memberships, Roles, and
AccessScopes reference it. `normalized_slug` is globally unique. Locale, timezone, currency, and
country defaults are validated independently from operational status and onboarding state.

**Lifecycle:** `provisioning`, `active`, `suspended`, or `archived`, with suspension/archive
timestamps required for their matching states.

**Not represented yet:** subscriptions, billing, tax configuration, tenant authorization behavior,
or public storefront routing/slug history.

### Brand — `brands`

**Purpose and ownership:** A tenant-owned trading/merchandising identity. It is intentionally not
the Tenant itself.

**Relationships and constraints:** Has a direct tenant-safe key and a code unique within the
Tenant. `branch_brands` associates it with Branches. Brand presence at a Branch does not create or
own inventory.

**Lifecycle:** `active`, `inactive`, or `archived`; archive metadata preserves the identity and
code.

**Outside this foundational guide:** Phase 2A now persists products and related catalog entities;
see [Catalog persistence](../catalog/catalog-persistence.md). Catalog publication, storefronts,
themes, domains, and stock balances remain absent.

### Branch — `branches`

**Purpose and ownership:** A tenant-owned retail or business location. It contains Registers and
may contain several InventoryLocations.

**Relationships and constraints:** Tenant-unique code, address/contact fields, IANA timezone,
fulfillment/click-and-collect eligibility, supported Brands through `branch_brands`, and an optional
default InventoryLocation. A composite foreign key proves that the default location belongs to the
same Tenant and Branch.

**Lifecycle:** `active`, `inactive`, or `archived`, without cascading children or history.

**Not represented yet:** Register sessions, orders, cash management, fulfillment work, or
inventory quantities.

### Warehouse — `warehouses`

**Purpose and ownership:** A tenant-owned stock-holding/logistics facility, separate from a
customer-facing Branch.

**Relationships and constraints:** Tenant-unique code, address/contact/timezone fields, operational
status, and explicit fulfillment, receiving, and directional transfer eligibility. It may own many
InventoryLocations.

**Lifecycle:** `active`, `inactive`, or `archived` with preserved code and archive metadata.

**Not represented yet:** receiving documents, transfers, purchase orders, quantities, racks, or
bins.

Branch and Warehouse remain separate because retail checkout and logistics have different rules.
Sharing address fields does not make them the same domain concept or justify a generic Facility
table.

### BranchBrand — `branch_brands`

**Purpose and ownership:** A tenant-owned association stating that a Branch supports a Brand.

**Relationships and constraints:** Its composite primary key prevents duplicate relationships.
Composite foreign keys prove that both Branch and Brand belong to `tenant_id`. The reverse lookup
index supports listing Branches for a Brand.

**Lifecycle:** The association records creation time. No cascade delete is configured.

**Not represented yet:** product ranging, stock ownership, catalog visibility, or sales history.

### InventoryLocation — `inventory_locations`

**Purpose and ownership:** The smallest authoritative physical place where future stock can exist,
such as a sales floor, stockroom, receiving area, or quarantine area.

**Relationships and constraints:** It has exactly one nullable-parent pair: either `branch_id` or
`warehouse_id`. The XOR CHECK rejects both and neither. Composite foreign keys prove parent and
Tenant agreement. Its code is unique across the Tenant. Capability flags describe sellable,
fulfillment, receiving, and transfer eligibility.

**Lifecycle:** `active`, `inactive`, or `archived`; codes remain reserved.

**Not represented yet:** nested bins, `on_hand`, `reserved`, `available`, damaged quantities, or an
inventory ledger. Future authoritative inventory will be keyed by Variant plus InventoryLocation,
not by POS or website channel.

InventoryLocation is separate from Branch/Warehouse because one facility can need several physical
stock states and sources without inventing separate channel-owned balances.

### Register — `registers`

**Purpose and ownership:** A tenant-owned checkout context inside one Branch. It gives future POS
transactions a durable business identity across hardware replacement.

**Relationships and constraints:** Register code is unique within its Branch. An active Register
must have a default InventoryLocation, and a composite foreign key proves that location belongs to
the same Tenant and Branch. Several Registers may reference the same location.

**Lifecycle:** `active`, `inactive`, or `archived`; historical identity is retained.

**Not represented yet:** inventory, Device credentials, sessions, shifts, cash drawers, receipts,
orders, or payments. A Register chooses a default source; it never owns stock.

## Identity and tenant participation

### UserIdentity — `user_identities`

**Purpose and ownership:** A platform-global, provider-neutral identity for one person. It has no
`tenant_id` because a person may work with several Tenants.

**Relationships and constraints:** Provider bindings link external subjects; Memberships link the
person to Tenants. Email and display name are profile data, not the primary key or proof of access.

**Lifecycle:** `active`, `suspended`, or `deactivated` with matching metadata.

**Not represented yet:** login sessions, passwords, tokens, account merging, Clerk workflows, or
authorization decisions.

### Provider binding — `user_identity_provider_bindings`

**Purpose and ownership:** A platform-global link from a provider/subject pair to UserIdentity.
Separating it keeps the domain identity independent from Clerk or any future provider.

**Relationships and constraints:** References one UserIdentity; `(provider, provider_subject)` is
globally unique. Link/unlink timestamps must be ordered.

**Lifecycle:** The row may be marked unlinked but remains available for historical identity
interpretation.

**Not represented yet:** provider credentials, authentication callbacks, claims, refresh tokens,
or provider-specific policy.

### Membership — `memberships`

**Purpose and ownership:** The tenant-local relationship between one UserIdentity and one Tenant.
This is why UserIdentity itself does not carry `tenant_id`.

**Relationships and constraints:** Composite `(tenant_id, id)` supports tenant-safe role
assignments. `(tenant_id, user_identity_id)` is unique, so one preserved logical Membership exists
per person/Tenant while the same person may join another Tenant.

**Lifecycle:** `invited`, `active`, `suspended`, or `deactivated`, with invitation/activation and
state timestamps.

**Not represented in this table:** invitation delivery, acceptance, authentication, authorization
evaluation, or Tenant suspension enforcement. Phase 1D services perform the latter checks.

## Stored authorization relationships

These tables store inputs for the Phase 1D authorization service; they do not authorize requests by
themselves.

### Role — `roles`

**Purpose and ownership:** A tenant-owned named grouping of Permissions.

**Relationships and constraints:** Role name is normalized and unique within its Tenant. The
protected flag drives the Phase 1D fail-closed mutation guard. RolePermission and
MembershipRoleAssignment use tenant-safe references.

**Lifecycle:** `active` or `archived` with archive metadata.

**Not represented yet:** Owner/Manager/Cashier seeds, protected-role editing policy, or hard-coded
role-name checks.

### Permission — `permissions`

**Purpose and ownership:** A platform-global stable capability understood by future application
code.

**Relationships and constraints:** Key is globally unique and must use lowercase
`resource.action` format. RolePermission connects it to tenant Roles.

**Lifecycle:** `active` or `deprecated` with deprecation time.

**Not represented yet:** a business permission catalog, runtime evaluation, grants directly to
users, or tenant-defined executable permissions.

### RolePermission — `role_permissions`

**Purpose and ownership:** Tenant-owned many-to-many relationship saying a Role aggregates a
Permission.

**Relationships and constraints:** Composite primary key prevents duplicate grants. The Role
reference includes `tenant_id`; Permission remains global.

**Lifecycle:** Creation time is stored; audit events and governed grant/removal workflows are
deferred.

**Not represented yet:** an authorization result or AccessScope. It says what, not where.

### AccessScope — `access_scopes`

**Purpose and ownership:** Tenant-owned description of where an assigned Role applies.

**Relationships and constraints:** Scope mode is either `tenant` or `explicit`. Names are unique
within a Tenant. Explicit scopes have AccessScopeTargets; tenant-wide scopes cannot have targets
because the target foreign key includes constant mode `explicit`.

**Lifecycle:** `active` or `archived`.

**Not represented yet:** an ABAC language, time/amount/device conditions, Permission grants, or
cross-tenant authority.

### AccessScopeTarget — `access_scope_targets`

**Purpose and ownership:** One explicit resource root inside an AccessScope.

**Relationships and constraints:** Exactly one of Brand, Branch, Warehouse, or InventoryLocation
must be set. Each concrete target has a tenant-safe foreign key and a partial unique index prevents
duplicate targets of that kind within one scope.

**Lifecycle:** Creation time is stored. Removing/changing targets will require future authorization
and audit behavior.

**Not represented yet:** a generic polymorphic reference, arbitrary attributes, exclusions, or
implicit rights to unrelated resources.

### MembershipRoleAssignment — `membership_role_assignments`

**Purpose and ownership:** Tenant-owned relationship joining a Membership, Role, and AccessScope.
Together they mean “this membership receives these capabilities in this area.”

**Relationships and constraints:** All three references include the same `tenant_id`. Assignment
intervals cannot end before they begin. A partial unique index prevents the same current
Membership/Role/Scope combination while ended rows remain as history.

**Lifecycle:** `assigned_at` to optional `unassigned_at`, with optional reasons.

**Not represented in this table:** evaluation, request middleware, or actor audit events. Phase 1D
services evaluate the relationship and apply the protected-role governance foundation.

Role, Permission, and AccessScope remain separate because they answer different questions: Role
groups capabilities, Permission says what may be done, and AccessScope limits where it applies.

## Devices and checkout assignment

### Device — `devices`

**Purpose and ownership:** A tenant-owned record for one enrolled physical/software installation.
It is separate from Register so hardware can be replaced or reassigned without changing checkout
identity.

**Relationships and constraints:** Installation ID is globally unique after trim/lower
normalization. Diagnostic client/platform/OS metadata is optional and non-authoritative. Device
participates in assignment history through tenant-safe keys.

**Lifecycle:** `enrolled`, `active`, or `revoked`, with activation/revocation and last-seen times.

**Not represented yet:** enrollment tokens, credentials, runtime registration, authentication,
offline revocation enforcement, or inventory.

### RegisterDeviceAssignment — `register_device_assignments`

**Purpose and ownership:** Tenant-owned effective-dated history linking a Device to a Register.

**Relationships and constraints:** Composite foreign keys prove Tenant agreement for Register,
Device, and optional actor Memberships. End time cannot precede start time. Partial unique indexes
allow at most one current Device per Register and one current Register per Device, while ended rows
preserve sequential history.

**Lifecycle:** `assigned_at` to optional `unassigned_at`, plus optional actor/reason metadata.

**Not represented yet:** runtime enrollment, active POS session, synchronization state, or Device
authorization.

## POS and online inventory invariant

Neither POS nor website/storefront appears as an inventory owner. Both future sales channels will
source the same physical InventoryLocations, and future quantities will belong to
`Variant + InventoryLocation`. Register and Device may select operational context but cannot own or
overwrite authoritative stock.

## How to work with this schema

- Learn migration mechanics and safe change rules in [migrations.md](./migrations.md).
- Run and troubleshoot the real database suite with
  [Docker database testing](../docker/database-testing.md).
- Run and troubleshoot Supabase policy tests with
  [Local Supabase development](../development/supabase-local.md).
- Understand all test layers in [development testing](../development/testing.md).
- Add schema changes only through a later timestamped migration plus matching SQL assertions and
  documentation.
- Do not manually create production tables, rewrite an applied migration, weaken RLS without an
  adversarial test/review, or add business tables before their domain phase.

The local database test paths require no environment variables or production credentials;
production database configuration and migration execution are not implemented. For security
behavior and limitations, see [Tenant isolation and RLS](../security/tenant-rls.md) and the
[tenant isolation strategy](../architecture/tenant-isolation-strategy.md).
