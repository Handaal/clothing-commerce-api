# Inventory Persistence

## Tables and ownership

| Table                  | Meaning                                     | Key ownership/integrity                                   |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `inventory_operations` | Append-only logical envelope for a mutation | Direct Tenant plus tenant-safe actor Membership FK        |
| `inventory_movements`  | Append-only signed physical quantity deltas | Tenant-safe FKs to Operation, Variant, and Location       |
| `inventory_balances`   | Current on-hand projection per stock key    | Tenant-safe FKs to Variant and Location; unique stock key |

Every table carries `tenant_id` directly and uses UUID primary keys. Operations and movements expose
`UNIQUE (tenant_id, id)` so child tables reference them tenant-safely. All foreign keys use
`ON DELETE RESTRICT`; persistence never cascades away inventory history.

The three tables are **owned by a dedicated `inventory_writer` role** (non-login, non-`BYPASSRLS`).
Because RLS is never forced, that owner bypasses RLS on exactly these three tables, which is what lets
the `SECURITY DEFINER` mutation function write while no client or server role holds direct DML. See
[Atomic mutation mechanism](#atomic-mutation-mechanism) and
[RLS and privileged writes](#rls-and-privileged-writes).

## Foreign keys (tenant integrity)

Cross-tenant stock references are structurally impossible:

- `inventory_operations.tenant_id → tenants(id)`
- `inventory_operations (tenant_id, actor_membership_id) → memberships(tenant_id, id)` (nullable)
- `inventory_movements.tenant_id → tenants(id)`
- `inventory_movements (tenant_id, operation_id) → inventory_operations(tenant_id, id)`
- `inventory_movements (tenant_id, variant_id) → product_variants(tenant_id, id)`
- `inventory_movements (tenant_id, inventory_location_id) → inventory_locations(tenant_id, id)`
- `inventory_balances (tenant_id, variant_id) → product_variants(tenant_id, id)`
- `inventory_balances (tenant_id, inventory_location_id) → inventory_locations(tenant_id, id)`

Inventory tables reference `ProductVariant` and `InventoryLocation` only. They never duplicate
`sku`, `barcode`, `product_id`, `brand_id`, `branch_id`, or `warehouse_id`; those are derivable
dimensions and duplication would drift. Physical ownership is decided solely by the location and its
existing branch/warehouse XOR parent.

## Constraints and quantity types

- `inventory_operations.operation_type` is a small controlled set:
  `opening`, `adjustment`, `correction`, `receipt`, `sale`, `return`, `transfer`. Phase 2B producers
  exercise `opening`, `adjustment`, and `correction`; `receipt`, `sale`, `return`, and `transfer`
  are reserved for later workflow domains that will validate their own semantics (for example future
  zero-sum enforcement for `transfer`).
- `idempotency_key` is optional; `normalized_idempotency_key` is `lower(btrim(...))` and must be
  non-blank when a key is supplied. When a key is present, `payload_fingerprint` (an `md5` of the
  canonical payload) must also be present; it lets a reused key detect a different payload. See the
  idempotency semantics in
  [ADR-019](../decisions/ADR-019-inventory-operation-and-idempotency-model.md).
- `occurred_at` is the business event time and `recorded_at` the system record time; both default to
  `now()`. Offline backdating policy is deferred.
- `inventory_movements.quantity_delta` is a signed `bigint` and must be non-zero.
- `inventory_movements.line_number` is a positive integer, unique within an operation, giving
  deterministic multi-movement ordering (UUIDs are not chronological).
- `inventory_balances.on_hand_quantity` is a `bigint` with a `>= 0` CHECK — the authoritative atomic
  guard against overselling. `version` is a monotonic write counter for change detection and
  diagnostics, not the locking mechanism.
- `inventory_balances` has `UNIQUE (tenant_id, variant_id, inventory_location_id)` — the physical
  stock key that also prevents duplicate rows under a first-write race.

## Indexes

- Operations: partial unique `(tenant_id, normalized_idempotency_key)` where a key exists;
  `(tenant_id, operation_type, occurred_at)`; partial `(tenant_id, actor_membership_id)`.
- Movements: `(tenant_id, variant_id, inventory_location_id, recorded_at)` for stock history;
  `(tenant_id, inventory_location_id, recorded_at)`; `(tenant_id, operation_id)`.
- Balances: the unique stock key, plus `(tenant_id, variant_id)` and
  `(tenant_id, inventory_location_id)`.

No speculative reporting or search indexes are added; reporting joins through Variant/Product later.

## Atomic mutation mechanism

`inventory_private.record_operation(p_tenant_id, p_operation_type, p_movements, p_actor_membership_id,
p_idempotency_key, p_occurred_at, p_notes)` is the **sole** path that changes stock. In one
transaction it:

1. **Validates and fingerprints (pass 1).** Checks the tenant, a non-empty `jsonb` movement array,
   and a non-blank key when supplied; validates every movement (object shape, UUID `variant_id`/
   `inventory_location_id`, non-zero `bigint` `quantity_delta`); and builds a canonical, representation-
   independent `md5` `payload_fingerprint` over the tenant, operation type, actor, and ordered lines.
2. **Applies tenant-scoped idempotency.** A used `(tenant, normalized key)` with the **same**
   fingerprint returns the original operation id and applies nothing; the **same** key with a
   **different** fingerprint raises `ID409` and mutates nothing. A concurrent first submission is
   resolved by the partial unique index — the loser re-reads the winner and either returns its id or
   raises `ID409`.
3. Inserts the operation row (with its fingerprint).
4. Enables balance writes for the remainder of the call via a transaction-local flag
   (`inventory_private.allow_balance_write`).
5. **Locks all distinct keys in canonical order (pass 2).** Collects the distinct
   `(variant, location)` balance keys and locks/creates each with `SELECT ... FOR UPDATE` (race-safe
   at zero if absent) in `variant_id`, then `inventory_location_id` order — **before** applying any
   delta — so opposing multi-key operations serialize instead of deadlocking.
6. **Applies each line in input order (pass 3).** With all rows locked, applies each movement line in
   order; on-hand may never be negative at any intermediate line (`insufficient stock`, `23514`),
   bumps `version`, and appends one immutable movement per line with its `line_number`.

Because the operation insert, every balance update, and every movement insert happen in one function
body, the ledger and its projection always commit together or not at all. The function is
`SECURITY DEFINER`, owned by the dedicated `inventory_writer` role that owns the tables, with a fixed
empty `search_path` and full schema qualification. This is the enforcement boundary: the calling
`service_role` holds **no** direct table DML, so `record_operation` is the only path that can create
ledger or balance rows (see
[ADR-017](../decisions/ADR-017-inventory-ledger-and-balance-projection.md) and
[private schema and functions](../security/tenant-rls.md)).

Locks: the per-key `FOR UPDATE` row lock serializes competing mutations of the same
`(tenant, variant, location)` while leaving independent keys concurrent; canonical key ordering keeps
multi-key operations deadlock-free.

## Append-only and direct-write enforcement (triggers)

- `inventory_private.forbid_ledger_mutation()` fires `BEFORE UPDATE OR DELETE` on
  `inventory_operations` and `inventory_movements` and always raises `42501`. Committed history
  cannot be edited or deleted; corrections are new compensating movements.
- `inventory_private.guard_balance_write()` fires `BEFORE INSERT OR UPDATE OR DELETE` on
  `inventory_balances`. It always rejects `DELETE`, and rejects `INSERT`/`UPDATE` unless the
  transaction-local flag set by `record_operation` is present. This is **defense in depth, not the
  security boundary**: it catches an accidental balance write by the writer role outside the
  function. It is not an unforgeable capability — a role that could already write the table could
  also set the flag — so the real protection is the privilege model below, under which no client or
  server role can write the table at all.

Both trigger helpers are `SECURITY INVOKER` with a fixed empty `search_path` and fully qualify every
object; `record_operation` is `SECURITY DEFINER` with the same `search_path`/qualification hardening.

## RLS and privileged writes

All three tables enable RLS (not forced). Their one authenticated policy is SELECT-only:

```text
row.tenant_id = commerce_context.current_tenant_id()
AND commerce_context.has_active_membership()
```

The enforcement boundary is a **privilege** one, not the RLS policy or the guard trigger:

- `anon` and `PUBLIC` receive no access.
- `authenticated` receives `SELECT` only — no mutation policy exists, and direct client writes are
  denied by RLS. It has no `inventory_private` usage and cannot execute the mutation path.
- `service_role` receives `SELECT` only on the three tables and `EXECUTE` only on `record_operation`.
  It holds **no** direct `INSERT/UPDATE/DELETE`, so even with `BYPASSRLS` it cannot write a movement,
  operation, or balance directly — it can only call the function. This is the F1 fix: the trusted
  server credential can no longer bypass the ledger to create divergence.
- `record_operation` runs as `inventory_writer`, which owns the tables and writes them; that role is
  non-login, non-`BYPASSRLS`, and is granted to no client or application role.

## Trust boundary and maintenance implications

The privilege model structurally prevents divergence for every ordinary client and for the
`service_role` server credential: they cannot write the inventory tables outside `record_operation`.
What remains trusted infrastructure is a **database superuser** and the `inventory_writer`/table
owner itself: a superuser can disable triggers, `SET ROLE inventory_writer`, or write directly during
governed maintenance or migration. Documentation never claims PostgreSQL prevents that — only that no
client or server-role path can. Emergency corrections should still prefer new compensating movements
over history edits so reconciliation stays exact, and no application repository should ever expose a
raw balance-mutation path.

## Migration order

Phase 2B appends after the Phase 2A catalog migrations:

1. `20260821180000_create_inventory_ledger.sql` creates the `inventory_writer` role (guarded,
   idempotent) with `USAGE` on `public`, the `inventory_private` schema, the three tables,
   constraints, indexes, the append-only and balance-guard triggers, and the `SECURITY DEFINER`
   `record_operation`; it then transfers table and function ownership to `inventory_writer`.
2. `20260821180100_enable_inventory_tenant_rls.sql` enables RLS, the authenticated SELECT policies,
   grants `authenticated`/`service_role` `SELECT` only, and grants `service_role` `EXECUTE` on
   `record_operation` (no direct table DML).

Earlier migrations are unchanged. Use a later fix-forward migration for any future change once this
phase is shared. See [Database migrations](../database/migrations.md).

## Failure behavior

- Overselling, including a negative intermediate on-hand within a multi-line operation → `23514` and
  full operation rollback; balance and ledger are unchanged.
- Zero delta, empty movement array, blank key, malformed movement, or non-integer quantity → `22023`
  (or `22P02` for an invalid UUID/`bigint` cast).
- `bigint` overflow of the running on-hand → `22003` and full rollback.
- Unknown `operation_type` → `23514` (CHECK).
- Reusing an idempotency key with a different payload → `ID409` (no mutation).
- Cross-tenant Variant, Location, Operation, or actor Membership → `23503`.
- Any direct table write by `service_role` or another client role, a direct balance write outside
  `record_operation`, any balance delete, or any ledger update/delete → `42501`.
- Duplicate movement `line_number` within an operation → `23505`.

## Adding an inventory field safely

Decide whether the value belongs to the Operation, the Movement, or the Balance, and document its
business meaning and lifecycle. Add an append-only migration carrying `tenant_id` and the composite
uniqueness any new FK needs, review `ON DELETE` behavior and RLS, and extend the persistence, RLS,
and (if concurrency-relevant) concurrency suites with accepted and rejected cases. Never add a
mutable authoritative quantity column or a direct balance-write path.
