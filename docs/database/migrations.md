# Database Migrations

## Purpose and authority

The ordered SQL files in `supabase/migrations/` are the authoritative database history for this
repository. They are how schema changes are reviewed, tested, and eventually promoted between
environments. Do not create schema objects manually and then leave their definitions outside this
history.

This guide describes the repository's migration workflow. The current implementation applies
migrations only to a disposable local PostgreSQL test container; a production migration or
deployment command has not been introduced.

## Naming and ordering

Name each migration `YYYYMMDDHHMMSS_short_description.sql`, using a unique UTC timestamp and a
concise snake-case description. The persistence runner discovers every `.sql` file in
`supabase/migrations/` and sorts filenames lexicographically, so the timestamp prefix is also the
execution order.

Phase 1C-A currently has three ordered migrations:

1. `20260819161500_create_foundational_organization.sql` creates organizational and physical
   location persistence.
2. `20260819161600_create_foundational_identity_access.sql` creates identity, membership, role,
   permission, and scope persistence.
3. `20260819161700_create_foundational_devices.sql` creates Device and Register assignment
   persistence.

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
- Are RLS, authentication, authorization, and business-domain changes kept out unless explicitly
  approved for the phase?
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
```

The command starts disposable PostgreSQL 17.6, applies every migration in order, runs the SQL
invariant suite, rebuilds the empty public schema, and repeats the complete cycle. No `.env` file,
Supabase project, production credential, or host database port is used. See
[Docker database testing](../docker/database-testing.md) for the exact lifecycle and failure
diagnostics.

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
- Docker startup, image pull, readiness, and cleanup failures are covered in the Docker testing
  guide.

## Security and current limitations

Phase 1C-A constraints defend structural tenant ownership, but RLS is intentionally absent. Future
Phase 1C-B work must add deny-by-default policies and server-established request context before
tenant data is exposed through application paths. The current test database uses disposable local
credentials only; server secrets must never be embedded in migrations, tests, SDK artifacts, or
client-visible code.

For schema concepts, see [Foundational schema](foundational-schema.md). For the physical design
decision, see
[ADR-011: Foundational PostgreSQL physical design](../decisions/ADR-011-foundational-postgresql-physical-design.md).
