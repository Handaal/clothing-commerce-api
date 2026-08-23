# Inventory Domain

## Purpose

Phase 2B establishes the inventory engine foundation that every future stock-affecting workflow —
POS sales, ecommerce sales, receiving, purchasing, returns, stock adjustments, transfers, and
reporting — depends on. This phase builds the durable identity, ledger, projection, and mutation
mechanism only. It intentionally implements none of those business workflows.

## Frozen inventory identity

> **CONFIRMED INVARIANT:** Authoritative inventory is keyed by `ProductVariant + InventoryLocation`.

Inventory does not belong to a Product, a Branch, a Warehouse, a Register, a Storefront, or a
SalesChannel. `InventoryLocation` is the smallest physical stock owner (see
[inventory-location-model](../architecture/inventory-location-model.md)); it already belongs to
exactly one Branch or one Warehouse. A Variant may exist in many locations; a location may hold many
variants; multiple Registers may sell from the same location, but no stock belongs to a Register.

## Source of truth versus projection

The domain separates history from current state:

```
InventoryOperation  (logical audit/idempotency envelope)
        |
        v
InventoryMovement   (append-only signed quantity deltas  =  source of truth)
        |
        v
InventoryBalance    (maintained current on-hand projection, one row per stock key)
```

- **InventoryOperation** records one logical stock mutation: its type, business time, recording
  time, optional actor Membership, optional tenant-scoped idempotency key, and optional notes. One
  operation can span several movements (a future transfer is one operation with a `-N` and a `+N`
  movement; a future multi-line sale is one operation deducting several variants).
- **InventoryMovement** is the authoritative, append-only ledger. A positive delta means stock
  enters the location; a negative delta means stock leaves it. History is never edited: corrections
  are new compensating movements.
- **InventoryBalance** is a fast projection of current on-hand quantity per
  `(tenant, variant, location)`. It is derived state, never an independent truth. For any key,
  `on_hand_quantity` always equals the sum of that key's movement deltas.

This separation buys auditability, deterministic reconciliation, historical reporting, and clean
future extension to receiving, sales deductions, returns, transfers, and adjustments.

## Why a ledger, not a mutable quantity

A freely mutable `inventory.quantity` column cannot answer "how did we get here", cannot be
reconciled, and invites silent overwrites. An append-only ledger with a maintained projection keeps
the audit trail while still serving fast current-state reads. See
[ADR-017](../decisions/ADR-017-inventory-ledger-and-balance-projection.md).

## Quantity semantics

Clothing stock is discrete pieces, so quantities are integers:

- Movement `quantity_delta` is a signed `bigint`; it must be non-zero (a zero movement is
  meaningless ledger noise and is rejected).
- Balance `on_hand_quantity` is a non-negative `bigint`.

Fractional units are unnecessary now. Introducing a unit of measure would be a deliberate future
schema change, not an implicit float. See
[ADR-018](../decisions/ADR-018-inventory-concurrency-and-negative-stock.md).

## Negative stock policy

> **Phase 2B decision:** server-authoritative operations can never reduce on-hand below zero.

A movement that would drive a balance negative is rejected atomically, so the whole operation rolls
back. Strict physical integrity suits clothing retail and shared POS/storefront inventory and
prevents overselling at the persistence layer. Bounded offline-POS exceptions and reconciliation are
a later, explicit offline-sync decision and are not implemented now.

## Mutation boundary (who can write stock)

Inventory is written through exactly one database path: the `SECURITY DEFINER` function
`inventory_private.record_operation`, owned by a dedicated `inventory_writer` role that owns the
inventory tables. The trusted server credential (`service_role`) is granted `SELECT` on the tables
and `EXECUTE` on that function only — it holds **no** direct `INSERT/UPDATE/DELETE`, so it cannot
bypass the ledger to create balance/movement divergence. Ordinary `authenticated`/`anon` clients can
neither write the tables nor execute the function. Append-only triggers and a balance-write guard
remain as internal defense-in-depth, but the enforcement boundary is this privilege model, not the
triggers (a guard flag is not an unforgeable capability). Only a database superuser or the table owner
— trusted infrastructure — can bypass it during governed maintenance. See
[ADR-017](../decisions/ADR-017-inventory-ledger-and-balance-projection.md) and
[inventory persistence](inventory-persistence.md).

## Concurrency

Two simultaneous mutations of the same `Variant + InventoryLocation` must never oversell or lose an
update. The mutation path locks the balance row (`SELECT ... FOR UPDATE`, creating it race-safely if
absent) before applying a delta, so concurrent mutations of one key serialize and exactly one of two
competing final-unit deductions succeeds. Independent keys do not serialize. The
`(tenant, variant, location)` unique constraint prevents duplicate balance rows under a first-write
race.

An operation that touches several keys (a future transfer or multi-line sale) locks **all** distinct
`(variant, location)` keys in one canonical order (`variant_id`, then `inventory_location_id`) before
applying any delta, so two operations touching the same keys in opposite payload order serialize
rather than deadlock. Within an operation, movement lines apply in input order and on-hand may never
be negative at any intermediate line — even when the net would be non-negative — so movement order is
meaningful. `scripts/test-inventory-concurrency.mjs` is the two-session regression, including the
opposing multi-key no-deadlock case. See
[ADR-018](../decisions/ADR-018-inventory-concurrency-and-negative-stock.md).

## Idempotency

Sync retries and future integrations may resubmit the same logical operation. An operation may carry
a tenant-scoped `idempotency_key`, paired with a stored `payload_fingerprint` (a canonical digest of
tenant, type, actor, and ordered movement lines). Re-submitting a used `(tenant, key)` with the
**same** fingerprint returns the original operation and applies nothing, so retries cannot
double-adjust stock. Re-submitting the same key with a **different** payload is a deterministic error
(SQLSTATE `ID409`) that mutates nothing — never a silent success — so a caller that changed the
payload learns its second request did not run. The same key is independent across tenants, and a
failed operation rolls back so its key stays reusable. This is foundation-level idempotency at the
ledger; it is not HTTP middleware, and a future HTTP layer must preserve the payload for a given key.
See [ADR-019](../decisions/ADR-019-inventory-operation-and-idempotency-model.md).

## Actor and audit

An operation optionally references the acting Membership (tenant-safe). A null actor means a
system-origin operation — future online checkout, reconciliation, sync, or integrations. Movements
inherit their actor and business time from their operation; identity is always a structured foreign
key, never free text.

## Reserved operation types

`operation_type` is a small controlled set — `opening`, `adjustment`, `correction`, `receipt`,
`sale`, `return`, `transfer` — but it is only a **reserved audit classification**. Phase 2B producers
use `opening`, `adjustment`, and `correction`. `receipt`, `sale`, `return`, and `transfer` carry no
enforced business semantics yet: there is no sale/order linkage, no receiving workflow, no
return/refund linkage, and no transfer zero-sum validation. Those belong to future domain services.
A `transfer`-typed operation today is simply two or more movements sharing one operation id; the
database does not require it to net to zero.

## Metadata visibility

The authenticated SELECT policy exposes whole operation rows — including `idempotency_key`, `notes`,
and `actor_membership_id` — to every active member of the tenant. This is acceptable for the
foundation, but `idempotency_key` and `notes` are internal operational metadata, not public fields:
they may later encode integration/request identifiers or operator commentary. A future operation-level
authorization layer and any public API shaping must decide what is exposed and must not treat these as
guaranteed client-visible fields. This is an authorization-layer concern, not a tenant-isolation
defect — cross-tenant reads remain impossible.

## Lifecycle boundaries

- Inventory history and balances survive Variant archival; archiving a Variant never cascades away
  stock. Whether new commercial stock operations may target an archived Variant is a future
  application authorization rule, not a database deletion.
- An archived or deactivated InventoryLocation keeps its history and balance. A future deactivation
  workflow will require zero-stock reconciliation or explicit transfer before archive; that workflow
  is deferred.

## Reservations, costing, and lots (deferred)

- This phase represents `on_hand` only. The future formula `available_to_sell = on_hand - active
reservations` is documented but no reservation table exists yet.
- No costing (FIFO, weighted average, cost layers, COGS) and no monetary columns on movements; the
  purchasing/accounting phase defines costing.
- No lot, serial, or expiry tracking; clothing does not require it now.

## Explicitly out of scope for Phase 2B

Orders, order-line deduction, checkout, carts, reservations, purchasing, supplier receipts, returns
and refunds, POS register-session deduction, ecommerce allocation, transfer business workflow/UI,
stock-count UI, costing, customer auth, storefront/POS API/UI, reporting dashboards, and offline POS
sync. This phase is the engine foundation only.

## Phase 2C application boundary

Phase 2C adds the inventory application service that lets the rest of the system express stock intent
without touching this ledger. It introduces the `issue` operation type (a generic physical exit) and
two hardened functions — `inventory_private.record_opening` (one-time initialization) and
`inventory_private.record_count_adjustment` (absolute count with optimistic version concurrency) —
alongside `record_operation`. The raw ledger and its functions remain infrastructure; future business
domains call the application commands, never the ledger. See
[inventory operations](inventory-operations.md) and
[inventory authorization](inventory-authorization.md).

## Related documents

- [Inventory persistence](inventory-persistence.md) — tables, constraints, functions, RLS, order.
- [Inventory operations](inventory-operations.md) — the Phase 2C commands, results, and errors.
- [Inventory authorization](inventory-authorization.md) — permissions, scopes, and the privilege boundary.
- [Inventory testing](../development/inventory-testing.md) — the suites and how to run them.
- [ADR-017](../decisions/ADR-017-inventory-ledger-and-balance-projection.md),
  [ADR-018](../decisions/ADR-018-inventory-concurrency-and-negative-stock.md),
  [ADR-019](../decisions/ADR-019-inventory-operation-and-idempotency-model.md).
