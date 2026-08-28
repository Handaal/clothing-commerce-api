# ADR-033: Fulfillment Authorization and Order-Cancellation Interaction

- Status: Accepted
- Date: 2026-08-28

## Context

Fulfilling stock combines two distinct rights: the **commercial** right to fulfill an order and the
**custody** right to issue stock from a location. Neither alone should be sufficient. The repository
mutation boundary must be reachable only when both were satisfied against the exact order and location.
Separately, cancelling an order and physically fulfilling it are mutually exclusive and must never both
succeed for the same order.

## Decision

- **Two-authority model.** A NEW Fulfillment requires BOTH `orders.fulfill` (commercial, against the
  persisted Order's `branch_id` for POS or `brand_id` for ONLINE) AND `inventory.issue` (custody,
  against the `inventory_location`). `AuthorizationService.authorize` is called twice. There is no
  single `fulfillment.create` permission; only `orders.fulfill` is newly provisioned (catalog seed only,
  never assigned to a role). Reads reuse `orders.read`; custody reuses `inventory.issue`.
- **Composite execution proof.** A generic `AuthorizedOperationProof` is insufficient for mutation.
  `FulfillmentExecutionProof` binds a genuine commercial proof (`orders.fulfill`, exact branch/brand) and
  a genuine custody proof (`inventory.issue`, exact location) plus the order and location ids. It is
  minted only inside the trusted service path (the mint is not re-exported from the module's public
  surface) and tracked in a module-private `WeakSet`. `FulfillmentRepository.recordFulfillment` requires
  this type and asserts its provenance, so a custody-only proof, a commercial-only proof, a plain read
  proof, an unrelated proof, or a forged object can never reach the privileged mutation. The mutation
  composite proof and the ordinary read proof are provenance-distinct.
- **Replay still requires both.** An idempotent replay authorizes BOTH authorities against the immutable
  persisted resources (POS → persisted Order branch; ONLINE → persisted Order brand; custody → persisted
  `fulfillment.inventory_location_id`), then mints the composite proof and returns the original. Replay
  does not re-resolve the current register/branch/brand, does not re-check location status or
  `is_fulfillment_enabled`, does not check remaining OrderLine quantity or stock, and issues nothing.
- **Cancellation guard under the shared lock.** `orders_private.cancel_order` acquires the shared
  order-execution advisory lock, then rejects with `ORDER_ALREADY_FULFILLED` if any Fulfillment exists,
  before the `placed → cancelled` transition. Its existing write-once cancellation semantics are
  preserved: re-cancelling returns the original actor/time/reason unchanged.
- **Cancel-vs-fulfill outcome.** The shared lock makes “cancelled Order + Fulfillment” impossible. Either
  the Fulfillment commits (and a later cancel sees it and fails `ORDER_ALREADY_FULFILLED`), or the cancel
  commits (and a later fulfillment sees the cancelled order and fails `ORDER_CANCELLED`, issuing nothing).
- **Location lifecycle guarantee.** A NEW Fulfillment requires an active, fulfillment-enabled location.
  `record_fulfillment_issue` acquires the InventoryLocation lifecycle advisory lock before reading
  status/capability. The guarantee applies to sanctioned, lock-abiding lifecycle transitions; any FUTURE
  sanctioned lifecycle mutation MUST acquire the same lock. No sanctioned lifecycle mutation exists yet,
  and raw manual `service_role`/superuser writes that ignore the lock are outside the product invariant.

## Consequences

- Only a caller with both authorities, against the exact order and location, can create a Fulfillment.
- The repository boundary cannot be defeated by any single proof or a fabricated object.
- Order cancellation and fulfillment can never both win for one order.

## References

- `docs/fulfillment/fulfillment-authorization.md`, `docs/security/tenant-rls.md`,
  `docs/orders/order-lifecycle.md`
- Related: [[ADR-012-identity-and-authorization-foundation]],
  [[ADR-028-order-idempotency-and-replay-authorization]], [[ADR-029-permission-catalog-provisioning]]
