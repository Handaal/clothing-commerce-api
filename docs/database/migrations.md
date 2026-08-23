# Database Migrations

## Purpose and authority

The ordered SQL files in `supabase/migrations/` are the authoritative database history for this
repository. They are how schema changes are reviewed, tested, and eventually promoted between
environments. Do not create schema objects manually and then leave their definitions outside this
history.

This guide describes the repository's migration workflow. The current implementation applies
migrations to disposable plain-PostgreSQL and local-Supabase test environments; a staging or
production migration/deployment command has not been introduced.

## Naming and ordering

Name each migration `YYYYMMDDHHMMSS_short_description.sql`, using a unique UTC timestamp and a
concise snake-case description. The persistence runner discovers every `.sql` file in
`supabase/migrations/` and sorts filenames lexicographically, so the timestamp prefix is also the
execution order.

The repository currently has eleven ordered migrations:

1. `20260819161500_create_foundational_organization.sql` creates organizational and physical
   location persistence.
2. `20260819161600_create_foundational_identity_access.sql` creates identity, membership, role,
   permission, and scope persistence.
3. `20260819161700_create_foundational_devices.sql` creates Device and Register assignment
   persistence.
4. `20260819173000_create_rls_request_context.sql` creates identity-provider-neutral request-claim
   and active-Membership helpers in the private `commerce_context` schema.
5. `20260819173100_enable_foundational_tenant_rls.sql` enables RLS across all 18 tables, creates the
   reviewed SELECT policies, denies normal authenticated writes, and grants the explicit
   server-only service-role path.
6. `20260819180000_create_catalog_products_variants.sql` creates Product, Variant, Barcode, and
   extensible option persistence plus canonical variant-combination enforcement.
7. `20260819180100_create_catalog_merchandising.sql` creates Categories, Collections, their Product
   associations, and database-safe category-cycle prevention.
8. `20260819180200_create_catalog_pricing.sql` creates minimal Variant base-price history.
9. `20260819180300_enable_catalog_tenant_rls.sql` enables catalog RLS and conservative grants for
   all eleven new tables.
10. `20260821180000_create_inventory_ledger.sql` creates the dedicated non-login `inventory_writer`
    role, the private `inventory_private` schema, the
    `inventory_operations`/`inventory_movements`/`inventory_balances` tables, append-only and
    balance-guard triggers, and the atomic `SECURITY DEFINER` `record_operation` mutation function;
    it transfers table and function ownership to `inventory_writer`.
11. `20260821180100_enable_inventory_tenant_rls.sql` enables inventory RLS, authenticated SELECT
    policies, and grants `service_role` `SELECT` plus `EXECUTE` on `record_operation` only — no direct
    table DML — so the function is the sole server write path for all three inventory tables.
12. `20260822180000_create_inventory_operation_functions.sql` (Phase 2C) extends the `operation_type`
    CHECK with `issue` and adds the hardened `record_opening` and `record_count_adjustment` functions,
    transferring their ownership to `inventory_writer` with the non-superuser-compatible transient
    `CREATE`-grant pattern.
13. `20260822180100_grant_inventory_operation_functions.sql` (Phase 2C) grants `service_role` EXECUTE
    on the two new functions and revokes it from PUBLIC/anon/authenticated; it adds no tables or RLS.

The dependency order is intentional. A later migration may depend on an earlier one; an earlier
migration must never depend on an object introduced later.

## Adding a migration safely

1. Read the applicable architecture guide and ADR before designing the physical change.
2. Create a new migration with a later, unique timestamp. Keep one coherent change in each file.
3. Express ownership and integrity explicitly with nullability, CHECK constraints, unique keys,
   foreign keys, delete behavior, and indexes.
4. For tenant-owned relationships, carry `tenant_id` and use composite foreign keys where needed to
   make cross-tenant references impossible.
5. Add or update SQL tests for successful paths, rejected invalid states, and schema boundaries.
6. Update the durable documentation that explains the changed model and operational behavior.
7. Run the complete validation sequence in [Development testing](../development/testing.md).

Never use a manual database edit as the lasting fix. If an exploratory edit was made in a local
database, reproduce it in a migration and recreate the database before relying on the result.

## Review checklist

- Does the migration stay within the approved phase and repository boundary?
- Is its filename unique and ordered after all dependencies?
- Are tenant-owned keys and relationships tenant-safe by construction?
- Are lifecycle, time ordering, deletion, and uniqueness rules explicit?
- Do indexes support known access paths without speculating about future queries?
- Could the change lock, rewrite, truncate, or silently reinterpret existing data?
- Is a destructive change replaced by an expand-and-contract sequence where practical?
- Are RLS, authentication, authorization, and business-domain changes kept within the explicitly
  approved phase boundary?
- For RLS changes, were every table and operation, role grants, helper privileges, fixed
  `search_path`, recursion risk, bypass role, and negative attack path reviewed?
- Do tests prove both valid behavior and important rejection paths?
- Do architecture, operations, and troubleshooting documentation remain accurate?

## Compatibility and destructive changes

Prefer additive changes. A typical backward-compatible sequence adds a nullable column or new
object, deploys compatible writers/readers, backfills under controlled conditions, validates the
new invariant, and only then removes the old representation in a later migration. Renames, type
changes, `NOT NULL` additions, and constraint validation can be disruptive on populated databases
and require an explicit rollout design.

Dropping a table or column, truncating data, changing identifier meaning, or weakening tenant
boundaries requires separate approval and a recovery plan. A green empty-database test does not
prove that a destructive migration is safe for production data.

## Rollback philosophy

Migration history is append-only once a migration has been applied to a shared or production
environment. Fix forward with a new migration; do not rewrite the applied file. This keeps the
history auditable and ensures every environment can converge through the same ordered sequence.

An uncommitted migration that has never left an isolated development workspace may be corrected
during review. Once it has been shared or applied outside that disposable context, treat it as
immutable. Database backup restoration is an operational disaster-recovery action, not the normal
schema rollback mechanism.

## Applying and testing today

From the repository root:

```powershell
pnpm test:persistence
pnpm test:catalog:persistence
pnpm test:inventory:persistence
pnpm test:rls
pnpm test:catalog:rls
pnpm test:inventory:rls
pnpm test:catalog:concurrency
pnpm test:inventory:concurrency
```

The persistence commands start disposable PostgreSQL 17.6, apply every migration in order, run
their foundational or catalog SQL invariant suite, rebuild empty public/private schemas, and repeat
the complete cycle. The RLS commands use official local Supabase roles, reset from migrations, run
their pgTAP suite, and remove local project data. None needs an `.env` file, linked cloud project,
or production credential. See
[Docker database testing](../docker/database-testing.md) for the exact lifecycle and failure
diagnostics and [Local Supabase development](../development/supabase-local.md) for the RLS path.

There is currently no repository command for applying migrations to staging or production. Do not
point the local runner at a persistent or remote database.

## Troubleshooting

- A failure labelled with a migration filename is a migration/application error; use the first
  PostgreSQL error and its line context as the primary signal.
- An object-already-exists error during the first cycle usually means two migrations define the same
  object or a migration is not valid from an empty schema.
- A second-cycle failure indicates the full history cannot recreate cleanly after schema reset.
- A SQL assertion failure means the database accepted or rejected a state differently from the
  documented invariant.
- An RLS assertion failure should be investigated under the named database role and request claims;
  do not weaken a policy merely to make a positive path pass.
- Docker startup, image pull, readiness, and cleanup failures are covered in the Docker testing
  guide.

## Security and current limitations

Phase 1C-A constraints defend structural tenant ownership and Phase 1C-B now supplies the tested
deny-by-default RLS backstop. The context claims must be established by a trusted server/JWT path;
Phase 1D still owns identity-provider integration and application permission/AccessScope
authorization. Local test credentials are disposable; server secrets must never be embedded in
migrations, tests, SDK artifacts, or client-visible code.

For schema concepts, see [Foundational schema](foundational-schema.md),
[Catalog persistence](../catalog/catalog-persistence.md), and
[Inventory persistence](../inventory/inventory-persistence.md). For the foundational physical design
decision, see
[ADR-011: Foundational PostgreSQL physical design](../decisions/ADR-011-foundational-postgresql-physical-design.md).
