# ADR-030: Canonical Fulfillment Domain

- Status: Accepted
- Date: 2026-08-28

## Context

POS and online orders must be physically executed by issuing stock. Phase 2E introduces that execution
record without drifting into reservations, allocation, shipping, tracking, returns, or payments — all of
which remain deliberately out of scope. The record must be auditable, immutable, and tenant-isolated,
and it must never become a second source of truth for order or inventory state.

## Decision

- **Frozen definition.** A **Fulfillment** is the immutable physical execution of some or all
  `OrderLine` quantities from **exactly one** `InventoryLocation`. It is not an Order, Payment,
  Reservation, Allocation, Shipping, or Return.
- **Cardinality.** `Order 1 → 0..N Fulfillments`. Each Fulfillment has exactly one Order, exactly one
  InventoryLocation, one or more `FulfillmentLines`, and exactly one `InventoryOperation`. An `OrderLine`
  may appear across multiple Fulfillments (partial / multi-location), and the total fulfilled quantity
  may never exceed `OrderLine.quantity`.
- **No status column.** `public.fulfillments` has no `status`, no `updated_at`, no `cancelled_at`. A row
  existing **means** the physical execution occurred (the inventory issue committed in the same
  transaction). There is no draft, pending, cancellation, or mutation.
- **Two persistence tables only.** `public.fulfillments` and `public.fulfillment_lines`. No status,
  event, history, projection, or reservation tables.
- **Declarative single-order + variant integrity.** Composite tenant-safe foreign keys bind each
  `FulfillmentLine` to its Fulfillment's Order and to an `OrderLine` of that same Order, and force
  `fulfillment_line.variant_id = order_line.variant_id`. The server derives the variant from the
  immutable OrderLine; a caller can never supply or spoof it. All meaningful deletes are `RESTRICT`; no
  history-erasing `CASCADE`.
- **Progress is derived, never projected.** `unfulfilled` / `partially_fulfilled` / `fulfilled` is
  computed from `FulfillmentLines` on read. Phase 2E writes no `Order.fulfillment_status`,
  `Order.fulfilled_quantity`, or `OrderLine.fulfilled_quantity`.
- **Variant lifecycle independence.** An already-placed `OrderLine` remains fulfillable after its
  Product/Variant is archived; catalog sellability rules are not re-run because the Order was already
  commercially placed.

## Consequences

- The Fulfillment record is small, immutable, and unambiguous: its existence is the event.
- Order and inventory remain the sole sources of truth for their own state; fulfillment never mirrors
  them.
- Reservations/allocation/shipping can be layered later without reshaping this record.

## References

- `docs/fulfillment/fulfillment-domain.md`, `docs/fulfillment/fulfillment-persistence.md`
- Related: [[ADR-024-canonical-order-and-channel-model]], [[ADR-025-order-lifecycle-and-immutability]],
  [[ADR-017-inventory-ledger-and-balance-projection]]
