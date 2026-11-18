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
```

- `seed-rich-options-categories.sql`: a Colour (with swatch) per product next to its Size, and a Men / Women /
  Accessories category tree over the type categories, via the sanctioned Phase 1A functions.
- `scripts/seed-rich-product-photos.mjs`: real Unsplash photos at the seeded media paths.
