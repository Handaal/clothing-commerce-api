# ADR-008: Identity, Membership, Role, Permission, and Scope Model

- Status: Proposed
- Date: 2026-08-19

## Context

People may work for multiple tenants, identity providers may change, and staff with the same job
title may operate in different branches. Hard-coded role names cannot express stable capabilities
or resource boundaries.

## Decision

- **CONFIRMED:** UserIdentity is platform-global and provider-neutral. Membership connects one
  UserIdentity to one Tenant and owns the tenant-local lifecycle.
- **RECOMMENDED:** A Membership may receive multiple Roles through MembershipRoleAssignments.
- **RECOMMENDED:** Permission is a platform-global, immutable `resource.action` capability known to
  application code. Role is a tenant-owned aggregation of Permissions.
- **RECOMMENDED:** Default/system roles are protected tenant roles provisioned from future
  platform-managed templates; application code evaluates Permissions, never role-name strings.
- **RECOMMENDED:** AccessScope is a tenant-owned named allowlist (or entire-Tenant scope) connected
  to each role assignment. It may target Brands, Branches, Warehouses, and InventoryLocations.
- **CONFIRMED:** Scope answers where, not what; it cannot grant a missing Permission or cross a
  Tenant boundary. Multi-resource actions require scope coverage for every protected resource.

## Alternatives rejected

- Tenant ID directly on UserIdentity: prevents or distorts multi-tenant membership.
- One Role column on Membership: creates a needless ceiling and awkward compound roles.
- Hard-coded role comparisons: couples policy to display labels and blocks custom roles.
- A new Role per Branch: multiplies roles to express location rather than capability.
- Full ABAC/policy language: premature and difficult to explain, audit, and test.
- Tenant-defined Permission names: enforcement code cannot safely interpret arbitrary capabilities.

## Consequences

Simple tenants can assign one role and tenant-wide scope. Larger tenants can reuse roles across
explicit resource scopes and combine assignments. Tenant-safe joins, lifecycle checks, and audit
are required. Protected-role governance and Brand/location scope interaction need policy approval
before authorization implementation, not before foundational persistence.
