# Catalog Domain

## Purpose and boundary

Phase 2A establishes one tenant-owned catalog shared by online and POS consumers. It defines the
merchandising concept, its stock-keeping variants, identifiers, classification, manual collections,
and a minimal base-price record. It does not expose catalog HTTP endpoints and does not implement
publication, inventory, checkout, orders, customers, purchasing, promotions, search, or media
upload.

## Product, Brand, and Variant

A **Product** is the merchandising style a shopper recognizes, such as “Classic Linen Shirt.” It
belongs directly to one Tenant and one same-tenant Brand. Direct `tenant_id` is deliberate: RLS and
foreign keys must not infer ownership through Brand. Product never belongs to a Branch, Warehouse,
POS, or storefront. An inactive or archived Brand prevents future product activation in the
application service; it does not cascade or erase existing products.

A **ProductVariant** is a concrete stock-keeping and potentially sellable choice, such as
“White / M.” Future inventory attaches to `ProductVariant + InventoryLocation`; order lines,
transfers, purchasing, and barcode resolution will also reference the stable variant UUID. The
variant therefore does not contain an InventoryLocation and is not duplicated by sales channel.

Every variant has a tenant-wide SKU. A product without meaningful options still has one variant
whose option signature is `default`. Product creation must precede variant creation, so the
database intentionally does not impose a fragile circular “product must already have a variant”
constraint. A future activation service will require at least one eligible variant before a
product can be sold.

An optional Product `style_code` represents a clothing business's style-level human code, for
example `SHIRT-001`. It is distinct from variant SKUs such as `SHIRT-001-BLK-M`. Businesses that do
not use a style code may leave it null.

Phase 2A keeps one optional Product description instead of guessing separate short/long editorial
contracts before transport and storefront requirements exist. It also omits product type and tax
classification placeholders: neither has an approved behavior yet, and nullable guesses would
become misleading schema commitments.

## Lifecycle and visibility

Products and variants use `draft`, `active`, and `archived`:

- `draft` may be incomplete and may have variants or option definitions while being prepared.
- `active` means internally eligible for catalog workflows. It does **not** mean published online,
  visible at POS, priced, or in stock.
- `archived` is retained for history and cannot be sold. `archived_at` is mandatory in that state.
  Normal application workflows treat archive as terminal; any exceptional restoration will need a
  reviewed service rule later.

Archiving a Product does not cascade status changes or deletes to variants. The parent status makes
the variants ineligible, while their identifiers and future transactional references remain. The
database permits draft construction and preserves history; application activation will eventually
check parent/variant state, price, publication, and other sales rules atomically.

Storefront publication and POS availability are separate future concepts. A later publication
model may select active products/variants per channel, locale, or market. Neither client will own a
second authoritative product record.

## SKU and barcode identity

SKU is required on every variant, case/outer-whitespace normalized, unique within a Tenant, and
non-reusable across draft, active, and archived rows. UUID remains the database identity. SKU may
be human- or system-generated; future services may allow editing before commercial history and
must control changes afterward.

A variant has zero or many dedicated Barcode rows. Barcode values are normalized by lowercasing
and trimming outer whitespace, tenant-wide unique across all lifecycle states, and therefore never
resolve ambiguously or become reusable after retirement. One active barcode per variant may be
marked primary; alternate manufacturer or internal identifiers remain possible. Supported type
labels are `ean13`, `upc_a`, `code128`, and `other`; type does not replace value validation at
future ingestion boundaries.

## Clothing options without hardcoding Size and Color

`ProductOption` defines a product-local dimension such as Size, Color, Material, or Style.
`ProductOptionValue` defines allowed values, and `VariantOptionValue` selects at most one value for
each option on a variant. This is enough for clothing combinations without introducing a rules
engine, nested option behavior, or fixed `size`/`color` columns.

To add another option type, insert another ProductOption and its values for the product; no schema
change is required. A variant selection carries Tenant, Product, Variant, Option, and Value keys so
composite foreign keys reject cross-tenant and cross-product combinations.

Each variant stores a canonical option signature: selected value UUIDs ordered by option UUID and
joined with commas, or `default` when it has no selections. A deferred database constraint checks
the signature against the relational selections at transaction completion. A unique constraint on
Product plus signature rejects a second logical Black/M variant. Writers create or update the
variant and its selections in one transaction and may defer integrity until all rows are present.

This signature uniqueness is lifecycle-wide, not limited to active rows. One Product plus one exact
option combination is one durable ProductVariant identity for its whole lifetime. If Black/M is
archived and later sold again, a future lifecycle service reactivates the original variant after
validating business conditions; it never creates a second variant UUID for the same combination.
Keeping the archived identity stable protects future inventory, purchasing, order-line, return, and
reporting references.

The database enforces selection _consistency_ but not option _completeness_. It guarantees each
selected option belongs to the Product, each value belongs to its option, at most one value per
option, and a signature that matches the selections. A draft variant may still select values for
only some options (for example Size without Color); requiring every option to be chosen is a future
activation/sellability responsibility, not a persistence rule.

## Category and Collection

A **Category** is hierarchical classification: Clothing → Tops → Shirts. It has at most one parent.
The parent foreign key is tenant-safe, a CHECK rejects self-parenting, and a trigger walks ancestors
to reject longer cycles. Before that walk, the trigger takes a Tenant-scoped transaction advisory
lock so concurrent hierarchy mutations within one Tenant are serialized and cannot both commit a
cycle (for example X → Y racing with Y → X); different Tenants keep mutating categories in parallel.
This is a simple tree/forest, not an arbitrary taxonomy graph, and no closure table or materialized
path is used yet. Products may belong to multiple categories through an explicit many-to-many table.

A **Collection** is a flat, curated merchandising grouping such as Summer 2026 or New Arrivals.
Membership is manual and can be ordered. Collections do not inherit category ancestry and do not
yet contain dynamic selection rules or visibility schedules. Products may belong to multiple
collections.

Category and Collection slugs are human-facing, tenant-scoped, normalized, and lifecycle-wide
non-reusable. Product slugs follow the same tenant scope rather than Brand scope so a future
multi-brand tenant surface cannot have ambiguous paths. UUIDs remain the stable references. Slug
redirect/alias support is deferred; future slug mutation services must consider old URLs.

## Pricing boundary

Price belongs to ProductVariant because variants may differ in price. `VariantPrice` stores an
explicit three-uppercase-letter currency and a nonnegative `bigint amount_minor`; JavaScript
floating point is never authoritative. At most one active base-price row exists per Tenant, Variant,
and currency; zero active prices is a valid state for draft, incomplete, or temporarily unpriced
variants, and price presence may become a future activation/sellability requirement. Replacing a
price archives the old row and creates a new active row, retaining history.

`amount_minor` is stored as PostgreSQL `bigint`, the authoritative representation, and currencies are
not assumed to all use two decimal places (`amount_minor` is raw minor units for the stated
currency). Because a JavaScript `Number` is only exact to `2^53 - 1`, a future HTTP/OpenAPI/SDK
transport must not blindly map arbitrary `int8` amounts into a JS `Number`; it must adopt an
explicit safe representation such as a decimal string of minor units or a deliberately bounded
safe-integer contract. No public pricing serialization exists in this phase.

The currency is self-describing even when it matches Tenant default currency. The model allows a
future second currency without reinterpreting old rows, but it does not perform FX conversion.
Price lists, compare-at prices, tax computation, branch/channel overrides, effective scheduling,
and promotions are deliberately deferred.

## Media boundary

No media table or storage integration is created in Phase 2A. A future model should attach ordered
metadata references and alt text to a Product, with optional ProductVariant association for
variant-specific imagery. Binary upload/storage, transformations, and delivery belong to a later
approved phase and must not be encoded as ad hoc Product columns now.

## Authorization boundary

Active tenant members may read their tenant's catalog through the database backstop. Normal
authenticated database writes are denied. A future catalog application service will authorize
conceptual operations such as `catalog.read`, product create/update/archive, and derive `tenant_id`
from trusted authorization proof before using the server-only service role. Permission seeds and
Product/Variant AccessScope kinds are not introduced: Brand- or tenant-scoped authorization is the
current intended starting point.

## Deferred capabilities

Inventory quantities and the movement ledger, purchasing/suppliers, orders, customers/customer
authentication, payments, promotions/vouchers, checkout, storefront and POS APIs/UI, search,
media upload, dynamic collections, publication, and channel-specific pricing all remain later-phase
work.
