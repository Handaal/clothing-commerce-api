# ADR-009: Tenant Isolation Strategy

- Status: Proposed
- Date: 2026-08-19

## Context

Tenant ownership can often be derived through parents, but indirect derivation makes queries,
policies, reporting, and cross-tenant mistake detection harder. Application checks or database RLS
alone leave a single point of failure.

## Decision

- **CONFIRMED:** Enforce tenant isolation in server-side authorization/data filtering and use
  PostgreSQL RLS as a deny-by-default backstop on tenant-owned tables where appropriate.
- **RECOMMENDED:** Carry direct tenant identity on every tenant-owned foundational entity and its
  relationship/assignment rows, including Brand, Branch, Warehouse, InventoryLocation, Register,
  Device, Membership, Role, and AccessScope.
- **CONFIRMED:** Tenant is the root; UserIdentity and Permission remain platform-global.
- **RECOMMENDED:** Enforce same-tenant relationships with composite tenant-safe references or
  equivalent constraints. Index tenant-owned lookups beginning with tenant identity where useful.
- **CONFIRMED:** Client-supplied tenant selectors and metadata do not establish authority. Service,
  background, and support access is explicit, least-privileged, and audited.

## Alternatives rejected

- Derive tenant only through parent joins: increases policy complexity and allows unsafe/mistaken
  cross-tenant relationships to hide.
- Application filtering only: one omitted predicate can expose data.
- RLS only: cannot express all business authorization and can be bypassed by privileged server
  access if poorly governed.
- Client-direct database access: leaks the privileged boundary and conflicts with API ownership.

## Consequences

Tenant identity is intentionally duplicated and must be consistency-constrained. Storage overhead
is accepted for safer joins, simpler indexes, reporting, RLS, and incident diagnosis. Phase 1C must
threat-model roles/policies and test cross-tenant reads and writes before accepting migrations.
