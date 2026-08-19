# ADR-006: Branch, Warehouse, and Inventory Location Model

- Status: Proposed
- Date: 2026-08-19

## Context

Retail shops and logistics facilities share addresses and may both hold stock, but their operations
are different. Future inventory needs one physical source of truth that can serve POS and online
channels.

## Decision

- **CONFIRMED:** Branch and Warehouse remain explicit tenant-owned entities; no generic Facility is
  introduced.
- **CONFIRMED:** InventoryLocation is the smallest authoritative physical stock-holding location and
  belongs to exactly one Branch or exactly one Warehouse.
- **RECOMMENDED:** InventoryLocations are flat in the foundation and carry direct tenant identity,
  durable tenant-unique codes, status, type, and explicit operational capabilities.
- **CONFIRMED:** Branches and Warehouses may each contain multiple InventoryLocations. Multiple
  Registers may share a sellable Branch location.
- **CONFIRMED:** Future authoritative stock is conceptually `Variant + InventoryLocation`, never
  `Variant + SalesChannel`.
- **RECOMMENDED:** Parent/location archive is a validated closeout workflow and never a cascade
  delete or implicit stock move.

## Alternatives rejected

- Generic Facility with a type discriminator: weakens retail semantics and produces conditional
  rules for Registers, customer-facing behavior, receiving, and logistics.
- Inventory directly on Branch or Warehouse: cannot represent sales floor, stockroom, receiving,
  returns, damaged, or quarantine areas independently.
- Nested locations now: adds cycles, aggregation, scope, and transfer ambiguity without a confirmed
  bin-level requirement.
- Channel-specific stock: creates competing inventory truth and overselling risk.

## Consequences

Branch and Warehouse share value conventions without sharing identity. Future stock movements,
fulfillment, and transfers refer to physical locations. Detailed bin topology can be designed later
without compromising the stable location ID or stock-key invariant.
