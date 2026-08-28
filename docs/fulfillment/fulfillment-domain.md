# Fulfillment domain

## Purpose

Phase 2E introduces the **Fulfillment**: the immutable physical execution of some or all `OrderLine`
quantities from exactly one `InventoryLocation`. This document is the canonical description of what a
Fulfillment is and is not, the application surface, and how progress is derived.

## What a Fulfillment is (and is not)

A Fulfillment is the record that stock was physically issued against an order.

- Fulfillment **≠** Order — an Order is the commercial sale; a Fulfillment is one physical execution of
  it.
- Fulfillment **≠** Inventory — inventory is the authoritative stock ledger; a Fulfillment references
  exactly one `InventoryOperation` in it.
- Fulfillment **≠** Reservation, Allocation, Shipping, Return, or Payment — none of these exist in
  Phase 2E.

Invariants:

- one Fulfillment = one Order, one InventoryLocation, one InventoryOperation, one or more
  FulfillmentLines;
- `Order 1 → 0..N Fulfillments`; an `OrderLine` may appear across multiple Fulfillments (partial /
  multi-location);
- total fulfilled quantity per OrderLine may never exceed `OrderLine.quantity`;
- **no status column** — a `fulfillments` row existing means the physical execution happened. There is
  no draft, pending, cancellation, or mutation.

## Application surface

`src/fulfillments` exposes a single application service, `FulfillmentService`, with four commands and no
update/cancel/delete/search:

| Command                      | Authority                                  | Notes                                                             |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `createFulfillment`          | `orders.fulfill` **and** `inventory.issue` | Two-authority; see [authorization](fulfillment-authorization.md). |
| `getFulfillment`             | `orders.read`                              | Against the Order's commercial resource.                          |
| `getOrderFulfillments`       | `orders.read`                              | All Fulfillments of one Order.                                    |
| `getOrderFulfillmentSummary` | `orders.read`                              | Derived per-line progress.                                        |

Strict Zod input for `createFulfillment` accepts only `{ orderId, inventoryLocationId, lines:
[{ orderLineId, quantity }], idempotencyKey }`. It rejects empty lines, non-positive/non-safe-integer
quantities, non-UUIDs, a blank idempotency key, and a duplicate `orderLineId` within one request. It
accepts **no** tenantId, variantId, branchId, brandId, channel, actorMembershipId, inventory delta,
operation type, status, price, totals, or fulfilled-quantity snapshot. Every authoritative value is
server-derived: the variant of each line comes from the immutable OrderLine, the actor from the verified
context, and timestamps from the database.

## Fulfillment progress (derived, never projected)

Progress is computed from `FulfillmentLines` on read, never persisted. Phase 2E writes no
`Order.fulfillment_status`, `Order.fulfilled_quantity`, or `OrderLine.fulfilled_quantity`.
`getOrderFulfillmentSummary` returns per-line `orderedQuantity`, `fulfilledQuantity`, and one of
`unfulfilled` / `partially_fulfilled` / `fulfilled`, plus the order-level roll-up and the contributing
fulfillment ids.

## Variant lifecycle

An already-placed `OrderLine` remains fulfillable after its Product/Variant is archived. The Order was
already commercially placed; catalog sellability rules are not re-run. The variant identity comes from
the immutable OrderLine linkage, enforced by composite foreign keys (see
[persistence](fulfillment-persistence.md)).

## Responsible files

- `src/fulfillments/model.ts`, `errors.ts`, `execution-proof.ts`, `repository.ts`,
  `supabase-fulfillment-repository.ts`, `fulfillment-service.ts`, `index.ts`
- Migrations `supabase/migrations/20260828180000_*` … `20260828180600_*`
- Tests: `tests/fulfillments/**`, `tests/fulfillments-integration/**`,
  `supabase/tests/phase_2e_fulfillment*.sql`, `scripts/test-fulfillment-*.mjs`

## Related documents

- [Fulfillment persistence](fulfillment-persistence.md)
- [Fulfillment authorization](fulfillment-authorization.md)
- [Fulfillment ↔ inventory integration](fulfillment-inventory-integration.md)
- ADR-030…ADR-033
