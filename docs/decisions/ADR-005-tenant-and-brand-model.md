# ADR-005: Tenant and Brand Model

- Status: Proposed
- Date: 2026-08-19

## Context

The platform must serve a single-brand shop without preventing one customer organization from
operating several consumer brands. Tenant isolation, contracting identity, merchandising identity,
and storefront presentation are different concerns.

## Decision

- **CONFIRMED:** Tenant is the isolated SaaS customer/legal or operational organization. Brand is a
  tenant-owned trading and merchandising identity.
- **RECOMMENDED:** One Tenant owns zero or many Brands, each with an immutable internal ID and a
  tenant-unique durable business code.
- **RECOMMENDED:** Tenant is the ownership root for future products and commerce records. Brand
  alone is not sufficient to prove product ownership or tenant isolation.
- **RECOMMENDED:** Branches may support multiple Brands explicitly, and Warehouses may hold
  merchandise for multiple Brands.
- **RECOMMENDED:** Brand owns future logo/theme/content and brand-level catalog visibility. A Brand
  may later have multiple storefront presentations, but Storefront persistence is deferred.
- **CONFIRMED:** Storefront and sales channel never own authoritative inventory.

## Alternatives rejected

- One Brand per Tenant: rejects multi-brand holdings and causes later tenancy migration.
- Tenant equals Brand: conflates contractual isolation with consumer presentation.
- Brand as stock owner: conflicts with physical InventoryLocation ownership and shared facilities.
- Storefront entity now: premature without domains, regionalization, or channel requirements.

## Consequences

Single-brand tenants use one ordinary Brand and can receive sensible onboarding defaults.
Multi-brand branch eligibility and future catalog attribution require explicit relationships. Brand
archive preserves history and blocks new use rather than deleting records.

The initial storefront cardinality and public tenant-slug behavior remain policy decisions, but
neither blocks foundational persistence.
