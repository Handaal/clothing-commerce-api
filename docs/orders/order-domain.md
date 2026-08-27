# Order Domain

## Purpose

Phase 2D establishes the canonical **Order / Sales** domain shared by the POS and ONLINE channels. It
is the commercial record of a sale: what was bought, at what server-authorized price, by which channel
and actor. It deliberately implements none of the downstream domains it will later feed.

> **CONFIRMED INVARIANT:** The Order aggregate is the sales record. There is **no** separate `Sale`
> entity. `channel` + lifecycle describe a single canonical model.

```
POS                           ONLINE
 |                              |
 +-------------+----------------+
               v
          Order domain
     Order / OrderLine · pricing snapshots · lifecycle
     channel · brand · (branch/register for POS) · totals
               |
        future workflows (documented seams, NOT built here)
       /       |        \
 inventory   payments   returns
```

## What an Order is (and is not)

- **Order = commercial agreement / sale record.** One Tenant, one Brand, one currency, one or more
  immutable `OrderLine`s, created directly as `placed`.
- **Order != Cart.** There is no draft/cart state; a cart is mutable shopping intent owned by a client
  or a later phase. An Order exists only once submitted.
- **Order != Payment.** No settlement fields exist on the Order (no `payment_status`, `paid_amount`,
  method, or reference). Payment is a later domain; a single Order may eventually have zero, one, or
  many payments.
- **Order != Fulfillment / Inventory.** Creating an Order moves no stock and makes no stock-sufficiency
  guarantee. `branch_id` is the **commercial/operational origin**, never a physical fulfillment
  location (there is intentionally no `inventory_location_id`).
- **Order != Reservation.** No `reserved`/`allocated`/`available_to_sell` concept is introduced.
- **Order != Tax invoice.** `order_number` is an operational identifier, not a fiscal/tax invoice
  number and not guaranteed gapless.

## Core invariants

- **Single tenant** — every `orders`/`order_lines` row carries a direct `tenant_id` and tenant-safe
  composite FKs.
- **Single brand** — enforced declaratively (no trigger): a line's `(tenant_id, order_id, brand_id)`
  references the order, and `(tenant_id, brand_id, product_id)` references `products`, so every line's
  variant must belong to the order's brand.
- **Single currency** — one `currency` on the order; all line prices are resolved in it. No multi-
  currency lines, no FX.
- **Immutable commercial snapshot** — `unit_price_minor`, `line_total_minor`, and the product/variant
  name, SKU, and option-summary snapshots are frozen at placement and survive later catalog edits or
  archival (all catalog FKs are `ON DELETE RESTRICT`).
- **No side effects** — Order creation and cancellation never touch inventory or payments.

## Channels

`channel ∈ {pos, online}` answers only "where was this order initiated." POS orders carry a
`branch_id` (server-resolved from the register) and a `register_id`; ONLINE orders carry neither. The
schema leaves room for future channels via an additive CHECK change; `admin`/`marketplace`/`wholesale`
are not implemented.

## Actor

`actor_membership_id` is the staff Membership that created the order, derived from the verified
authorization context (never from caller input). It is `NULL` for system/ONLINE origin. Customer
identity is a **separate future domain**; ONLINE customer order creation will use a dedicated public
orchestration layer and is not implemented in Phase 2D.

## Future integration seams (documented, not built)

| Future domain                 | References                                                                | Phase 2D preparation                       |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| Payment                       | `orders.id` (many payments → one order)                                   | stable order id; orders never hard-deleted |
| Returns                       | `orders.id`, `order_lines.id`                                             | stable immutable line ids                  |
| Fulfillment / Inventory issue | `orders.id`, `order_lines.id`; issues via the existing `InventoryService` | location intentionally kept off the order  |

See [order-persistence](order-persistence.md), [order-lifecycle](order-lifecycle.md), and
[order-authorization](order-authorization.md).
