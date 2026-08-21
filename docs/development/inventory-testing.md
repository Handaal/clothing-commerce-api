# Inventory Testing

## Commands

From the repository root with Docker running:

```powershell
pnpm test:inventory:persistence
pnpm test:inventory:concurrency
pnpm test:inventory:rls
```

All three use local disposable databases and require no `.env`, linked Supabase project, cloud
credential, Clerk key, or production data. Each is a mandatory CI layer.

## What each suite proves

`test:inventory:persistence` (`scripts/test-inventory-persistence.mjs`,
`supabase/tests/phase_2b_inventory_persistence.sql`) starts a process-named `postgres:17.6-alpine`
container with temporary storage and no host port, creates only non-login Supabase role fixtures,
applies every migration, and runs 54 transaction-scoped assertions, then resets the public and
private schemas and repeats the whole migration/assertion cycle. It exercises opening stock as a
movement (never a seeded balance), compensating adjustments, the balance-equals-ledger-sum
reconciliation invariant, multi-line and zero-sum (transfer-shaped) operations, same-key/same-payload
replay and same-key/different-payload rejection (`ID409`), fingerprint stability under reordered JSON
keys, the deliberate `occurred_at` exclusion (a replay with a different `occurred_at` returns the
original operation and keeps its original business time), tenant-scoped and cross-tenant idempotency,
negative-intermediate-line rejection, `bigint` overflow rollback,
oversell/zero/empty/blank/unknown-type rejection, cross-tenant Variant/Location/Operation/actor
rejection, append-only history, and — the privilege boundary — `SECURITY DEFINER`/`inventory_writer`-
owner structure plus `service_role` direct INSERT/UPDATE/DELETE denial with `service_role` `EXECUTE`
of the mutation path succeeding.

`test:inventory:concurrency` (`scripts/test-inventory-concurrency.mjs`) starts its own container and
runs a deterministic two-session regression with real independent psql sessions:

1. **Oversell race** — with on-hand 1, two concurrent `-1` deductions; the second genuinely blocks on
   the balance row lock (observed through `pg_stat_activity`, never a fixed sleep), exactly one
   commits, the balance floors at 0, and only the committed deduction reaches the ledger.
2. **First-balance creation race** — two concurrent positive movements to an absent
   `(tenant, variant, location)` key produce exactly one balance row summing both deltas.
3. **Independent keys** — a held lock on one location's balance never blocks a mutation on a
   different location's balance.
4. **Opposing multi-key, no deadlock** — a holder locks the canonical-first key while two operations
   submit the same two keys in opposite payload order; both queue on the canonical-first key and
   complete without a `40P01` deadlock, proving canonical lock ordering.
5. **Opposing multi-key with absent balances** — both keys start with no balance row; two operations
   submit them in opposite payload order. The second blocks on the first session's pending unique
   insert for the canonical-first key, then completes; there is no `40P01`, exactly one row per key,
   and both deltas and ledger sums are preserved. This covers the unique-index-insert + absent-row
   creation + canonical-ordering interaction together.
6. **Concurrent identical idempotency** — two sessions submit the same key and payload; the second
   blocks on the pending idempotency row and resolves to the same operation, applying stock once.
7. **Concurrent conflicting idempotency** — two sessions submit the same key with different payloads;
   exactly one wins and the other is rejected with the `ID409` mismatch, applying only the winner.

Every wait is bounded and a `finally` path removes only the container it created.

`test:inventory:rls` (`scripts/test-inventory-rls.mjs`,
`supabase/tests/phase_2b_inventory_rls.test.sql`) uses the repository-pinned Supabase CLI. It starts
the minimal local stack, resets all migrations, runs 30 pgTAP assertions with the real
`authenticated`, `anon`, and `service_role` roles, then stops and removes its disposable project
data. It proves same-tenant reads and foreign-row hiding on all three tables, known-UUID denial,
fail-closed and suspended-membership claims, authenticated INSERT/UPDATE/DELETE denial, the inability
of `authenticated` to execute the private mutation path, and anon denial. For the F1 privilege
boundary it also asserts the trigger helpers are `SECURITY INVOKER` while `record_operation` is
`SECURITY DEFINER` owned by `inventory_writer`, that `service_role` has `SELECT`-only grants and **no**
direct table DML, and that only `service_role` may `EXECUTE` `record_operation`.

## Explicit-TCP test-runner rule (permanent)

Every disposable direct-PostgreSQL runner — persistence and concurrency — connects over
container-internal TCP `--host 127.0.0.1 --port 5432` with an explicit `PGPASSWORD`, and probes
readiness with `pg_isready` over the **same** TCP target. The official image first runs a temporary
socket-only init server and then starts the real server; a Unix-socket readiness probe can pass
against the temporary server and the next call then races its teardown. The temporary server never
serves TCP, so a TCP target is race-free and identical on Windows and Linux. Never reintroduce an
implicit Unix-socket connection or publish a host database port. This rule is shared with the
catalog and foundational runners; see [Docker database testing](../docker/database-testing.md).

## Docker lifecycle

Persistence and concurrency runners each `docker run --detach --rm --tmpfs /var/lib/postgresql/data`
a uniquely process-named container, apply migrations, run their checks, and remove only that
container in a `finally` block. The RLS runner starts and stops the local Supabase stack instead. No
runner reuses a container across cycles for its migration reconstruction; persistence reconstructs
twice from an empty schema.

## Fixtures and assertion placement

Inventory SQL fixtures use fixed obviously-test UUIDs inside a transaction and always roll back.
Migration files never seed inventory data; opening stock in tests is always created through
`inventory_private.record_operation`, never by inserting a balance row.

- Put table, FK, CHECK, uniqueness, trigger, reconciliation, idempotency, and mutation-function
  behavior in `supabase/tests/phase_2b_inventory_persistence.sql`.
- Put role grants, helper privileges, policy structure, runtime tenant visibility, mutation denial,
  and bypass behavior in `supabase/tests/phase_2b_inventory_rls.test.sql`.
- Keep the assertion/plan counts synchronized with their Node runners; a changed count is reviewed
  evidence, not a goal.

## Development versus production

Runners target only local disposable databases. In production the privilege model is the boundary:
`service_role` can only `EXECUTE record_operation` and cannot write the inventory tables directly, so
it cannot create ledger/balance divergence. A database superuser and the `inventory_writer` table
owner remain trusted infrastructure and can bypass controls during governed maintenance; the
append-only and balance-guard triggers are internal defense-in-depth, not the boundary, and none of
this replaces server-side application authorization. See
[inventory persistence](../inventory/inventory-persistence.md) for the trust boundary.

## Troubleshooting

- SQLSTATE `23503`, `23505`, and `23514` identify foreign-key, uniqueness, and CHECK/constraint
  failures (including a negative intermediate on-hand); `22023`/`22P02` identify an invalid mutation
  argument (zero delta, empty movements, blank key, malformed UUID/quantity); `22003` identifies a
  `bigint` overflow; `ID409` identifies an idempotency key reused with a different payload; `42501`
  identifies a denied write (including any direct `service_role` table DML) or a denied private-schema
  execution.
- An `insufficient stock` error is the intended oversell rejection.
- A reconciliation failure means a balance no longer equals its movement ledger sum — inspect the
  mutation path before touching the projection.
- A concurrency timeout ("never blocked on the balance row lock") means the lock strategy changed;
  do not add fixed sleeps.
- **Windows Supabase port reservation:** if `supabase start` fails to bind `54322`
  (`An attempt was made to access a socket in a way forbidden by its access permissions`), the port
  falls inside a Windows reserved TCP range (`netsh int ipv4 show excludedportrange protocol=tcp`).
  This is a host issue affecting all Supabase-CLI suites (`test:rls`, `test:catalog:rls`,
  `test:inventory:rls`, `test:authorization:integration`); the direct-container persistence and
  concurrency suites are unaffected. CI (Linux) runs the RLS suite normally.

Never point any runner at a remote or persistent database, add production credentials, or use a broad
Docker cleanup command.

## Safe model changes

1. Read the [inventory domain](../inventory/inventory-domain.md),
   [inventory persistence](../inventory/inventory-persistence.md), the applicable ADR, and the
   [migration policy](../database/migrations.md).
2. Add a later append-only migration; never rewrite a shared or applied migration.
3. Test a valid same-tenant state and the relevant negative cases, including a real two-session race
   when concurrency is affected.
4. Add runtime RLS coverage for any new tenant table and preserve denied client writes.
5. Run all three inventory commands (persistence and concurrency twice, RLS from a clean reset),
   then the complete repository sequence.
6. Inspect `git diff`, migration fingerprints, generated OpenAPI/SDK state, credentials, and exact
   disposable-container cleanup before handoff.
