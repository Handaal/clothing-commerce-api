# Tenant Isolation Strategy

## Security posture

**CONFIRMED:** Tenant isolation is defense in depth. Phase 1C-B implements PostgreSQL row-level
security (RLS) as a deny-by-default database backstop. Phase 1D will add server-side identity and
application authorization/filtering. Neither layer is optional merely because the other exists.

This document remains the architecture-level strategy. The implemented threat model, exact context
claims, table matrix, and policy limitations are in
[Tenant isolation and row-level security](../security/tenant-rls.md).

## Request and application boundary

A future authenticated request must resolve:

1. a global UserIdentity from a verified provider binding;
2. the requested Tenant from a canonical internal identifier or resolved slug;
3. an active Membership for that exact user and tenant;
4. active role assignments, Permissions, and AccessScopes; and
5. tenant ownership and scope coverage for every resource touched.

Route handlers validate transport input and pass an explicit authorization/tenant context to
application services. Application services express business authorization and tenant predicates.
Repositories/data access never perform an unqualified lookup of tenant-owned data by globally
supplied record ID alone. Client headers, URL slugs, Device metadata, and request bodies are hints or
selectors, not proof of tenant authority.

Multi-resource mutations validate every reference before writing. Cross-tenant references fail
closed and should be reported without leaking the existence of another tenant's data.

## Direct tenant identity

**RECOMMENDED:** Carry `tenant_id` directly on:

- Brand, Branch, Warehouse, InventoryLocation, Register, and Device;
- Membership, Role, AccessScope, and MembershipRoleAssignment;
- tenant-owned association/target records such as BranchBrand, RolePermission, AccessScopeTarget,
  and RegisterDeviceAssignment; and
- future tenant-owned commerce and audit records.

Tenant itself is the ownership root and has no `tenant_id`. UserIdentity and Permission are
platform-global and have no `tenant_id`.

Direct tenant identity is intentional denormalization for isolation safety, indexable queries,
reporting, RLS, and operational diagnosis. Persistence must not treat denormalized tenant identity
as advisory: composite references or equivalent constraints must ensure every child and parent
tenant matches.

## Database backstop

**IMPLEMENTED FOR THE FOUNDATION:** All 18 foundational tables enable RLS and default to no access
for ordinary roles. Policies derive the selected Tenant and provider-neutral UserIdentity from
server-signed request claims, then require the active Membership for that exact pair. Claims are
selectors rather than authority, and the API remains the only intended client-facing data boundary.

Service/maintenance roles that bypass RLS are exceptional, separated, logged, least-privileged, and
never used by clients. Background jobs carry an explicit tenant context per unit of work and avoid
unbounded cross-tenant mutation. Platform support access requires a separately approved,
time-bounded, audited mechanism.

Global tables also enable RLS: UserIdentity is self-only, provider bindings are denied, and the
Permission catalog is read-only for an active member. Ordinary authenticated writes are denied.
AccessScope evaluation and business permission decisions remain Phase 1D responsibilities.

## Conceptual integrity and indexes

Recommended patterns, subject to query-plan verification in Phase 1C:

- primary identity remains a single immutable ID;
- tenant-owned tables additionally support `(tenant_id, id)` for composite tenant-safe references;
- human codes use tenant-scoped normalized uniqueness such as `(tenant_id, normalized_code)`;
- common parent listings use `(tenant_id, branch_id, status)` or
  `(tenant_id, warehouse_id, status)`;
- membership lookup uses `(tenant_id, user_identity_id)`;
- assignments and scope targets index tenant plus their membership/role/scope and target keys;
- global tenant slug, external provider subject, Permission name, and installation ID use their
  documented global uniqueness boundaries.

Indexes support but do not replace constraints or authorization. Partial uniqueness that frees a
code after archival is prohibited for business codes.

## Failure and test expectations

Phase 1C-B migration-level tests now cover:

- no tenant context and invalid tenant context;
- attempts to read, insert, update, or relate records across tenants;
- guessed IDs and mismatched parent/child tenant identity;
- suspended tenants and memberships;
- archived or revoked authorization records;
- background/service access boundaries; and
- tenant-safe uniqueness and composite references.

The implemented database suite also covers explicit multi-Tenant switching, invalid/malformed
claims, ordinary write denial, association leakage, global-table exposure, and the Supabase
service-role bypass boundary. Future application tests must prove isolation at service and HTTP
boundaries as well as at the database backstop. Observability may record internal tenant
identifiers for operators but must not expose other tenants' identifiers or sensitive details to
requesters.
