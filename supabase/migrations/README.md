# Migrations

This is the platform's only migration location. Migrations are authoritative, append-only, ordered,
and auditable.

Phase 1C-A introduces the foundational organizational, identity/access, and Register/Device
persistence sequence. Phase 1C-B adds a private request-context schema and RLS policies without
adding a commerce business-domain table. Phase 2A appends Product/Variant/options, merchandising,
base-price, and catalog RLS migrations. Phase 2B appends the inventory ledger (operations, movements,
balances), the private `inventory_private` mutation path, and inventory RLS. Phase 2C appends the
inventory operation functions and their grants. Phase 2D appends additive composite keys, an idempotent
platform permission-catalog seed, the order tables (`orders`, `order_lines`, `order_number_sequences`)
with the private `orders_private` mutation/preflight path, the order functions, and order RLS. All
earlier phase files remain unchanged.

The Phase 2D sequence is: `20260825180000_add_order_composite_keys.sql`,
`20260825180100_seed_platform_permissions.sql`, `20260825180200_create_orders.sql`,
`20260825180300_create_order_functions.sql`, `20260825180400_enable_orders_rls.sql`.

Run `pnpm test:persistence` from the repository root to apply every SQL migration twice from an
empty PostgreSQL 17.6 schema and execute the database constraint tests.

Run `pnpm test:rls` to start the official local Supabase PostgreSQL environment, reset the same
history, execute the Phase 1C-B pgTAP security suite with Supabase roles, and remove its disposable
project data.

Run `pnpm test:catalog:persistence` and `pnpm test:catalog:rls` for the dedicated Phase 2A invariant
and policy suites. Run `pnpm test:inventory:persistence`, `pnpm test:inventory:concurrency`, and
`pnpm test:inventory:rls` for the dedicated Phase 2B inventory ledger, balance-concurrency, and policy
suites. Run `pnpm test:orders:persistence`, `pnpm test:orders:rls`, `pnpm test:orders:concurrency`, and
`pnpm test:orders:integration` for the dedicated Phase 2D order persistence, policy, concurrency, and
integration suites. All are mandatory CI layers.

See [Database migrations](../../docs/database/migrations.md) for naming, ordering, review, and
fix-forward policy. See
[Docker database testing](../../docs/docker/database-testing.md) for the runner lifecycle and
troubleshooting. See [Tenant isolation and RLS](../../docs/security/tenant-rls.md) before modifying
context helpers, grants, or policies.
