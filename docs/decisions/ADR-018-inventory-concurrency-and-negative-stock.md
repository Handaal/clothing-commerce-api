# ADR-018: Inventory Concurrency and Negative-Stock Policy

- Status: Accepted
- Date: 2026-08-21

## Context

Shared POS and storefront inventory means the same `Variant + InventoryLocation` can be mutated
concurrently. Two transactions must never oversell or lose an update, and the platform must take an
explicit position on negative stock rather than letting behavior emerge by accident. Clothing stock
is counted in discrete pieces.

## Decision

- **Quantity types:** movement `quantity_delta` is a signed `bigint` and must be non-zero; balance
  `on_hand_quantity` is a non-negative `bigint`. No floating-point or fractional quantities. A
  future unit-of-measure change would be a deliberate schema change.
- **Negative stock:** server-authoritative operations can never reduce on-hand below zero. A
  movement that would do so is rejected atomically and the whole operation rolls back. The
  `on_hand_quantity >= 0` CHECK is the authoritative backstop; the mutation function pre-checks and
  raises a clear `insufficient stock` error.
- **Concurrency:** the mutation function locks each balance row with `SELECT ... FOR UPDATE` before
  applying a delta, creating the row race-safely at zero if absent. Competing mutations of one key
  serialize, so exactly one of two final-unit deductions succeeds; independent keys stay concurrent.
  The `(tenant, variant, location)` unique constraint prevents duplicate balance rows under a
  first-write race. Application read-then-write is never relied upon.
- **Canonical multi-key lock ordering:** an operation may touch several keys (a transfer, a
  multi-line sale). The function first collects the _distinct_ balance keys and locks/creates them in
  one canonical order — `variant_id`, then `inventory_location_id` — **before** applying any delta.
  Because every operation acquires the same keys in the same order, two operations touching the same
  set in opposite payload order cannot form a lock cycle, so multi-key operations serialize instead
  of deadlocking (SQLSTATE `40P01`). Payload-order locking (the original design) could deadlock and
  was rejected.
- **Intermediate-negative rule:** after all needed keys are locked, movement lines are applied in
  input order, and on-hand may never be negative at _any_ intermediate line — even when the net would
  be non-negative. This is deliberately conservative for audit safety; each line is a real physical
  event. Movement order is therefore semantically significant. Each input line remains its own
  immutable movement row.
- **Zero movements** are rejected as meaningless ledger noise. `bigint` overflow in the running total
  is rejected (`22003`) and rolls the whole operation back.

## Alternatives rejected

- **Allow negative stock by default:** risks accidental overselling across shared channels and
  complicates reconciliation; clothing retail needs strict physical integrity.
- **Optimistic version check only:** a bare `version` compare without row locking still races the
  first-row creation and complicates retry semantics. `version` is kept only as a diagnostic
  monotonic counter.
- **Advisory locks per key:** heavier and less precise than the natural row lock on the balance
  projection.
- **Payload-order locking:** simpler but lets two opposing multi-key operations deadlock; canonical
  key ordering removes the cycle without a retry loop.
- **Floating-point or implicit fractional units:** wrong for discrete garments and unsafe for exact
  counts.

## Consequences

Overselling is impossible on the server path, and concurrent stock changes are correct without lost
updates. `scripts/test-inventory-concurrency.mjs` proves the oversell race, the first-balance
creation race, non-serialization of independent keys, and — critically — that opposing multi-key
operations serialize without a `40P01` deadlock, including the case where both keys' balance rows are
absent and must be created under the unique index, all with real two-session tests. Bounded offline-POS
exceptions and reconciliation remain a separate, explicit future offline-sync decision and are not
implemented now.
