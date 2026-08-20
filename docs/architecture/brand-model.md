# Brand Model

## Definition

**CONFIRMED:** Brand is a tenant-owned trading and merchandising identity. It is separate from the
Tenant that contracts for and controls the platform account.

Example:

```text
Tenant: Fashion Holdings
Brands: Brand A, Brand B
```

A single-brand tenant uses exactly the same model and may receive a default brand during future
onboarding. Code must not assume that the first or only brand is the tenant.

## Identity, profile, and lifecycle

**RECOMMENDED:** A Brand has an immutable internal identifier, direct tenant identity, a code unique
within its tenant, display and legal/trading names as needed, operational status, and archival
metadata. A future brand profile owns logo, theme tokens, editorial content, domains, and other
consumer-facing presentation settings. Secrets and commerce authorization do not belong in theme
content.

Brand-specific business codes are human-facing identifiers independent from the internal ID. Codes
are normalized for uniqueness and are never reused within a tenant, including after archive.

Archiving a brand prevents new brand-scoped publication or transactions. It preserves catalog,
order, inventory, and audit references. The archival workflow must report active branch support,
storefronts, listings, and other future dependencies rather than silently detaching them.

## Branch and warehouse relationships

- **RECOMMENDED:** A branch may sell products from multiple brands through an explicit supported-
  brand association. This supports concessions, shared stores, and multi-brand tenants without
  burdening single-brand tenants.
- **RECOMMENDED:** A warehouse may hold and fulfill merchandise for multiple brands. Warehouse and
  InventoryLocation do not acquire brand ownership merely because branded stock is present.
- **CONFIRMED:** Brand associations never create authoritative inventory quantities.

## Catalog and product ownership boundary

**CONFIRMED IN PHASE 2A:** Product belongs directly to the Tenant and exactly one same-tenant Brand.
The composite Tenant/Brand foreign key prevents cross-tenant inference. This is merchandising
ownership, not Branch/Warehouse ownership or channel publication. Multi-brand storefront or
marketplace visibility remains a later explicit publication model rather than weakening Product
ownership.

## Storefront relationship

- **RECOMMENDED:** A Brand may eventually have zero, one, or multiple storefront presentations or
  domains. Brand is the natural owner of theme, logo, content, and brand-specific catalog
  visibility.
- **DEFERRED:** Do not persist a Storefront entity in Phase 1C. Domain routing, regional storefronts,
  and cross-brand marketplaces require catalog and channel requirements.
- **RECOMMENDED:** A future tenant-wide or multi-brand storefront must explicitly select brands; it
  must not redefine Brand or become a stock owner.
- **CONFIRMED:** Online fulfillment may source eligible warehouse or branch InventoryLocations.
  Storefront and online sales channel never own a separate inventory balance.

## Decisions that can safely wait

- **MEDIUM — REQUIRES FOUNDER DECISION:** Decide whether the first storefront release supports
  multiple storefronts per brand and cross-brand storefronts before storefront persistence is
  designed. This is not a Phase 1C blocker.
- **LOW — DEFERRED:** Exact logo assets, theme schema, domains, SEO content, and publication
  workflow.
