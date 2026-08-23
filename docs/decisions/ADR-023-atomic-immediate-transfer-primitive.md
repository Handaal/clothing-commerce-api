# ADR-023: Atomic Immediate Transfer Primitive

- Status: Accepted
- Date: 2026-08-22

## Context

Relocating stock between two InventoryLocations must be atomic: the source decrement and the
destination increment either both commit or neither does. Doing it as a separate issue then receipt
could leave stock destroyed on a partial failure. Phase 2B deliberately does not enforce transfer
zero-sum in the database (`transfer` is a reserved type with no workflow). A full stock-transfer
document (draft → requested → approved → dispatched → received → cancelled) is a future domain.

## Decision

- `transferInventory` is a **single-variant, immediate** relocation. It produces **one** `transfer`
  operation carrying two movements: `-quantity` at the source and `+quantity` at the destination, via
  the existing atomic `record_operation`. The ledger commits both movements or neither and locks both
  balance keys in canonical order (no deadlock).
- Zero-sum is enforced in application code by construction (the adapter emits exactly `-q` and `+q`
  for one `q`); no database zero-sum constraint is added.
- Rules: `source ≠ destination` (`SAME_TRANSFER_LOCATION`); positive quantity; active variant; source
  active or inactive (evacuation) with `is_transfer_origin_enabled`, and not archived; destination
  active with `is_transfer_destination_enabled`. Insufficient source stock fails the whole operation
  (`INSUFFICIENT_STOCK`).
- Authorization requires `inventory.transfer` coverage of **both** locations under Phase 1D's
  permission-coupled scope model; both may be covered by one assignment listing both, or by two
  assignments that each carry the permission and cover one location.
- Multi-variant transfer is **not** implemented: one variant per command. This keeps authorization,
  idempotency, and failure semantics simple and avoids pre-empting the future transfer-document
  domain.

## Alternatives rejected

- **Separate issue + receipt:** non-atomic; a partial failure destroys stock.
- **Database-enforced zero-sum:** unnecessary — the application constructs the pair — and would
  entangle the generic ledger with transfer-specific semantics.
- **Multi-SKU atomic transfer now:** complicates authorization/idempotency/failure handling with no
  present consumer.
- **A transfer-document lifecycle:** a separate future domain; this command is only the physical
  immediate-relocation primitive it will build on.

## Consequences

Stock relocates atomically with correct dual-location authorization, and the ledger already
guarantees no oversell and no deadlock. The concurrency and integration suites cover the atomic
movement pair; the naming and docs make clear this is a primitive, not a transfer workflow.
