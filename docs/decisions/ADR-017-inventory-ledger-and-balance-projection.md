# ADR-017: Inventory Ledger and Balance Projection

- Status: Accepted
- Date: 2026-08-21

## Context

Every future stock workflow (POS and ecommerce sales, receiving, purchasing, returns, adjustments,
transfers, reporting) needs an authoritative, auditable inventory model. A single mutable
`inventory.quantity` column cannot explain how a balance was reached, cannot be reconciled, and
invites silent overwrites. Inventory identity is frozen as `ProductVariant + InventoryLocation`.

## Decision

- Model inventory as three tables: `inventory_operations` (a logical audit/idempotency envelope),
  `inventory_movements` (append-only signed quantity deltas, the source of truth), and
  `inventory_balances` (a maintained current on-hand projection, one row per
  `(tenant, variant, location)`).
- A positive movement enters a location; a negative movement leaves it. Committed operations and
  movements are append-only: `BEFORE UPDATE OR DELETE` triggers reject edits and deletes.
  Corrections are new compensating movements.
- `inventory_balances.on_hand_quantity` always equals the sum of its key's movement deltas. The
  projection is derived state, never an independent truth.
- The projection and the ledger change only through `inventory_private.record_operation`, which
  appends the operation and its movements and updates balances in one transaction.
- **Privilege boundary (the real enforcement).** `record_operation` is a hardened `SECURITY DEFINER`
  function owned by a dedicated, non-login, non-`BYPASSRLS` role `inventory_writer` that owns the
  three inventory tables. `service_role` — the trusted server credential — is granted `SELECT` only
  on those tables and `EXECUTE` only on `record_operation`; it holds **no** direct
  `INSERT/UPDATE/DELETE`. Therefore ordinary server code cannot insert a movement or edit a balance
  outside the function, and cannot create ledger/balance divergence. `authenticated`/`anon` have no
  schema usage, no execute, and no write path.
- **Defense in depth (not the boundary).** The append-only `BEFORE UPDATE OR DELETE` triggers and the
  `inventory_balances` write guard (a transaction-local flag the function sets, checked by a `BEFORE`
  trigger) remain, but they are internal safety nets, not the security boundary: a role that already
  holds table DML could also set the flag, so the flag is not an unforgeable capability. The
  boundary is the privilege model above.
- The two trigger helpers are `SECURITY INVOKER`; `record_operation` is `SECURITY DEFINER`. All three
  have a fixed empty `search_path`, are fully schema-qualified, and live in the private
  `inventory_private` schema that only `service_role` may use.
- Inventory tables reference Variant and Location only and never duplicate catalog or
  branch/warehouse dimensions.

## Alternatives rejected

- **Mutable authoritative quantity column:** no audit trail, no reconciliation, unsafe overwrites.
- **Ledger with no projection:** every read aggregates full history; poor current-state performance.
- **`SECURITY INVOKER` mutation function with `service_role` table DML (the original Phase 2B
  design):** rejected after review. Because `SECURITY INVOKER` runs with the caller's privileges,
  the caller (`service_role`) needed direct table DML, which meant it could bypass the function and
  insert a movement without updating the balance, or set the guard flag and write a balance
  directly — divergence through intended privileges. The `SECURITY DEFINER` + dedicated-owner model
  removes that direct DML while still letting the function write, closing the bypass.
- **Balance maintained only in application repositories:** cannot guarantee the ledger/projection
  invariant regardless of caller; a database function makes it structural.

## Consequences

Stock is auditable and deterministically reconcilable, and future receiving/sales/returns/transfers
extend from stable keys. Divergence is now structurally prevented for the trusted server role: it can
only call `record_operation`. A database superuser or the `inventory_writer`/table owner remains
trusted infrastructure and can still disable triggers or write directly during governed maintenance;
documentation never claims PostgreSQL prevents that, only that no ordinary client or server-role path
can. Reads of current stock stay a single-row projection lookup; historical and reporting reads
aggregate the ledger.
