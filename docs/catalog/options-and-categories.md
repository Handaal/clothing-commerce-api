# Product options and categories (Storefront program, Phase 1A)

## Purpose

Lets a brand describe its products the way shoppers browse them:

- **Options**: each variant's values per dimension, e.g. Size `M` and Colour `Black`, with an optional
  colour **swatch** per value. The Storefront uses them for size chips, colour swatches and filters.
- **Categories**: a single-parent tree, e.g. `Men → T-Shirts`. Top-level categories usually stand for the
  audience (Men, Women, Kids); children are product types. The Storefront uses them for the menu, category
  pages and filters.

## Why this approach

The tables existed since Phase 2A (`product_options`, `product_option_values`, `variant_option_values`,
`categories`, `product_categories`) with structural integrity (composite tenant FKs, a canonical
`option_signature`, cycle rejection). What was missing was a sanctioned write path and a public projection.
This phase adds only those, so no data model is duplicated and POS/online keep one product domain.

Options are **product-local and created on first use** (no global option dictionary): an admin types
"Size: M" and the server finds or creates the dimension and value, matching case-insensitively. This keeps
admin input simple and avoids a separate "define options first" step.

## How it works

Migration `supabase/migrations/20261119120000_catalog_options_categories_storefront.sql`:

| Function (`catalog_private`, service_role only, idempotent) | Effect |
|---|---|
| `create_variant_with_options` | Inserts a variant and applies its options in one transaction. |
| `set_variant_options` | Replaces a variant's whole selection; `[]` returns it to the `default` signature. |
| `update_option_values` | Sets `swatch_hex` (`#rrggbb`, stored lowercase, null clears) and `position`. |
| `create_category` / `update_category` / `set_category_status` | Category lifecycle (active ↔ archived). |
| `set_product_categories` | Replaces a product's category membership. |

`apply_variant_options` is the internal helper; it takes a per-product advisory lock so concurrent writes
can't race the product-local unique names, then recomputes `option_signature`. Two variants of one product
cannot share a selection (unique signature → `CT021` → `VARIANT_OPTIONS_CONFLICT`).

Public read (`catalog_public`, SECURITY DEFINER):

- `build_published_product` now adds `options` (only values used by an active, priced variant),
  per-variant `optionValues`, and `categories` (only categories whose whole ancestry is active).
- `list_storefront_categories(tenant)` returns active categories that hold at least one publicly visible
  product directly or in a descendant, with `productCount` including descendants.

## HTTP and SDK (0.44.0)

| Method | Path | SDK |
|---|---|---|
| POST | `/api/v1/products/{productId}/variants` (optional `options`) | `createVariant` |
| PUT | `/api/v1/products/{productId}/variants/{variantId}/options` | `setVariantOptions` |
| PATCH | `/api/v1/products/{productId}/option-values` | `updateOptionValues` |
| GET/POST | `/api/v1/categories` | `listCategories` / `createCategory` |
| PATCH | `/api/v1/categories/{categoryId}` | `updateCategory` |
| POST | `/api/v1/categories/{categoryId}/status` | `setCategoryStatus` |
| PUT | `/api/v1/products/{productId}/categories` | `setProductCategories` |
| GET | `/api/v1/storefront/categories?tenantId=` (public) | `listStorefrontCategories` |

Authorization: option writes need `catalog.author` on the product's brand; categories are tenant-wide and
need `catalog.author` tenant-wide (same as collections). Errors: `CATEGORY_NOT_FOUND` (404),
`CATEGORY_CYCLE` (409), `SLUG_CONFLICT` (409), `OPTION_VALUE_NOT_FOUND` (404),
`VARIANT_OPTIONS_CONFLICT` (409).

Responsible files: `src/catalog/category-{repository,service}.ts`, `src/catalog/catalog-management-service.ts`,
`src/catalog/supabase-catalog-{read,write}-repository.ts`, `src/catalog/public-product-shape.ts`,
`src/contracts/management/{categories,catalog-management,products}.ts`, `src/contracts/storefront/catalog.ts`.

## Testing

```bash
pnpm test:storefront:catalog:persistence
```

Runs `supabase/tests/phase_4a_catalog_options_categories_persistence.sql` on a disposable database with
every migration: privileges, first-use creation, case-insensitive matching, replay/ID409, duplicate
combinations, swatch validation, category cycles/slug conflicts/tenant isolation, the public projection, and
archived-branch hiding.

## Known limitations

- At most 3 option dimensions per variant; values are 1–60 characters.
- Option names/values can't be renamed in place yet (set a new value on the variants instead).
- Order lines still snapshot `option_signature` (value ids) as `option_summary`; a readable summary
  ("Size M · Black") is a follow-up.
- Categories are tenant-wide (not per brand), like collections.
