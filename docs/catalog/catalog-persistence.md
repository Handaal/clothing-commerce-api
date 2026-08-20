# Catalog Persistence

## Tables and ownership

| Table                   | Meaning                                  | Key ownership/integrity                              |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `products`              | Brand-owned merchandising styles         | Direct Tenant plus composite Tenant/Brand FK         |
| `product_variants`      | Stable stock-keeping/sellable identities | Composite Tenant/Product FK; tenant SKU uniqueness   |
| `variant_barcodes`      | Alternate scan identities                | Composite Tenant/Variant FK; tenant value uniqueness |
| `product_options`       | Product-local dimensions                 | Composite Tenant/Product FK                          |
| `product_option_values` | Allowed values for a dimension           | Composite Tenant/Product/Option FK                   |
| `variant_option_values` | One selection per variant and option     | Composite Variant, Option, and Value FKs             |
| `categories`            | Single-parent merchandising taxonomy     | Tenant-safe self-FK plus cycle prevention            |
| `product_categories`    | Product/category many-to-many            | Tenant-safe composite FKs and composite PK           |
| `collections`           | Flat manual merchandising groups         | Direct Tenant ownership                              |
| `product_collections`   | Ordered manual memberships               | Tenant-safe composite FKs and composite PK           |
| `variant_prices`        | Variant/currency base-price history      | Composite Tenant/Variant FK                          |

Every independent tenant record uses a UUID primary key and exposes `UNIQUE (tenant_id, id)` when
another table needs a composite tenant-safe reference. Association tables carry `tenant_id`
directly. All foreign keys use `ON DELETE RESTRICT`; persistence never cascades away catalog history.

## Constraints and normalization

- Product, Category, and Collection slugs are `lower(btrim(value))`, tenant-unique, kebab-shaped,
  and non-reusable after archive.
- Optional Product style code, required variant SKU, and Barcode value are outer-trimmed and
  lowercased for comparisons. Each is tenant-unique over the complete lifecycle.
- Product/Variant/Collection have `draft`, `active`, `archived`; Category and option definitions
  have `active`, `archived`; Barcode has `active`, `retired`. Archive/retirement timestamps must
  agree with status.
- Variant option selections include `product_id` and use three composite foreign keys. Their
  primary key `(tenant_id, variant_id, option_id)` permits only one value per option.
- The private expected-signature function computes selected value UUIDs ordered by option UUID.
  Deferred constraint triggers on variants and selections compare this to `option_signature`.
  `UNIQUE (tenant_id, product_id, option_signature)` then rejects duplicate logical combinations.
  This uniqueness is lifecycle-wide (no status predicate): an archived combination stays reserved to
  its original variant identity, so reintroduction reactivates that variant later rather than
  minting a second UUID for the same combination. The triggers enforce selection consistency, not
  option completeness; a draft variant may cover only some options.
- Category self-parenting is checked directly. `catalog_private.prevent_category_cycle()` first
  acquires a Tenant-scoped transaction advisory lock
  (`pg_advisory_xact_lock(hashtextextended(tenant_id, 0))`), then follows the proposed parent's
  ancestors and rejects a longer cycle before write. The advisory lock serializes concurrent
  hierarchy mutations within one Tenant so two reparents cannot both commit a cycle against stale
  snapshots; different Tenants remain independently mutable. `scripts/test-catalog-concurrency.mjs`
  is the two-session regression for this guarantee.
- Product/category and Product/Collection primary keys reject duplicate membership.
- Variant price currency matches `^[A-Z]{3}$`, amount is a nonnegative `bigint` in minor units, and
  a partial unique index allows only one active row per Tenant/Variant/currency.

Application input boundaries remain responsible for Unicode normalization and semantic validation
such as real EAN checksums or whether an ISO-shaped currency is supported. Database normalization
defines uniqueness and is not a replacement for Zod schemas when endpoints arrive.

## Indexes

Unique indexes already support exact slug, style code, SKU, barcode, and active-price lookup.
Additional indexes cover known paths: products by Tenant/Brand/status; variants by
Tenant/Product/status; barcodes by Variant/status; category children in display order; reverse
ProductCategory lookup; Collection status; ordered products in a Collection; option-value reverse
lookup; and price history by Variant/currency/time. No full-text, search-engine, inventory, or
channel-specific index is added.

## Money and replacement workflow

`amount_minor bigint` stores values such as `2599` for USD 25.99. `bigint` is the authoritative
representation and currencies are not assumed to all have two decimal places; `amount_minor` is raw
minor units for its currency. Transport/application code must parse decimal input without passing
through floating-point arithmetic, validate currency fraction rules, and serialize safely. Because a
JavaScript `Number` is exact only to `2^53 - 1`, a future HTTP/OpenAPI/SDK layer must not map
arbitrary `int8` amounts straight into a JS `Number`; it must choose a decimal-string-of-minor-units
or a deliberately bounded safe-integer contract. Zero is allowed; negative sale prices are not. A
partial unique index permits at most one active row per Tenant/Variant/currency, and zero active
rows is valid. Replace a base price in one transaction by archiving the current row (`status`,
`archived_at`, optional reason) and inserting the new active row.

## RLS and privileged writes

All eleven tables have RLS enabled. Their one authenticated policy is SELECT-only and requires:

```text
row.tenant_id = commerce_context.current_tenant_id()
AND commerce_context.has_active_membership()
```

`anon` and PUBLIC receive no table access. `authenticated` receives SELECT only; no INSERT, UPDATE,
or DELETE policy exists. `service_role` has explicit DML grants and BYPASSRLS, but production use is
valid only behind application authorization. The `catalog_private` schema is unavailable to PUBLIC,
anon, and authenticated; its fixed-empty-search-path SECURITY INVOKER functions are executable by
the service role for trigger operation.

This policy is an internal staff/member backstop, not public storefront publication. A future
public catalog read path requires an explicit design and must not weaken tenant-table policies.

## Migration order

1. `20260819180000_create_catalog_products_variants.sql` creates the private integrity schema,
   Product/Variant/Barcode/Option tables, composite keys, and canonical combination triggers.
2. `20260819180100_create_catalog_merchandising.sql` creates Category/Collection tables,
   associations, and the category-cycle trigger.
3. `20260819180200_create_catalog_pricing.sql` creates minimal base-price history.
4. `20260819180300_enable_catalog_tenant_rls.sql` enables policies and establishes role grants.

These append after the five Phase 1 migrations. Do not rewrite any applied file; use a later
fix-forward migration after Phase 2A is shared.

## Adding a catalog field safely

First decide whether the value belongs to Product, Variant, an association, or a later bounded
concept. Document the business meaning and lifecycle. Add an append-only migration; for populated
tables prefer nullable/additive shape, compatible readers/writers, controlled backfill, then a later
constraint. Carry `tenant_id` in new tenant relationships, add composite uniqueness required by the
FK, review delete behavior and RLS, and add accepted plus rejected persistence/RLS tests. If the
field reaches HTTP, update Zod first and regenerate OpenAPI and SDK artifacts.
