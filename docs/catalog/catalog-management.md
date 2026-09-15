# Catalog Management and Storefront Publication (Phase 2J)

Phase 2J adds the authoritative **write** boundary over the Phase 2A catalog and a **Storefront
publication** boundary, plus a **public (Storefront-safe) read** surface. It reuses the canonical
Product/Variant/Option/Price/Category/Collection model unchanged; it introduces no parallel ecommerce
catalog and no channel-private product or stock model.

The clients that will consume this next — Admin Mobile (catalog management) and Storefront (public
catalog) — are **not** built here. This is the server + SDK contract only.

## Layering (unchanged pattern)

Route (`runTenantManagementWriteRoute`) → authorized application service
(`executeAuthorizedOperation` against the product's **brand** resource) → repository → `SECURITY
DEFINER` RPC in a private schema owned by a dedicated `catalog_writer` role. `service_role` holds
`SELECT` + `EXECUTE` on sanctioned functions only, never direct catalog DML. Custom SQLSTATEs are
internal-only and mapped to stable `CatalogError` codes in the repository.

## Command surface (smallest complete set)

Products, variants, options, and prices are administered through explicit commands, not generic REST
PATCH-of-anything. Every command is tenant- and brand-authorized and idempotent via the platform
`Idempotency-Key` header.

- **Product**: `createProduct`, `updateProduct` (name/description/style/slug), `activateProduct`,
  `deactivateProduct` (active→draft), `archiveProduct`.
- **Variant**: `createVariant` (sku + option-value selection), `updateVariant` (display name),
  `archiveVariant`. SKU uniqueness is enforced by the existing `(tenant_id, normalized_sku)` unique
  index; a duplicate surfaces as `SKU_CONFLICT`.
- **Options**: `defineOption` / `addOptionValue` create the option dimensions and allowed values a
  variant selection references. The existing deferred constraint trigger keeps a variant's
  `option_signature` canonical.
- **Pricing**: `setVariantPrice` writes an active `variant_prices` row in minor units for a currency,
  archiving the prior active row for that currency (history preserved). Clients never write price
  directly; the server owns the price-integrity write.
- **Publication**: `publishProduct` / `unpublishProduct` (see below).

Category/Collection management (`createCategory`, `assignProductCategory`, `createCollection`,
`setProductCollections`) is included as the V1 merchandising taxonomy because the canonical model
already contains it and the Storefront needs it for navigation.

Historical Orders are never affected: all catalog FKs remain `ON DELETE RESTRICT`, and edits/archival
never mutate the immutable order pricing snapshots. There is **no hard delete**; lifecycle uses
draft/active/archived.

## Product lifecycle vs. Storefront publication (the critical distinction)

`products.status ∈ {draft, active, archived}` is the **internal** catalog lifecycle: `active` means
"internally eligible for catalog workflows" (POS sellability, inventory). It has never meant
"published online" — Phase 2A documented this explicitly.

Publication is therefore a **separate, channel-specific** boundary so a product can be sold in-store
without being online, and vice-versa is impossible-by-rule (you cannot publish a non-active product):

- New columns on `products`: `storefront_status ∈ {unpublished, published}` (default `unpublished`)
  and `storefront_published_at`, kept consistent by a CHECK.
- **Publish gate** (enforced in the RPC, not the client): a product may become `published` only if it
  is `status = 'active'` **and** has at least one `active` variant that has an `active` price. This
  makes "publication of a structurally invalid product" impossible (`PRODUCT_NOT_PUBLISHABLE`).
- Archiving a product force-unpublishes it in the same transaction. Deactivating a published product
  is rejected (`PRODUCT_PUBLISHED`) — you unpublish first.
- **Public variant visibility is derived, not a second flag**: a published product exposes exactly its
  `active` variants that have an `active` price. This satisfies "published variants" without a
  parallel variant-publication lifecycle to keep in sync.

Publication is materially more sensitive than ordinary editing, so it requires a **distinct
permission** (`catalog.publish`) separate from authoring (`catalog.author`).

## Permissions

- `catalog.read` — management read (Phase 2F, existing).
- `catalog.author` — create/update/lifecycle/variant/option/price/media/taxonomy writes.
- `catalog.publish` — publish/unpublish to the Storefront.

All authorize against the target product's **brand** resource via the existing scope model. There is
no owner bypass and no role-name authorization. Cross-tenant writes are impossible: the brand resource
is tenant-checked in `AuthorizationService.authorize`, and every RPC re-derives `tenant_id` from the
authorized product row, never from client input.

## Product media

Online clothing sales require imagery. `product_media` stores **object-storage references, never
binaries**:

- Columns: `tenant_id`, `product_id`, optional `variant_id` (variant-specific imagery),
  `storage_bucket`, `storage_path`, `alt_text`, `position`, `is_primary`, `status ∈ {active,
  archived}`.
- Tenant isolation via `tenant_id` + composite FKs; one active primary per product (partial unique
  index); ordering via `position`.
- Commands: `addProductMedia` (records a reference), `reorderProductMedia`, `setPrimaryProductMedia`,
  `archiveProductMedia`.
- **Upload workflow**: binaries live in Supabase Storage. The API mints a short-lived signed upload
  URL for an authored path; the client uploads directly to storage and then records the reference via
  `addProductMedia`. The signed-URL minting is a documented seam over the Supabase Storage stack
  (excluded from the DB-only local test harness); the **metadata authority is fully implemented and
  tested** and is what both clients read to render imagery. This API never makes website
  layout/design editable — it concerns catalog media only.

## Public (Storefront-safe) read boundary

The Storefront must obtain only what it needs and must never see unpublished products, cost/internal
metadata, or authorization/scoping detail. Rather than trust an application-layer filter, the boundary
is **DB-enforced**: a `catalog_public` schema of `SECURITY DEFINER` functions, granted to `anon`, that
can only ever return the published projection:

- `list_published_products(tenant, brand?, cursor, limit)` and `get_published_product(tenant, slug)`.
- Returned projection: product name/slug/description, published variants (id, sku, option summary),
  public price (currency + minor amount), active media references, and category/collection membership.
- Never returned: `status`, internal timestamps, actor/membership data, cost, idempotency, or any
  unpublished row.
- The public route uses the **anon** key (no `X-Tenant-Id` management header, no membership); the
  tenant/brand the Storefront serves is an explicit request parameter, and the function hard-filters to
  `storefront_status = 'published'`.

## Inventory semantics

No Storefront-specific stock. Public availability, if surfaced, is derived from the same
`inventory_balances`/`InventoryLocation` truth via a read model. This phase introduces **no**
reservation/ATS semantics (no frozen invariant requires them here).

## Idempotency & concurrency

Every write command carries an `Idempotency-Key`; the RPCs fingerprint the caller payload exactly like
the inventory operations, so a retried create/variant/price/media/publish never duplicates. Product
and variant updates use optimistic concurrency (`expectedVersion`) where an administrator edit could
race, following the inventory count-adjustment precedent.

## SDK

`@shifted/clothing-commerce-sdk@0.6.0` exposes typed management operations (product/variant/option/
price/media/taxonomy/publish) and the public catalog reads, so Admin Mobile and Storefront consume the
packed SDK — never API source.
