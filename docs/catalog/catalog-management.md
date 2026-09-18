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
INVOKER` RPC in the `catalog_private` schema. Unlike the inventory ledger (which revoked `service_role`
DML and forced a dedicated DEFINER writer role), Phase 2A deliberately provisioned catalog with
`service_role` holding direct DML on the catalog tables ("catalog writes are server-side application
responsibilities"). The sanctioned functions therefore run as the calling `service_role`; they exist to
provide the multi-statement atomicity and idempotent-retry guarantees the application cannot get over
PostgREST, not a separate privilege boundary. Custom SQLSTATEs are internal-only and mapped to stable
`CatalogError` codes in the repository.

## Command surface (smallest complete set)

Products, variants, options, and prices are administered through explicit commands, not generic REST
PATCH-of-anything. Every command is tenant- and brand-authorized and idempotent via the platform
`Idempotency-Key` header.

- **Product**: `createProduct`, `updateProduct` (name/slug/style/description), `setProductStatus`
  (activate / deactivate `active→draft` / archive).
- **Variant**: `createVariant` (sku + optional display name; created internally `active`). SKU
  uniqueness is enforced by the existing `(tenant_id, normalized_sku)` unique index; a duplicate
  surfaces as `SKU_CONFLICT`. Variants use the default option signature; explicit multi-option
  combinations reuse the Phase 2A option tables and are a thin additive follow-up (see below).
- **Pricing**: `setVariantPrice` writes an active `variant_prices` row in minor units for a currency,
  archiving the prior active row for that currency (history preserved). Clients never write price
  directly; the server owns the price-integrity write.
- **Publication**: `publishProduct` / `unpublishProduct` (see below).
- **Media**: `createMediaUploadIntent`, `registerMedia`, `archiveMedia` (see Product media).

### HTTP + SDK surface

| Operation           | Route                                                       | Permission        |
| ------------------- | ----------------------------------------------------------- | ----------------- |
| create product      | `POST /api/v1/products`                                     | `catalog.author`  |
| update product      | `PATCH /api/v1/products/{productId}`                        | `catalog.author`  |
| lifecycle           | `POST /api/v1/products/{productId}/status`                  | `catalog.author`  |
| publish / unpublish | `POST` / `DELETE /api/v1/products/{productId}/publication`  | `catalog.publish` |
| create variant      | `POST /api/v1/products/{productId}/variants`                | `catalog.author`  |
| set price           | `PUT /api/v1/variants/{variantId}/price`                    | `catalog.author`  |
| media upload intent | `POST /api/v1/products/{productId}/media/upload-intent`     | `catalog.author`  |
| register media      | `POST /api/v1/products/{productId}/media`                   | `catalog.author`  |
| archive media       | `DELETE /api/v1/products/{productId}/media/{mediaId}`       | `catalog.author`  |
| public list         | `GET /api/v1/storefront/products?tenantId=&brandId=&limit=` | public            |
| public detail       | `GET /api/v1/storefront/products/{slug}?tenantId=`          | public            |

The SDK (`@shifted/clothing-commerce-sdk@0.6.0`) exposes these as typed tenant-scoped methods
(`client.withTenant(id).createProduct(...)`, `.publishProduct(...)`, `.setVariantPrice(...)`, …) and
public methods (`client.listPublishedProducts(...)`, `client.getPublishedProduct(...)`). Every
retry-sensitive write takes an `idempotencyKey`; the upload intent does not (it is not a mutation).

Historical Orders are never affected: all catalog FKs remain `ON DELETE RESTRICT`, and edits/archival
never mutate the immutable order pricing snapshots. There is **no hard delete**; lifecycle uses
draft/active/archived.

### Categories / Collections — deliberately deferred for this vertical

The canonical model contains `categories`, `collections`, and their product join tables (Phase 2A),
but Phase 2A documented them as foundational-and-unwired: "no [category] path is used yet",
"Rule-driven collections are deferred", membership is "manual". They are **intentionally deferred**
from this vertical rather than silently omitted. The storefront's first vertical
(catalog → product detail → variant selection → cart) functions without taxonomy: the public read
lists all published products and returns full detail. Taxonomy management (create/update/archive
category & collection, product↔category / product↔collection assignment) plus its public projection is
the immediate additive follow-up — it needs its own `catalog_private` RPCs and a public-projection
extension, and is scoped as the next thin increment. Likewise explicit variant option combinations
(`defineOption` / `addOptionValue`) reuse the existing Phase 2A option tables and are additive.

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
- `catalog.author` — create/update/lifecycle/variant/price/media writes.
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
  index); ordering via `position`. Setting a new primary demotes the previous primary in the same
  transaction.
- Commands: `createMediaUploadIntent` (authorize + return a server-owned destination),
  `registerMedia` (record the reference; may mark primary), `archiveMedia` (soft archive).
- **Upload workflow** (server controls the destination — the client can never choose an arbitrary
  storage path):
  1. `POST /api/v1/products/{productId}/media/upload-intent` authorizes `catalog.author` on the
     product's brand and returns `{ bucket: "product-media", path: "<tenantId>/<productId>/<uuid>.<ext>",
uploadUrl, expiresAt }`. The path is derived server-side from the verified tenant/product, so a
     returned upload URL can never target another tenant.
  2. The client uploads the object to that bucket/path (via `uploadUrl` when object storage is
     reachable).
  3. `POST /api/v1/products/{productId}/media` registers the reference through the catalog write
     boundary.
- **Storage dependency**: signed-URL minting is a `MediaUploadSigner` seam over the Supabase Storage
  stack, which is excluded from the local DB/integration harnesses; there the signer returns `null` and
  the integration test asserts the **authorization + tenant/product path scoping** (the security
  boundary) rather than a live object round-trip. The metadata authority is fully implemented and
  tested and is what both clients read to render imagery. This API never makes website layout/design
  editable — it concerns catalog media only.

## Public (Storefront-safe) read boundary

The Storefront must obtain only what it needs and must never see unpublished products, cost/internal
metadata, or authorization/scoping detail. Rather than trust an application-layer filter, the boundary
is **DB-enforced**: a `catalog_public` schema of `SECURITY DEFINER` functions (owned by a role that
bypasses RLS) that can only ever return the published projection:

- `list_published_products(tenant, brand?, limit)` and `get_published_product(tenant, slug)`.
- Returned projection: product id/brandId/slug/name/description/publishedAt, published variants
  (id, sku, displayName, optionSignature), public price(s) (currency + minor amount), active media
  references, and per-variant `inStock`. (Category/collection membership is a follow-up — see the
  taxonomy note above.)
- Never returned: internal `status`, actor/membership data, cost, idempotency state, price history, or
  any unpublished row. Internal-field absence is asserted in the acceptance test.
- The functions are granted `EXECUTE` to `anon` (the intended production caller). The server-side
  public read repository currently uses the service-role client narrowly wrapped to call **only** the
  two `catalog_public` functions — the DB function is the boundary, so the role does not widen what can
  be returned; binding the boundary to the anon key is a trivial future hardening.

### Public context resolution

The public routes require **no session and no `X-Tenant-Id` header**. The tenant (and optional brand)
the Storefront serves is an explicit request parameter (`?tenantId=…&brandId=…`), because published
catalog is public data by definition and the function hard-filters to `storefront_status = 'published'`.
For V1 the Storefront is configured with its tenant/brand id and passes it directly. Host/custom-domain
→ tenant/brand resolution (a storefront-context lookup keyed by hostname) is a future storefront concern
and is intentionally **not** built here; nothing about this contract precludes adding it later.

## Inventory semantics & public availability

Phase 2L extends the availability calculation to subtract reservations and honor configured checkout
routing. The implementation and current semantics are in [online commerce core](../orders/online-commerce-core.md).
The paragraphs below describe the original Phase 2J physical-stock baseline.

No Storefront-specific stock. The DB projection derives `availableQuantity` by summing
`inventory_balances.on_hand_quantity` across the tenant's locations for the variant — the single
`InventoryLocation` truth, no second stock model. The **public API contract is conservative**: it
exposes only a per-variant `inStock` boolean (`availableQuantity > 0`) and never the exact quantity, so
competitors/customers cannot read stock levels. This phase introduces **no** reservation/ATS semantics
(no frozen invariant requires them here).

## Idempotency & concurrency

Every write command carries an `Idempotency-Key`; the RPCs fingerprint the caller payload (via a shared
`catalog_write_operations` ledger) exactly like the inventory operations, so a retried
create/variant/price/media/publish replays the original result and never duplicates; the same key with
a different payload is `IDEMPOTENCY_CONFLICT` (409). Price replacement and the publish gate run under
row locks for atomicity. Optimistic `expectedVersion` concurrency is deliberately **not** added for
product/variant edits in this phase: administrator edits are low-concurrency and idempotency already
prevents retry duplication; it can be added additively if a real edit-conflict need emerges.

## SDK

`@shifted/clothing-commerce-sdk@0.6.0` exposes typed management operations
(product/variant/price/media/publish) and the public catalog reads, so Admin Mobile and Storefront
consume the packed SDK — never API source.
