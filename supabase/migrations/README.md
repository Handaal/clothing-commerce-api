# Migrations

This is the platform's only migration location. Migrations are authoritative, append-only, ordered,
and auditable.

Phase 1C-A introduces the foundational organizational, identity/access, and Register/Device
persistence sequence. It deliberately creates no RLS policy or commerce business-domain table.

Run `pnpm test:persistence` from the repository root to apply every SQL migration twice from an
empty PostgreSQL 17.6 schema and execute the database constraint tests.

See [Database migrations](../../docs/database/migrations.md) for naming, ordering, review, and
fix-forward policy. See
[Docker database testing](../../docs/docker/database-testing.md) for the runner lifecycle and
troubleshooting.
