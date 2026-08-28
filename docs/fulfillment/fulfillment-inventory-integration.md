# Fulfillment ↔ inventory integration

## Purpose

Describe how a Fulfillment issues stock atomically, the narrow custody primitive, the advisory-lock
order, the location capability requirement, and the atomicity guarantees.

## `inventory_private.record_fulfillment_issue`

The only new inventory write path. `SECURITY DEFINER`, owned by `inventory_writer`, empty `search_path`,
fully qualified, no dynamic SQL. Granted `EXECUTE` to `fulfillments_writer` **only**. Steps:

1. acquire the InventoryLocation lifecycle advisory lock
   (`commerce_locks.acquire_inventory_location_lifecycle_lock(tenant, location)`);
2. read the Location for the tenant; missing → `FF020`;
3. require `status = 'active'` → else `FF021` (`LOCATION_INACTIVE`);
4. require `is_fulfillment_enabled = true` → else `FF022` (`LOCATION_CAPABILITY_DENIED`) — a merely
   active location is not fulfillment-capable;
5. validate every movement is a **negative** delta targeting **exactly** the one location;
6. force `operation_type = 'issue'`;
7. delegate the ledger/balance write to `inventory_private.record_operation`;
8. return the `operation_id`.

It never duplicates ledger/balance logic. `service_role` cannot execute it.

## `fulfillments_private.record_fulfillment` transaction

One PostgreSQL transaction:

1. validate structural input; normalize the idempotency key; compute the canonical intent fingerprint;
2. idempotency fast path (same key + matching intent → return original ids; different → `ID409`);
3. acquire the shared **order-execution** advisory lock;
4. repeat the idempotency lookup under the lock;
5. re-read the Order; require `status = 'placed'` (`FF010`/`FF011` otherwise);
6. resolve each OrderLine (same Order), derive its variant, and reject over-fulfillment against the
   committed remainder (`FF013`);
7. build one negative movement per line and call `record_fulfillment_issue`;
8. insert the Fulfillment and its lines;
9. on a concurrent idempotency unique violation, the savepoint rolls back — including the inventory
   issue — and the loser replays the winner (or is `ID409`);
10. return `fulfillment_id` + `inventory_operation_id`.

## Advisory-lock order

Frozen global order, so no lock cycle forms:

1. order-execution advisory lock (also taken by `cancel_order`);
2. InventoryLocation lifecycle advisory lock (inside `record_fulfillment_issue`);
3. inventory balance row locks (inside `record_operation`).

No per-OrderLine lock exists: same-order serialization via the order-execution lock is sufficient for
over-fulfillment. Concurrency is proven against cancel, same-order fulfillments, different-order
same-location fulfillments, and a generic inventory issue (`pnpm test:fulfillment:concurrency`).

## Location lifecycle concurrency guarantee

`record_fulfillment_issue` acquires the lifecycle lock **before** reading status/capability. The
guarantee — a concurrent deactivation cannot slip between the capability read and the issue — applies to
**sanctioned, lock-abiding** lifecycle transitions. Any FUTURE sanctioned InventoryLocation lifecycle
mutation MUST acquire `commerce_locks.acquire_inventory_location_lifecycle_lock` before changing
lifecycle/capability state relevant to fulfillment. **No sanctioned lifecycle mutation exists today.**
Raw manual `service_role`/superuser DML that ignores the advisory-lock contract is **outside** the
product invariant; we do not claim arbitrary direct `UPDATE`s are serialized. The concurrency suite uses
a test-only, lock-abiding mutation to exercise the race.

## Inventory idempotency backstop

The delegated issue derives a compact, bounded, deterministic internal key
`fulfillment:<md5(tenant:normalized_key)>`. Fulfillment idempotency (the caller's key) remains
authoritative; the inventory key is only a downstream backstop.

## Atomicity guarantees

Proven by the persistence, concurrency, and integration suites:

- insufficient stock → no Fulfillment, FulfillmentLine, InventoryOperation, Movement, or balance change;
- a post-issue insert failure → the inventory mutation rolls back;
- over-fulfillment → the inventory function is never called;
- a cancelled Order → the inventory function is never called;
- an inactive / not-enabled Location → no inventory mutation and no Fulfillment.

See [Inventory operations](../inventory/inventory-operations.md) for the underlying ledger and
`record_operation`.
