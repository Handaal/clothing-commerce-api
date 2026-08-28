# ADR-032: Fulfillment Idempotency, Immutability, and Concurrency

- Status: Accepted
- Date: 2026-08-28

## Context

Fulfillment creation is a critical mutation issued from retrying clients and must be idempotent, and it
must serialize correctly against other fulfillments of the same order (over-fulfillment) and against
order cancellation. It must never over-issue, double-issue, or leave a partial write.

## Decision

- **Canonical client-intent fingerprint.** `fulfillments_private.fulfillment_intent_fingerprint` hashes
  only tenant, order, location, and the ordered `(order_line_id, quantity)` lines (line order is part of
  intent). It excludes actor, timestamps, the derived variant, and inventory detail. One SQL definition
  is shared by the replay preflight and `record_fulfillment` so they never drift.
- **Authoritative idempotency.** `record_fulfillment` enforces a unique `(tenant,
normalized_idempotency_key)`: same key + matching intent replays the original ids and issues nothing
  further; same key + different intent is `ID409` (`IDEMPOTENCY_CONFLICT`). The narrow
  `resolve_fulfillment_replay_target` preflight returns only routing identifiers, and only on a matching
  fingerprint, so it never leaks quantities, movement detail, or cross-tenant existence.
- **Shared order-execution lock.** Both `record_fulfillment` and `orders_private.cancel_order` acquire
  the same transaction-scoped advisory lock, `commerce_locks.acquire_order_execution_lock(tenant,
order)`, built from one shared definition so the key cannot drift. This serializes all fulfillments of
  an order with each other and with cancellation.
- **Over-fulfillment without an OrderLine lock.** Under the order-execution lock, `record_fulfillment`
  sums committed `fulfillment_lines.quantity` per requested OrderLine and requires
  `requested <= ordered - existing`. Because every line of a request belongs to exactly one Order,
  same-order serialization is sufficient; no per-OrderLine advisory lock is used.
- **Global lock order.** (1) order-execution advisory lock, (2) InventoryLocation lifecycle advisory
  lock, (3) inventory balance row locks inside `record_operation`. No path requests a lower-level lock
  while holding a higher-level one, so no lock cycle forms across cancel, same-order fulfillments,
  different-order same-location fulfillments, generic issue, or transfer.
- **Immutability.** `fulfillments` and `fulfillment_lines` are fully immutable: append-only triggers
  reject `UPDATE`/`DELETE` unconditionally (there is no sanctioned update path, so no GUC flag is
  needed), backed by the privilege model (`service_role` has no DML). No line is appended after creation.

## Consequences

- A same-key retry is safe; a different-intent reuse is a deterministic conflict.
- Two concurrent fulfillments of one order cannot exceed the ordered quantity; a race loser is
  `OVER_FULFILLMENT` and its inventory issue is rolled back.
- A committed Fulfillment can never be edited or deleted through the application.

## References

- `docs/fulfillment/fulfillment-persistence.md`, `docs/fulfillment/fulfillment-inventory-integration.md`
- Related: [[ADR-028-order-idempotency-and-replay-authorization]],
  [[ADR-018-inventory-concurrency-and-negative-stock]], [[ADR-021-count-based-adjustment-concurrency]]
