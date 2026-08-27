# Order Lifecycle

## States

```
placed ──▶ cancelled
```

- **`placed`** — the only creation state. The commercial snapshot exists and is immutable; pricing,
  lines, and currency are frozen at this instant. Financially meaningful.
- **`cancelled`** — terminal. Terminated before any downstream settlement/fulfillment.

There is **no** `draft`, `confirmed`, or `completed`. Draft/cart is out of scope (an Order is never a
mutable basket). `confirmed`/`completed` cannot be objectively defined without the Payment and
Fulfillment domains and are deferred; adding them later is additive. One lifecycle serves both
channels — POS "place-and-done" and ONLINE both use `placed`; there are no channel-specific statuses.

## Immutability and corrections

At `placed`, `order_lines` and the order's financial/provenance/idempotency fields are immutable. The
only permitted post-placement change is the `placed → cancelled` transition, which writes the
cancellation metadata and `updated_at`. There is no `updateOrder` and no add/replace-line command.
Corrections are never edits to financial history; a future correction is expressed as cancellation plus
a new replacement order.

## Cancellation

`cancelOrder` authorizes `orders.cancel` against the order's persisted resource (POS: `branch_id`;
ONLINE: `brand_id`), then calls `orders_private.cancel_order`, which performs an atomic
compare-and-transition `UPDATE … WHERE status='placed'` writing `cancelled_at`,
`cancelled_by_membership_id` (derived from the context, never caller input), and `cancellation_reason`
exactly once.

Cancellation is **state-idempotent and write-once**: re-cancelling an already-cancelled order returns
the preserved original metadata and never overwrites `cancelled_at`, `cancelled_by_membership_id`, or
`cancellation_reason`, even if the retry supplies a different reason. Concurrency is safe — the guarded
transition ensures two racers cannot both write cancellation metadata.

Phase 2D cancellation has **no** side effects: it does not refund payment, restore stock, cancel a
fulfillment, or release a reservation, because those domains do not yet exist. Future orchestration
will coordinate them. Cancellation is never a delete; orders are retained.
