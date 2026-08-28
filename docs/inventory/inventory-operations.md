# Inventory Operations (Phase 2C)

## Purpose

Phase 2C adds the **inventory application service boundary**: the single place the rest of the
commerce system expresses stock intent. It hides every Phase 2B ledger detail
(`inventory_private.record_operation`, `quantity_delta` signs, movement JSON, `payload_fingerprint`,
SQLSTATEs, the `inventory_writer` role, the balance-write GUC) behind a small set of intent-named
commands. Future domains — Orders, Purchasing, Returns, POS, Storefront — will call these commands (or
a future HTTP API in front of them) and must never touch the ledger directly.

See [ADR-020](../decisions/ADR-020-inventory-application-service-boundary.md),
[ADR-021](../decisions/ADR-021-count-based-adjustment-concurrency.md),
[ADR-022](../decisions/ADR-022-opening-stock-one-time-semantics.md), and
[ADR-023](../decisions/ADR-023-atomic-immediate-transfer-primitive.md).

## Responsible files

- `src/inventory/model.ts` — command input schemas (Zod), result types, permission keys.
- `src/inventory/errors.ts` — `InventoryError` and the stable error codes.
- `src/inventory/repository.ts` — the narrow `InventoryRepository` port.
- `src/inventory/supabase-inventory-repository.ts` — the service-role adapter that hides all ledger
  detail and maps database errors.
- `src/inventory/inventory-service.ts` — the six commands, authorization, and lifecycle rules.
- `src/inventory/index.ts` — the curated module surface.
- `supabase/migrations/20260822180000_create_inventory_operation_functions.sql` — the two new
  functions and the `issue` operation type.
- `supabase/migrations/20260822180100_grant_inventory_operation_functions.sql` — the grants.

## Commands

Every command is a method on `InventoryService` taking the verified `AuthorizationContext` and the
caller input. `tenantId` and the actor Membership are derived from the context, never from input.

| Command               | Meaning                                           | Permission           | Resource(s)          | Operation type |
| --------------------- | ------------------------------------------------- | -------------------- | -------------------- | -------------- |
| `getInventoryBalance` | Read current physical on-hand + version           | `inventory.read`     | location             | —              |
| `setOpeningStock`     | One-time stock initialization                     | `inventory.adjust`   | location             | `opening`      |
| `adjustInventory`     | Reconcile to an absolute counted quantity         | `inventory.adjust`   | location             | `adjustment`   |
| `receiveInventory`    | Generic approved physical stock entry             | `inventory.receive`  | location             | `receipt`      |
| `issueInventory`      | Generic approved physical stock exit              | `inventory.issue`    | location             | `issue`        |
| `transferInventory`   | Immediate atomic relocation between two locations | `inventory.transfer` | source + destination | `transfer`     |

`receiveInventory` is **not** "purchase received" and `issueInventory` is **not** "sale completed".
They are generic physical stock entry/exit primitives; the future Purchasing/Orders/Returns domains
produce their own workflow semantics and may consume these commands internally.

### Fulfillment custody exit (Phase 2E)

Phase 2E adds one narrow custody primitive, `inventory_private.record_fulfillment_issue`, used only by a
Fulfillment. It acquires the InventoryLocation lifecycle advisory lock, requires the location be
`active` **and** `is_fulfillment_enabled`, validates every movement is a negative delta at exactly the
one location, forces `operation_type = 'issue'`, and delegates to `record_operation`. It is granted
`EXECUTE` to `fulfillments_writer` **only** — never `service_role` — so it does not widen the generic
inventory surface. `inventory_writer` gains `SELECT`-only on `inventory_locations` for the capability
check. See [Fulfillment ↔ inventory integration](../fulfillment/fulfillment-inventory-integration.md).

### getInventoryBalance

```ts
const balance = await inventoryService.getInventoryBalance(context, {
  variantId,
  inventoryLocationId,
});
// { variantId, inventoryLocationId, onHand, version, exists }
```

A stock key with no movement history reads as `{ onHand: 0, version: 0, exists: false }` — this is
not an error. Only `onHand` is exposed; `reserved`, `allocated`, and `availableToSell` do not exist
(reservations are deferred).

### setOpeningStock

```ts
await inventoryService.setOpeningStock(context, {
  variantId, inventoryLocationId, quantity, idempotencyKey, note?,
});
```

`quantity` must be positive. Opening succeeds only when the key has **no prior movement history**
(historical truth, not balance-row absence). A second opening of an established key raises
`OPENING_STOCK_ALREADY_EXISTS`; an idempotent replay of the same key returns the original operation.

### adjustInventory

```ts
const balance = await inventoryService.getInventoryBalance(context, { variantId, inventoryLocationId });
await inventoryService.adjustInventory(context, {
  variantId, inventoryLocationId,
  countedQuantity,            // "the physical count is N", never a signed delta
  expectedVersion: balance.version,
  idempotencyKey, note?,
});
```

The service derives the delta (`counted - current`) atomically under the balance-row lock. A count
equal to current on-hand is a **durable no-op**: it still persists one `InventoryOperation` (the
audit/idempotency envelope) but writes **no** `InventoryMovement` and leaves the balance and version
unchanged. The result is `{ operationId: <persisted id>, changed: false }` with
`previousOnHand === newOnHand`. Because the operation (and therefore the idempotency key) is durably
recorded, a no-op is idempotent exactly like a changed count: a same-key/same-payload retry replays the
original operation, and a same-key/different-payload reuse raises `IDEMPOTENCY_CONFLICT`.

### receiveInventory / issueInventory

```ts
await inventoryService.receiveInventory(context, {
  variantId,
  inventoryLocationId,
  quantity,
  idempotencyKey,
});
await inventoryService.issueInventory(context, {
  variantId,
  inventoryLocationId,
  quantity,
  idempotencyKey,
});
```

Both take a **positive** `quantity` at the boundary. The adapter maps receive to a `+quantity`
movement and issue to a `-quantity` movement; callers never see signed deltas. An issue that would
drive on-hand negative fails atomically with `INSUFFICIENT_STOCK`.

### transferInventory

```ts
await inventoryService.transferInventory(context, {
  variantId,
  sourceInventoryLocationId,
  destinationInventoryLocationId,
  quantity,
  idempotencyKey, note?,
});
```

One atomic `transfer` operation carrying two movements (`-quantity` at source, `+quantity` at
destination). It is a single-variant, immediate relocation primitive, **not** a transfer-document
workflow (draft/approve/dispatch/receive is a future domain). Source and destination must differ; the
caller must be authorized for **both** locations.

## Result model

The result shape reflects **what the database can actually guarantee**, so it never presents a
post-commit observation as an atomic snapshot.

- `InventoryBalanceResult { variantId, inventoryLocationId, onHand, version, exists }`
- `setOpeningStock` / `adjustInventory` →
  `InventoryMutationResult { operationId, changed, variantId, inventoryLocationId, previousOnHand, newOnHand, version }`.
  These values are **authoritative**: the SECURITY DEFINER functions compute and return them while
  holding the balance-row lock, so `previousOnHand`/`newOnHand`/`version` reflect exactly this
  operation. `operationId` is always present (a durable no-op included); `changed` distinguishes a
  no-op (`false`, `previousOnHand === newOnHand`) from an applied change (`true`).
- `receiveInventory` / `issueInventory` →
  `InventoryObservedMutationResult { operationId, changed: true, variantId, inventoryLocationId, observedOnHand, observedVersion }`.
- `transferInventory` → `InventoryTransferResult { operationId, variantId, source, destination }` where
  each side is `{ inventoryLocationId, observedOnHand, observedVersion }`.

Receipt/issue/transfer go through Phase 2B `record_operation`, which returns only the operation id, so
their balances are **read after commit**. `observedOnHand`/`observedVersion` are therefore the current
observed state, which under concurrency may already include later committed operations. The field names
say `observed…` precisely because they are **not** an atomic before/after snapshot of this operation —
only that the operation was recorded is guaranteed. The adapter never reconstructs a before/after value
by arithmetic. A caller needing an exact post-condition should read the balance and use optimistic
concurrency (`adjustInventory` with `expectedVersion`).

## Idempotency

Every mutation **requires** an `idempotencyKey` (a stable, non-empty, ≤200-char string supplied by
the caller — the service never generates one). Reads take none. Reusing a key with the same logical
payload replays the original operation; reusing it with a different payload is a deterministic
`IDEMPOTENCY_CONFLICT`. The `payload_fingerprint` is never exposed.

Idempotency keys are matched **case-insensitively**: the ledger stores a normalized key
(`lower(btrim(key))`), so `"ABC"` and `" abc "` are the same key. The application only trims (it does
not lowercase), so callers should treat keys as case-insensitive and unique per logical intent.

Every successful mutation is durably idempotent, **including a no-op count adjustment**: it persists an
operation envelope (with no movement), so its key is consumed and a retry replays. For count adjustment
the idempotency identity is the caller's inputs (`countedQuantity` + `expectedVersion`), not the derived
delta, so a post-success retry replays rather than failing the version check — even a no-op retried
after a later movement advanced the version still replays (the idempotency lookup precedes the version
comparison) rather than raising `CONCURRENT_MODIFICATION`.

## Application quantity range

Phase 2C carries quantities and versions across the application boundary as **JavaScript safe
integers** (`0 .. Number.MAX_SAFE_INTEGER`, i.e. 9,007,199,254,740,991). Input schemas reject anything
larger. The PostgreSQL ledger remains `bigint`; this is purely an application transport boundary and no
`bigint → string/numeric` contract change is made in Phase 2C. A stored balance that somehow exceeds
the safe-integer range is a numeric transport/invariant failure, not a business condition: the
repository raises a generic internal error ("Inventory quantity is outside the supported application
range."), which a future HTTP layer maps to **500** — never a 404-style domain error.

## Version conflicts (how to reason about them)

`adjustInventory` uses optimistic concurrency on the balance `version`. Read the balance, then submit
the count with the `version` you read as `expectedVersion`. If another operation changed the balance
in between, the version no longer matches and the command raises `CONCURRENT_MODIFICATION` — nothing
is applied. The correct client response is to re-read the balance and re-count against the new
version. Version (not on-hand) is compared so that two offsetting concurrent movements (ABA) cannot
mask a change.

## Actor and timestamp

`actorMembershipId` is always `context.membership.id`; it is never accepted from input (a smuggled
field is rejected by the strict schemas). `occurredAt` is server-set to `now()` in Phase 2C; caller
backdating is deferred (the database parameter is retained so a future offline-POS phase can supply a
business time without a schema change).

## Notes

`note` is an optional, short (≤500 char), tenant-visible operator note stored on the operation. It is
not a metadata blob. **Do not put secrets in notes** — the authenticated inventory read policy exposes
operation rows to every active member of the tenant.

## Lifecycle matrix

Statuses come from the merged catalog/org schemas: variant `draft|active|archived`, location
`active|inactive|archived`. These are application rules; persistence stays permissive.

Lifecycle and capability checks are **application-level and best-effort**: the service reads
variant/location state before delegating to the ledger, but the mutation functions do not re-verify
status/capability. A status or capability change committed between the check and the write is a
time-of-check/time-of-use window that can let a mutation through under the just-changed state. The
guarantees the database _does_ enforce atomically are tenant integrity, non-negative stock, one-time
opening, and count version concurrency. If a future requirement needs a status rule enforced
atomically, move it into a hardened `inventory_private` function rather than relying on the pre-check.

| Command                         | Variant                                      | Location                                                                      |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| `getInventoryBalance`           | any (read)                                   | any (read)                                                                    |
| `setOpeningStock`               | active only                                  | active only                                                                   |
| `adjustInventory`               | active only                                  | active or inactive (reconcile); archived denied                               |
| `receiveInventory`              | active only                                  | active + `is_receiving_enabled`                                               |
| `issueInventory`                | active or archived (write-off); draft denied | active or inactive (evacuate); archived denied                                |
| `transferInventory` source      | active only                                  | active or inactive (evacuate) + `is_transfer_origin_enabled`; archived denied |
| `transferInventory` destination | active only                                  | active + `is_transfer_destination_enabled`                                    |

## Error taxonomy and troubleshooting

`InventoryError` (stable `code`, safe message, `httpStatus`). Authorization failures surface as
`AuthorizationError` and are not duplicated here. Raw SQLSTATEs never escape the repository.

| Code                                       | Meaning / typical cause                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `VARIANT_NOT_FOUND` / `LOCATION_NOT_FOUND` | The referenced entity does not exist in the tenant.                   |
| `VARIANT_INACTIVE` / `LOCATION_INACTIVE`   | Lifecycle rule for the command was violated.                          |
| `LOCATION_CAPABILITY_DENIED`               | The location lacks the required capability flag (receiving/transfer). |
| `INVALID_QUANTITY`                         | Malformed input, or a non-positive/out-of-range quantity.             |
| `INSUFFICIENT_STOCK`                       | The operation would drive on-hand negative (maps DB `23514`).         |
| `OPENING_STOCK_ALREADY_EXISTS`             | Opening attempted where movement history exists (maps DB `IN001`).    |
| `SAME_TRANSFER_LOCATION`                   | Transfer source equals destination.                                   |
| `IDEMPOTENCY_CONFLICT`                     | Key reused with a different payload (maps DB `ID409`).                |
| `CONCURRENT_MODIFICATION`                  | Stale `expectedVersion` on a count (maps DB `IN002`).                 |
| `TENANT_MISMATCH`                          | Cross-tenant/missing FK backstop (maps DB `23503`).                   |

An unexpected privilege failure (`42501`) from the sanctioned path is a server defect, not a client
error; it surfaces as a generic error, never a `42501` leak.

## Database error signals

Two internal-only custom SQLSTATEs are raised by the Phase 2C functions and mapped by the repository:

- `IN001` — opening already exists (prior movement history) → `OPENING_STOCK_ALREADY_EXISTS`.
- `IN002` — balance version mismatch → `CONCURRENT_MODIFICATION`.

Idempotency conflicts reuse the Phase 2B `ID409` signal. These signals are infrastructure and are
never exposed outside the repository.

## How to modify inventory permissions

Permission keys are platform-global and enforced in application code
(`InventoryPermission` in `src/inventory/model.ts`). Phase 2C does **not** seed permission rows in a
shared migration; tests seed the rows they need. To add a new inventory capability, add a stable
`inventory.<action>` key, reference it from the relevant command, and seed it where the command is
exercised. Do not add role-name checks; authorization always evaluates permission + scope.

## How to test

- Unit (`pnpm test`, includes `tests/inventory/**`): service authorization, lifecycle, actor
  derivation, idempotency forwarding, adapter error mapping and movement construction.
- Persistence (`pnpm test:inventory:operations:persistence`): the two functions and the issue path
  against disposable PostgreSQL; runs on Windows and Linux.
- Concurrency (`pnpm test:inventory:operations:concurrency`): opening race, opening replay race, and
  stale-count race.
- RLS/metadata (`pnpm test:inventory:operations:rls`) and integration
  (`pnpm test:inventory:operations:integration`): the Supabase-local suites; **Linux CI is
  authoritative** because local Windows reserves port 54322.

See [inventory testing](../development/inventory-testing.md).

## How to extend inventory operations safely

Add new business intent as a new command on `InventoryService` with its own permission and lifecycle
rules; keep the repository port narrow and never expose `record_operation`, signed deltas, movement
JSON, or the raw client to callers. If a new intent needs cross-step atomicity (like opening or count
adjustment), add a hardened `SECURITY DEFINER` function in `inventory_private` (owned by
`inventory_writer`, empty `search_path`, no dynamic SQL, `service_role` EXECUTE only) rather than a
check-then-write in the application. See [inventory persistence](inventory-persistence.md).
