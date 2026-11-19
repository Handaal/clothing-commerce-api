# Development-only provisioning

`provision-dev-identity.sql` is **not** a migration and **not** a production seed. It is applied only by
`scripts/provision-dev-identity.mjs` against the local disposable Supabase Postgres container to bind a
real Clerk development subject into the Commerce authorization model for Phase 2F-B Admin Mobile runtime
acceptance.

See [docs/development/authentication-local.md](../../docs/development/authentication-local.md#development-identity-provisioning)
for the full workflow, safety guards, and troubleshooting. Never run this against a shared or production
database; the runner script has no way to target a non-local host.

## Rich catalog extras (Storefront visualisation)

Applied by hand to the local stack, after `seed-rich-catalog.sql`, to make the Storefront look realistic.
All are idempotent and local-only:

```bash
docker exec -i supabase_db_clothing-commerce-api psql -U postgres < supabase/dev/seed-rich-options-categories.sql
node scripts/seed-rich-product-photos.mjs
docker exec -i supabase_db_clothing-commerce-api psql -U postgres < supabase/dev/seed-size-guides.sql
```

- `seed-rich-options-categories.sql`: a Colour (with swatch) per product next to its Size, and a Men /
  Accessories category tree over the type categories, via the sanctioned Phase 1A functions. Zee Store
  is menswear only, so the women's fixture pieces (two dresses, leggings) are unpublished and the Dresses /
  Women categories archived.
- `seed-size-guides.sql`: test size guides (tops on Men, denim on Denim) via the Phase 2 write function.
- `scripts/seed-rich-product-photos.mjs`: real Unsplash photos at the seeded media paths.
- `seed-storefront-delivery.sql`: COD checkout + Egypt's 27 governorates (test fees, free over 2,000 EGP) for
  every dev brand with published products. Checkout needs `STOREFRONT_BRAND_ID` in the Storefront `.env`.
