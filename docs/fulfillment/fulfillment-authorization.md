# Fulfillment authorization

## Purpose

Describe the two-authority model, the composite execution proof that guards the repository mutation
boundary, replay authorization, and the interaction with order cancellation.

## Two-authority model

A NEW Fulfillment requires BOTH:

1. **commercial authority** — `orders.fulfill`, against the persisted Order's commercial resource
   (POS: `{ kind: "branch", id: order.branch_id }`; ONLINE: `{ kind: "brand", id: order.brand_id }`);
2. **custody authority** — `inventory.issue`, against `{ kind: "inventory_location", id }`.

`FulfillmentService` calls `AuthorizationService.authorize` twice. There is deliberately **no**
`fulfillment.create` permission — a Fulfillment is the composition of a commercial and a custody
capability. Only `orders.fulfill` is newly provisioned, as a catalog seed (never assigned to a role).
Reads reuse `orders.read`.

## Composite execution proof

A generic `AuthorizedOperationProof` is **not** sufficient to write a Fulfillment.
`FulfillmentExecutionProof` (`src/fulfillments/execution-proof.ts`) binds:

- a genuine commercial `AuthorizedOperationProof` (`permissionKey === "orders.fulfill"`, covering the
  exact branch/brand resource);
- a genuine custody `AuthorizedOperationProof` (`permissionKey === "inventory.issue"`, covering the
  exact `inventory_location`);
- the `orderId` and `inventoryLocationId`.

The mint (`mintFulfillmentExecutionProof`) asserts both inputs via `assertAuthorizedOperationProof`,
checks the two permission keys, and checks each proof covers the expected resource; it records the result
in a module-private `WeakSet`. It is **not** re-exported from `src/fulfillments/index.ts`, so it is
reachable only from inside the module (the trusted `FulfillmentService` path); ordinary callers can
neither obtain genuine authorization proofs without passing authorization nor add to the provenance set.

`FulfillmentRepository.recordFulfillment` requires `FulfillmentExecutionProof` (not
`AuthorizedOperationProof`) and calls `assertFulfillmentExecutionProof`. Therefore a custody-only proof,
a commercial-only proof, a plain read proof, an unrelated proof, or a forged object can never reach the
privileged mutation. The mutation composite proof and the read proof are provenance-distinct: a composite
proof is not accepted where an ordinary read proof is required, and vice versa.

## Reads

`getFulfillment`, `getOrderFulfillments`, and `getOrderFulfillmentSummary` authorize `orders.read`
against the Order's persisted commercial resource, using an ordinary `AuthorizedOperationProof`. No
`inventory.issue` is required for reads. A narrow pre-authorization routing lookup resolves only
`fulfillmentId`/`orderId`/`channel`/`brandId`/`branchId` and never leaks commercial data or cross-tenant
existence.

## Replay authorization

An idempotent replay still requires BOTH authorities, resolved against the **immutable persisted**
resources from the replay preflight (POS → persisted Order branch; ONLINE → persisted Order brand;
custody → persisted `fulfillment.inventory_location_id`). The service then mints the composite proof and
returns the original Fulfillment. A replay does **not** re-resolve the current register/branch/brand,
does **not** re-check location status or `is_fulfillment_enabled`, does **not** check remaining OrderLine
quantity or stock, and issues nothing (the database `record_fulfillment` fast-path short-circuits to the
original). Possession of an idempotency key never bypasses authorization.

## Order cancellation interaction

`orders_private.cancel_order` acquires the shared order-execution advisory lock and refuses cancellation
with `ORDER_ALREADY_FULFILLED` when any Fulfillment exists. The shared lock makes “cancelled Order +
Fulfillment” impossible: either the Fulfillment wins (cancel later fails `ORDER_ALREADY_FULFILLED`) or
the cancel wins (fulfillment later fails `ORDER_CANCELLED`, issuing nothing). See
[Order lifecycle](../orders/order-lifecycle.md) and ADR-033.

## Errors

Authorization failures surface as `AuthorizationError` (`PERMISSION_DENIED`, `SCOPE_DENIED`,
`TENANT_ACCESS_DENIED`, `AUTHORIZATION_PROOF_INVALID`). Domain failures surface as `FulfillmentError`
(`FULFILLMENT_NOT_FOUND`, `ORDER_NOT_FOUND`, `ORDER_CANCELLED`, `ORDER_LINE_NOT_FOUND`,
`OVER_FULFILLMENT`, `LOCATION_INACTIVE`, `LOCATION_CAPABILITY_DENIED`, `INSUFFICIENT_STOCK`,
`IDEMPOTENCY_CONFLICT`, …). Raw SQLSTATEs never escape the repository.
