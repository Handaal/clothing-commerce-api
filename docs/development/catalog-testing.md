# Catalog Testing

## Commands

From the repository root with Docker running:

```powershell
pnpm test:catalog:persistence
pnpm test:catalog:rls
pnpm test:catalog:concurrency
```

Both commands use local disposable databases and require no `.env`, linked Supabase project, cloud
credential, Clerk key, or production data.

`test:catalog:persistence` starts a process-named `postgres:17.6-alpine` container with temporary
storage and no host port. It creates only non-login Supabase role fixtures, applies every migration,
runs 47 transaction-scoped catalog assertions, resets the public and private schemas, and repeats
the entire migration/assertion cycle. A `finally` path removes only the exact container it created.
The assertions include optionless single-default-variant uniqueness, lifecycle-wide archived-
combination reservation, partial (incomplete) option coverage, and the barcode primary UPDATE
collision.

`test:catalog:rls` uses the repository-pinned Supabase CLI. It starts the minimal local database
stack, resets all migrations, runs 43 pgTAP assertions using the real `authenticated`, `anon`, and
`service_role` roles, then stops and removes its disposable project data. The test proves runtime
same-tenant reads and foreign-row hiding on every new table, known-UUID denial, fail-closed claims,
authenticated INSERT/UPDATE/DELETE denial across all tables, anon denial, and the explicit service
role boundary.

`test:catalog:concurrency` starts its own process-named `postgres:17.6-alpine` container and runs a
deterministic two-session regression for the Tenant-scoped category advisory lock. It seeds two
disjoint chains in one Tenant, opens two real psql sessions, holds one reparent open, confirms a
different Tenant is not blocked, then confirms the second same-Tenant reparent genuinely waits on
the advisory lock (observed through `pg_stat_activity`, never a fixed sleep) and is rejected as a
cycle once the first commits. Every wait is bounded and a `finally` path removes only the container
it created.

The older `test:persistence` and `test:rls` remain mandatory regression layers. Catalog migrations
are applied by them too, while their foundational assertions stay deliberately scoped to Phase 1
tables. `pnpm test:all` runs unit/contract, authorization, both persistence, both RLS, and the
catalog concurrency suites.

## Fixtures and assertion placement

Catalog SQL fixtures use fixed obviously-test UUIDs inside a transaction and always roll back.
Migration files never seed products, permissions, or demo commerce data.

- Put portable table, foreign-key, CHECK, uniqueness, trigger, index-boundary, and deletion
  behavior in `supabase/tests/phase_2a_catalog_persistence.sql`.
- Put role grants, helper privileges, policy structure, runtime tenant visibility, mutation denial,
  and bypass behavior in `supabase/tests/phase_2a_catalog_rls.test.sql`.
- Keep persistence and RLS counts synchronized with their Node runners. A changed count is reviewed
  evidence, not a goal by itself.

When changing options, include a complete transaction: create/update the variant signature and its
selection rows, then allow the deferred canonical constraint to run. Tests may issue
`SET CONSTRAINTS ALL IMMEDIATE` to surface a deferred failure before rollback.

## Safe model changes

1. Read the catalog domain, persistence guide, applicable ADR, and migration policy.
2. Add a later append-only migration; never rewrite a migration already shared or applied.
3. Test a valid same-tenant state and the relevant negative cases: cross-tenant relationship,
   duplicate normalized identity, invalid lifecycle, and hard-delete behavior.
4. Add runtime RLS coverage for every new tenant table and preserve denied normal writes.
5. Run both catalog commands twice during final review, then run the complete repository sequence.
6. Inspect `git diff`, migration fingerprints, generated OpenAPI/SDK state, credentials, and exact
   disposable-container cleanup before handoff.

## Troubleshooting

- A named migration failure is DDL/order trouble; use the first PostgreSQL error and migration line.
- A deferred `product_variants_option_signature_canonical` failure means the stored signature is
  not the option-value UUID list selected for that variant, in option UUID order.
- A `categories_acyclic` failure means a parent update would make the category its own ancestor.
- SQLSTATE `23503`, `23505`, and `23514` identify foreign-key, uniqueness, and CHECK/constraint
  failures respectively.
- An RLS count mismatch usually means a table/policy/grant was added without updating the explicit
  catalog table list. Do not broaden policies to make a fixture pass.
- Supabase port/start/reset problems belong to the local stack; Docker readiness and temporary
  PostgreSQL problems belong to the persistence runner. See the general database testing guides.

Never point either runner at a remote or persistent database, add production credentials, or use a
broad Docker cleanup command.
