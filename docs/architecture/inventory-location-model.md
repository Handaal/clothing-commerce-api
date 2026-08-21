# Inventory Location Model

## Definition

**CONFIRMED:** InventoryLocation is the smallest authoritative physical stock-holding location. It
is distinct from Branch, Warehouse, Register, Brand, Storefront, and SalesChannel.

Examples include a branch sales floor, branch stockroom, returns inspection area, warehouse main
storage, receiving area, and damaged-goods area.

## Ownership and identity

- **CONFIRMED:** Every InventoryLocation belongs to exactly one Branch or exactly one Warehouse,
  never both and never neither.
- **RECOMMENDED:** It also carries direct tenant identity. Persistence must enforce that tenant,
  branch/warehouse parent, register defaults, and every other reference agree.
- **RECOMMENDED:** The location has an immutable internal identifier, a human code, name, type,
  operational status, and explicit capability flags for sellable, fulfillment, receiving, transfer
  origin, and transfer destination behavior.
- **RECOMMENDED:** A location code is unique across the tenant, not merely within its parent. This
  improves scanning, imports, transfers, support, and reporting. The parent remains part of display
  context.

## Capability semantics

Capabilities state whether a location may participate in a kind of future operation; they do not
assert quantity or bypass business policy.

- A sellable location may serve as a POS inventory source.
- A fulfillment-enabled location may be considered by future sourcing logic.
- A receiving-enabled location may accept receipts through a future receiving workflow.
- Transfer eligibility is directional: a location can be allowed as an origin, destination, both,
  or neither.
- A damaged or quarantine location is non-sellable and non-fulfillable by conservative default.
  Releasing stock from it requires an explicit future inventory movement/workflow.

**RECOMMENDED:** Location type is descriptive and supplies safe defaults; capability flags remain
explicit so a type name does not silently authorize operations. Changes that broaden capabilities
are audited.

## Flat topology

**RECOMMENDED:** Do not support nested InventoryLocations in the foundational model. Use a flat set
of operational locations under each Branch or Warehouse. Rack/bin detail can later be added as
non-authoritative placement metadata or as a deliberately designed child-location feature.

Nesting now would complicate stock aggregation, cycle prevention, transfers, authorization scope,
and archival without a demonstrated operational need. Stable location IDs allow nesting to be
introduced later without changing the stock ownership invariant.

- **MEDIUM — REQUIRES FOUNDER DECISION:** Before detailed warehouse/bin management is designed,
  confirm whether rack/bin-level quantities must be authoritative. This is not a Phase 1C blocker
  and should not produce a nullable self-reference now.

## Future inventory invariant

> **CONFIRMED INVARIANT:** Future authoritative inventory is keyed conceptually by
> `ProductVariant + InventoryLocation`, never by `ProductVariant + SalesChannel`.

Phase 2A persists ProductVariant as the stable stock-keeping identity, and Phase 2B now persists
inventory itself, keyed by `ProductVariant + InventoryLocation`. No InventoryLocation column is
stored on ProductVariant; the key lives on the inventory tables.

Phase 2B implements `on_hand` only, as a transactionally maintained `inventory_balances` projection
of an append-only `inventory_movements` ledger grouped by `inventory_operations` (see
[inventory domain](../inventory/inventory-domain.md) and
[inventory persistence](../inventory/inventory-persistence.md)). Clients never overwrite authoritative
balances; the projection changes only through the private atomic mutation path. Future states such as
`reserved`, `available`, `incoming`, `in_transit`, and `damaged`, and the formula
`available = on_hand - active reservations`, remain deferred to later reservation/receiving/transfer
work.

POS and website requests may source the same eligible physical location. A Storefront, POS client,
Register, Device, or SalesChannel can select or request a source but cannot own a balance.

## Lifecycle and reference rules

- Temporary inactivity prevents new operations while preserving existing stock and history.
- Archive is allowed only through a workflow that resolves future non-zero quantities,
  reservations, transfers, fulfillment commitments, and register defaults.
- Archive never silently moves quantities to another location.
- Historical movements and orders retain the original location reference.
- Codes are not reused after archive.

The exact inventory-closeout workflow is **DEFERRED** to the inventory phase; the requirement to
block unsafe archive is **CONFIRMED**.
