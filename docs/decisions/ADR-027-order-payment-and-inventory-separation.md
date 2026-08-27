# ADR-027: Order / Payment / Inventory Separation

- Status: Accepted
- Date: 2026-08-25

## Context

An Order is the commercial agreement; Payment is settlement; Inventory is physical stock;
Reservation/Fulfillment are separate concerns. Collapsing these into the Order table (payment status,
stock decrements at creation) is the classic ecommerce mistake that couples domains that must evolve
independently. A single order may eventually have zero, one, or many payments (split, partial, failed,
refund).

## Decision

- The Order table stores **no settlement fields**: no `payment_status`, `paid_amount`, cash/card
  amounts, method, or reference. Payment is a later domain whose records will reference `orders.id`.
- Order creation and cancellation have **zero inventory side effects**: no `InventoryService` call, no
  ledger/balance writes, and **no stock-sufficiency guarantee** (without reservations a check would be
  instantly stale and would make `placed` mean different things per channel). Physical movement happens
  later via explicit fulfillment/sale-posting through the existing `InventoryService.issueInventory`
  boundary. There is no direct Order→inventory table/function access.
- Cancellation has no payment/inventory/fulfillment/reservation side effects in Phase 2D; future
  orchestration coordinates them.
- Regression tests assert the no-inventory-side-effect invariant explicitly.

## Alternatives rejected

- **`payment_status` / denormalized payment state now:** no authoritative producer exists; premature
  and drift-prone.
- **Decrement stock at order creation / confirmation:** couples Order to Inventory, forks POS vs ONLINE
  meaning, and pre-empts the reservation and fulfillment domains.
