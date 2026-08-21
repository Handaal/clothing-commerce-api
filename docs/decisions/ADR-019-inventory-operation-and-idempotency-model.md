# ADR-019: Inventory Operation and Idempotency Model

- Status: Accepted
- Date: 2026-08-21

## Context

One logical stock change can affect several rows: a future transfer moves `-N` from one location and
`+N` to another; a future multi-line sale deducts several variants at once. These related movements
must be correlatable and auditable. Sync retries and future integrations may resubmit the same
logical change, which must not double-adjust stock. Inventory identity is `ProductVariant +
InventoryLocation`, and PostgreSQL cannot enforce polymorphic foreign keys.

## Decision

- Introduce `InventoryOperation` as the parent envelope for one logical mutation, carrying
  `operation_type`, business `occurred_at`, system `recorded_at`, an optional tenant-safe actor
  Membership, an optional tenant-scoped `idempotency_key`, and optional notes. `InventoryMovement`
  rows belong to an operation and carry a deterministic `line_number`.
- Correlation uses the shared `operation_id`, not a generic `reference_type`/`reference_id` pair. A
  simple operation UUID lets future transfer, sale, return, and receipt rows share one auditable
  event without an unvalidated polymorphic reference. Future domain tables may reference
  `InventoryMovement`/`InventoryOperation` or share the operation id.
- Idempotency is tenant-scoped: a partial unique index on `(tenant_id, normalized_idempotency_key)`
  enforces one use per tenant. The same key is independent across tenants. `idempotency_key` is
  normalized as `lower(btrim(...))` and may not be blank.
- **Payload fingerprint (misuse detection).** Each operation stores a `payload_fingerprint`: an
  `md5` of a canonical, representation-independent string built from `tenant_id`, `operation_type`,
  the actor membership, and the ordered movement lines (`variant_id`, `inventory_location_id`,
  `quantity_delta` normalized through their SQL types, so JSON key order and number-vs-string form do
  not matter). `occurred_at`, `recorded_at`, and `notes` are excluded because they are not reliably
  caller-stable identity inputs. Movement order **is** part of identity, consistent with the
  order-sensitive intermediate-negative rule.
- **Idempotency semantics.** Re-submitting a used `(tenant, key)` with the **same** fingerprint
  returns the original operation id and applies nothing. Re-submitting the same key with a
  **different** fingerprint raises a deterministic error (SQLSTATE `ID409`, "idempotency key reused
  with a different payload") and mutates nothing — never a silent success. A concurrent first
  submission is resolved by the unique index: the loser re-reads the winner and either returns its id
  (same fingerprint) or raises `ID409` (different). A failed operation rolls back, so its key remains
  reusable. Callers that retry must resubmit an identical payload.
- `operation_type` is a small controlled set (`opening`, `adjustment`, `correction`, `receipt`,
  `sale`, `return`, `transfer`). Phase 2B producers use `opening`, `adjustment`, and `correction`;
  the rest are reserved for later workflow domains, which will add their own validation (for example
  zero-sum enforcement for `transfer`). No workflow is implemented now.
- The actor is a nullable structured foreign key; null means system origin (future checkout,
  reconciliation, sync, integrations). Identity is never stored as free text.

## Alternatives rejected

- **Metadata stuffed into every movement:** duplicates operation-level fields and loses the natural
  grouping for transfers and multi-line events.
- **Generic polymorphic `reference_type`/`reference_id`:** PostgreSQL cannot enforce it; a shared
  operation UUID is safer and sufficient now.
- **Full HTTP idempotency middleware:** out of scope for the persistence foundation; the ledger must
  still be able to distinguish duplicate submissions.
- **Enumerating every future workflow type immediately:** would encode unreviewed business behavior;
  a minimal reserved taxonomy is enough.

## Consequences

Related movements are auditable and correlatable, retries are safe, and future transfer/sale/return/
receipt workflows can attach to a stable operation envelope without schema redesign. Persistence and
concurrency tests cover tenant-scoped idempotency, same-fingerprint replay, different-payload
rejection (`ID409`) both sequentially and under concurrent submission, the deliberate `occurred_at`
exclusion (a replay carrying a different `occurred_at` returns the original operation and keeps its
original business time), cross-tenant key reuse, multi-line and zero-sum operations, and system-origin
(null actor) operations. HTTP-level idempotency
semantics are layered later on top of this foundation, and must preserve the payload for a given key
or expect a deterministic `ID409`.
