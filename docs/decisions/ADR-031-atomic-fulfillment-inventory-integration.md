# ADR-031: Atomic Fulfillment → Inventory Integration

- Status: Accepted
- Date: 2026-08-28

## Context

A Fulfillment must issue stock and record itself as one indivisible act. If the inventory issue could
commit without the Fulfillment (or vice versa), the ledger and the fulfillment record would disagree.
The custody capability must also be narrow: fulfilling stock is a different privilege from the generic
inventory issue, and `service_role` must never be able to issue fulfillment stock directly.

## Decision

- **One narrow custody primitive.** `inventory_private.record_fulfillment_issue` is the only new
  inventory write path. It is `SECURITY DEFINER`, owned by `inventory_writer`, empty `search_path`, fully
  qualified, no dynamic SQL. It acquires the InventoryLocation lifecycle lock, requires
  `status = 'active'` **and** `is_fulfillment_enabled = true`, validates every movement is a **negative**
  delta targeting **exactly** the one location, forces `operation_type = 'issue'`, and delegates the
  ledger/balance write to the existing `inventory_private.record_operation`. It never duplicates ledger
  or balance logic.
- **Least privilege.** `EXECUTE` on `record_fulfillment_issue` is granted to `fulfillments_writer`
  **only** — never `service_role`, `anon`, `authenticated`, or `PUBLIC`. `inventory_writer` gains
  `SELECT` (via grant + a narrow RLS policy) on `inventory_locations` for the capability check, and no
  DML on it. `fulfillments_writer` gets no direct inventory DML and no `record_operation` `EXECUTE`.
- **One transaction.** `fulfillments_private.record_fulfillment` calls `record_fulfillment_issue` and
  inserts the Fulfillment and its lines in a single transaction. A savepoint block wraps the issue +
  inserts so that an idempotency-race loser's inventory issue is rolled back with its failed insert.
- **One InventoryOperation per Fulfillment.** `fulfillments.inventory_operation_id` is `NOT NULL` with a
  tenant-safe FK to `inventory_operations(tenant_id, id)` and a unique `(tenant_id,
inventory_operation_id)`. One operation carries one negative movement per FulfillmentLine, all at the
  same location.
- **Inventory idempotency backstop.** The delegated issue derives a compact, bounded, deterministic
  internal key `fulfillment:<md5(tenant:normalized_key)>`. Fulfillment idempotency (the caller's key)
  remains authoritative; the inventory key is only a downstream backstop.

## Consequences

- Insufficient stock, a post-issue insert failure, over-fulfillment, a cancelled order, or an
  inactive/not-enabled location each leave **no** Fulfillment, FulfillmentLine, InventoryOperation,
  Movement, or balance change.
- `service_role` can read fulfillments and call the two sanctioned RPCs, but can never issue fulfillment
  stock directly.

## References

- `docs/fulfillment/fulfillment-inventory-integration.md`
- Related: [[ADR-019-inventory-operation-and-idempotency-model]],
  [[ADR-020-inventory-application-service-boundary]], [[ADR-027-order-payment-and-inventory-separation]]
