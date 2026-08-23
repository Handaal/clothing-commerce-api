# ADR-021: Count-Based Adjustment and Stale-Count Concurrency

- Status: Accepted
- Date: 2026-08-22

## Context

Stock reconciliation is a physical count: an operator observes "there are N pieces", not "subtract 3".
Phase 2B `record_operation` applies pure signed deltas and has no expected-value guard. If the
application read on-hand, computed a delta, and submitted it, a concurrent movement between the read
and the write would apply a stale delta and corrupt the balance. Over PostgREST the application makes
one RPC per call and cannot hold a transaction across a read and a write, so application-level
optimistic concurrency is impossible without database support. `inventory_balances` already carries a
monotonic `version` column.

## Decision

- `adjustInventory` accepts an **absolute** `countedQuantity` plus the `expectedVersion` the caller
  read via `getInventoryBalance`. The application never accepts a raw signed delta.
- Add `inventory_private.record_count_adjustment(...)`, a hardened `SECURITY DEFINER` function that,
  under the balance-row lock: reads the current on-hand and version; if the version differs from
  `expectedVersion` raises `IN002`; otherwise derives `delta = counted - current`, and either records
  an `adjustment` operation **plus** a movement (delta ≠ 0) or records an `adjustment` operation
  **with no movement** (delta = 0). Either way one `InventoryOperation` is persisted.
- A **durable no-op** (delta = 0) persists the operation envelope but writes no movement and leaves the
  balance and version unchanged. `InventoryOperation` is the command/audit envelope; `InventoryMovement`
  is the physical-quantity source of truth, so "the count already matched" is a real recorded event
  with no physical change. This is what makes the no-op **idempotent**: its key is durably consumed, so
  a same-key/same-payload retry replays and a same-key/different-payload reuse raises `ID409`. (Earlier
  in Phase 2C a no-op recorded nothing, which left its key unconsumed and broke the idempotency
  contract; persisting the envelope fixes that.)
- Optimistic concurrency compares the **version**, not on-hand, so two offsetting concurrent movements
  (ABA) that return on-hand to the value the operator saw still correctly fail.
- Idempotency identity is the caller inputs (`counted`, `expectedVersion`), not the derived delta, so
  a post-success retry with the same key replays instead of failing the now-advanced version check.
  The idempotency lookup deliberately precedes the version comparison, so a persisted no-op still
  replays even after a later movement advanced the version (never `IN002`). Reuse with a different
  payload raises `ID409`.
- The repository maps `IN002` → `CONCURRENT_MODIFICATION`. A no-op returns a real `operationId` with
  `{ changed: false }` and `previousOnHand === newOnHand`; only a changed count returns `changed: true`.

## Alternatives rejected

- **Application reads then submits a delta:** race-prone; cannot be made atomic over PostgREST.
- **Set on-hand to the count unconditionally under the lock:** clobbers a concurrent movement taken
  after the operator's count; the operator's stale observation would silently win.
- **Compare expected on-hand instead of version:** vulnerable to ABA; version is monotonic and exact.
- **Extend `record_operation` with optional expected-version parameters:** bloats and destabilizes the
  audited core function; a narrow, intent-specific function is clearer and localizes the new signal.

## Consequences

Counts express business truth and can never apply a stale delta; a conflicting count fails closed with
`CONCURRENT_MODIFICATION`, and the client re-reads and re-counts. A no-op is a durable, idempotent
observation (one operation, no movement) rather than a silent nothing, so retries and key reuse behave
exactly like a changed count. The persistence suite proves the durable no-op, its replay, a
different-payload conflict, a post-mutation replay, and an ABA count; the concurrency suite proves a
blocked stale count is rejected and a refreshed retry succeeds.
