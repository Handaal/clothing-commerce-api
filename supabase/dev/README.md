# Development-only provisioning

`provision-dev-identity.sql` is **not** a migration and **not** a production seed. It is applied only by
`scripts/provision-dev-identity.mjs` against the local disposable Supabase Postgres container to bind a
real Clerk development subject into the Commerce authorization model for Phase 2F-B Admin Mobile runtime
acceptance.

See [docs/development/authentication-local.md](../../docs/development/authentication-local.md#development-identity-provisioning)
for the full workflow, safety guards, and troubleshooting. Never run this against a shared or production
database; the runner script has no way to target a non-local host.
