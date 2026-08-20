# Migrations

This is the platform's only migration location. Migrations are authoritative, append-only, ordered,
and auditable.

Phase 1C-A introduces the foundational organizational, identity/access, and Register/Device
persistence sequence. Phase 1C-B adds a private request-context schema and RLS policies without
adding a commerce business-domain table. Phase 2A appends Product/Variant/options, merchandising,
base-price, and catalog RLS migrations. All five Phase 1 files remain unchanged.

Run `pnpm test:persistence` from the repository root to apply every SQL migration twice from an
empty PostgreSQL 17.6 schema and execute the database constraint tests.

Run `pnpm test:rls` to start the official local Supabase PostgreSQL environment, reset the same
history, execute the Phase 1C-B pgTAP security suite with Supabase roles, and remove its disposable
project data.

Run `pnpm test:catalog:persistence` and `pnpm test:catalog:rls` for the dedicated Phase 2A invariant
and policy suites. Both commands are mandatory CI layers.

See [Database migrations](../../docs/database/migrations.md) for naming, ordering, review, and
fix-forward policy. See
[Docker database testing](../../docs/docker/database-testing.md) for the runner lifecycle and
troubleshooting. See [Tenant isolation and RLS](../../docs/security/tenant-rls.md) before modifying
context helpers, grants, or policies.
