# Vendors: shop by brand (Storefront program, SDK 0.50)

## Purpose

Zee Store is a retailer: it sells pieces made by other labels (Zara, Polo Ralph Lauren, H&M, Armani
Exchange, local labels). Shoppers want to browse by that label. A **vendor** is the label a product is
made by. The apps show it to people as **Brand**.

It is called "vendor" in code and data because `brands` already means the tenant's own selling brand
(Zee Store itself, the `brand_id` on products, orders and checkout settings). Mixing the two would break
every brand-scoped permission and query.

## Model

- `public.vendors`: tenant-wide (like categories and collections), `name`, unique `slug` per tenant,
  `position`, `status` active ↔ archived.
- `public.products.vendor_id`: optional, at most one vendor per product, composite tenant FK.
- Archiving a vendor hides it from the Storefront; its products stay listed, just without a brand.

## How it works

Migration `supabase/migrations/20261120100000_catalog_vendors.sql`:

| Function (`catalog_private`, service_role only, idempotent) | Effect                                  |
| ----------------------------------------------------------- | --------------------------------------- |
| `create_vendor` / `update_vendor`                           | Name, slug, position.                   |
| `set_vendor_status`                                         | active ↔ archived.                      |
| `set_product_vendor`                                        | Set or clear (null) a product's vendor. |

Public read (`catalog_public`, SECURITY DEFINER):

- `build_published_product` now returns the previous projection (kept as
  `build_published_product_base`) plus `vendor: { id, slug, name } | null` (active vendors only).
- `list_storefront_vendors(tenant)`: active vendors with at least one publicly visible product, with
  `productCount`, ordered by position then name.

Error codes: `CT060` → `VENDOR_NOT_FOUND` (404), `CT010` → `SLUG_CONFLICT` (409).

## HTTP and SDK (0.50.0)

| Method   | Path                                            | SDK                            |
| -------- | ----------------------------------------------- | ------------------------------ |
| GET/POST | `/api/v1/vendors`                               | `listVendors` / `createVendor` |
| PATCH    | `/api/v1/vendors/{vendorId}`                    | `updateVendor`                 |
| POST     | `/api/v1/vendors/{vendorId}/status`             | `setVendorStatus`              |
| PUT      | `/api/v1/products/{productId}/vendor`           | `setProductVendor`             |
| GET      | `/api/v1/storefront/vendors?tenantId=` (public) | `listStorefrontVendors`        |

Authorization: `catalog.author` tenant-wide (same as categories). Management product detail gains
`vendorId`.

```bash
pnpm test:storefront:vendors:persistence
```

Runs `supabase/tests/phase_5a_catalog_vendors_persistence.sql` on a disposable database.

Dev data: `supabase/dev/seed-vendors.sql` (Zara, Polo Ralph Lauren, H&M, Armani Exchange and two made-up
local labels on the rich catalog fixture).

Responsible files: `src/catalog/vendor-{repository,service}.ts`, `src/contracts/management/vendors.ts`,
`src/contracts/storefront/catalog.ts`, `src/catalog/public-product-shape.ts`.
