# ADR-025: Order Lifecycle and Immutability

- Status: Accepted
- Date: 2026-08-25

## Context

A sales order needs a lifecycle, but over-modelling it (draft, confirmed, completed, …) before the
Payment and Fulfillment domains exist would bake in states with no objective meaning, and a persistent
`draft` would drift into a Cart, merging two concepts the platform keeps distinct.

## Decision

- The lifecycle is exactly **`placed → cancelled`**. An Order is created directly as `placed`;
  `cancelled` is terminal.
- **No `draft`/cart, no `confirmed`, no `completed`.** Draft/cart is a client/other-phase concern.
  `confirmed`/`completed` cannot be objectively defined without Payment/Fulfillment and are deferred
  (additive later). One lifecycle serves both channels; there are no channel-specific statuses.
- At `placed`, `order_lines` and the order's financial/provenance/idempotency fields are **immutable**.
  The only permitted change is the `placed → cancelled` transition. There is no `updateOrder` and no
  add/replace-line command. Corrections are cancellation + a new replacement order, never edits to
  financial history.
- Immutability is enforced by append-only triggers (order_lines reject UPDATE/DELETE; orders reject
  DELETE and reject UPDATE outside the sanctioned cancel path) as defense-in-depth behind the
  `orders_writer` + function-grant privilege boundary. Orders are never hard-deleted.

## Alternatives rejected

- **placed/confirmed/completed/cancelled now:** proliferates undefined states; challenged and reduced.
- **Persistent draft orders:** would merge Cart and Order and force mutable financial history.
- **Editable placed orders:** auditless mutation of financial snapshots; replaced by cancel + replace.
