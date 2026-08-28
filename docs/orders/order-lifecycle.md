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

Since Phase 2E, `cancel_order` also acquires the shared **order-execution advisory lock**
(`commerce_locks.acquire_order_execution_lock(tenant, order)`, the same key `record_fulfillment` uses)
and, under that lock, rejects cancellation with `ORDER_ALREADY_FULFILLED` if **any** Fulfillment exists
for the order — before the `placed → cancelled` transition. The shared lock makes the state “cancelled
Order + Fulfillment” impossible: either a Fulfillment commits first (and a later cancel fails
`ORDER_ALREADY_FULFILLED`) or the cancel commits first (and a later fulfillment sees the cancelled order
and fails `ORDER_CANCELLED`, issuing nothing). The write-once semantics are unchanged: an already-
cancelled order has no Fulfillment, so the guard never blocks a re-cancel replay. See
[Fulfillment authorization](../fulfillment/fulfillment-authorization.md) and ADR-033.

Cancellation itself still has **no** settlement side effects: it does not refund payment, restore stock,
or release a reservation, because those domains do not yet exist. A fulfilled order can no longer be
cancelled at all (above). Cancellation is never a delete; orders are retained.
