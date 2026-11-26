# Website images and product photo editing (SDK 0.53)

## Purpose

Close the last "can't edit it" gaps on the website, from both Admin Mobile and the POS Website desk:

- **Collection covers** — a custom image for the collection card and the collection page banner.
- **Category images** — a custom image for the home page category tile.
- **Product photos after upload** — list them, describe them (alt text), choose the main photo, reorder
  (the first photo is the main one), remove.
- Hardening: a product photo can only be registered at the path its own upload intent issued.

Without a custom image the website keeps its previous behaviour (the first product photo).

## How it works

- Migration `20261124130000_catalog_images_and_media_editing.sql`:
  - `collections.cover_image_{bucket,path,alt}` and `categories.image_{bucket,path,alt}`, with checks that
    the path is under `<tenant>/catalog/`.
  - `catalog_private.set_collection_image` / `set_category_image` (null path clears), and
    `update_product_media` (alt text and/or main) / `reorder_product_media` (complete order of active
    photos; first becomes main). Security definer, `service_role` execute only.
  - `catalog_public.build_collection_summary` prefers the custom cover; `build_published_collection` adds
    `cover`; `list_storefront_categories` adds `image` (replaced in place, same grants).
- Contracts: `src/contracts/management/catalog-images.ts`; `CollectionSummary.image`,
  `CategorySummary.image`, `PublicCategory.image`, `PublicCollectionDetail.cover` (all optional).
- Endpoints (all `catalog.author`):
  - `POST /api/v1/catalog-images/upload-intent` → `<tenant>/catalog/<uuid>.<ext>` + signed URL (no key);
  - `PUT /api/v1/collections/{id}/image`, `PUT /api/v1/categories/{id}/image` (`{ image | null }`);
  - `GET /api/v1/products/{id}/media`, `PATCH /api/v1/products/{id}/media/{mediaId}`,
    `PUT /api/v1/products/{id}/media/order`.
- SDK: `createCatalogImageIntent`, `setCollectionImage`, `setCategoryImage`, `listProductMedia`,
  `updateProductMedia`, `reorderProductMedia`.
- Storefront: category tiles use `image` first; the collection page shows `cover` as a banner; collection
  cards already use `cover`.
- Home hero: once the store has saved its hero, an empty small label or subtitle is **hidden** (before the
  first save the built-in copy shows; the headline and button still fall back).

## Testing

- `pnpm test:website:http` M15 (covers/category images, scope checks) and M16 (photo list, describe, main,
  reorder, path check, partial order refused).
- Cross-channel: `node scripts/test-offline-pos-http-isolated.mjs --dir tests/website-management-http --exec ../website-site-text-acceptance.mjs`
  drives Admin Mobile (collection rename, photo edits) and the POS (category/brand rename, delivery fee,
  main photo) and checks the rendered website. The isolated stack has no object storage, so image bytes
  are not uploaded there; each app's upload flow is unit-tested with a stubbed upload.

## Limitations

- Product photos have no per-variant reassignment UI (variant-specific photos are still set at upload).
- New categories and product-to-category assignment stay in Admin Mobile; the POS edits existing ones.
