# Branch and Warehouse Model

## Branch

**CONFIRMED:** A Branch is a tenant-owned physical retail or business location. It is not a
warehouse, inventory location, register, or sales channel.

Its conceptual profile includes immutable internal identity, direct tenant identity, tenant-unique
branch code, display name, structured address, IANA timezone, operating status, contact information,
supported brands, default POS inventory source, and future fulfillment/click-and-collect
eligibility.

- **CONFIRMED:** A branch can contain multiple InventoryLocations.
- **CONFIRMED:** A branch can have multiple Registers.
- **CONFIRMED:** Multiple Registers can sell from the same InventoryLocation.
- **CONFIRMED:** A branch can become temporarily inactive or archived without deleting history.
- **RECOMMENDED:** Branch timezone defaults from the tenant but is stored/selected explicitly
  because physical locations may cross timezone boundaries.
- **RECOMMENDED:** Supported brands are explicit and many-to-many. Brand eligibility does not imply
  that every product of that brand is ranged at the branch.
- **RECOMMENDED:** The branch default POS source must be an active, sellable InventoryLocation owned
  by that branch. It is a default, not a quantity or reservation.

Fulfillment and click-and-collect flags express eligibility only. Future services must still check
stock, hours, capacity, and order policy.

## Warehouse

**CONFIRMED:** A Warehouse is a tenant-owned stock-holding and logistics facility. It is not
customer-facing or POS-capable by default.

Its conceptual profile includes immutable internal identity, direct tenant identity, tenant-unique
warehouse code, name, structured address, operating status, contact information where useful, and
future fulfillment, transfer-origin, transfer-destination, and receiving eligibility.

- **CONFIRMED:** A warehouse contains one or more InventoryLocations when operational stock is held.
- **RECOMMENDED:** A warehouse can service and hold inventory for multiple brands; brand is not part
  of warehouse identity.
- **RECOMMENDED:** Capability flags do not bypass later workflow rules. Receiving occurs at a
  receiving-eligible InventoryLocation, and transfers identify physical origin and destination
  locations.

## Why there is no generic Facility

**RECOMMENDED:** Keep Branch and Warehouse as explicit entities. Their invariants and business
language differ: branches support registers, retail hours, selling, and collection; warehouses
support logistics, receiving, and transfer operations. A generic Facility would trade clear
semantics for superficial column reuse and would require fragile type-dependent constraints.

Address and contact structures may share value-object conventions. This does not justify a generic
entity or inheritance hierarchy.

## Status and archival behavior

Operational status should distinguish at least active use from temporary inactivity and archival;
exact enums are **DEFERRED** to contract design.

**RECOMMENDED:** Archiving a Branch or Warehouse:

1. immediately prevents selection for new operations;
2. preserves codes, relationships, and historical references;
3. requires validation of active registers/device assignments, child InventoryLocations, future
   on-hand/reserved stock, transfers, orders, and fulfillment commitments;
4. does not automatically archive or move children, stock, or assignments; and
5. emits an audit event with the approved resolution plan.

Temporary inactivity is reversible and may be used for maintenance or seasonal closure. Archive is
a stronger lifecycle decision. Neither is a hard delete.

## Uniqueness

- Branch code is normalized and unique within the tenant for all lifecycle states.
- Warehouse code is normalized and unique within the tenant for all lifecycle states.
- Codes are not reused after archival, preserving imports, reports, receipts, and human audit trails.

- **LOW — REQUIRES FOUNDER DECISION:** Approve the display format and normalization rules for branch
  and warehouse codes before external imports or printed documents depend on them. Non-reuse and
  tenant-level uniqueness can be implemented independently.
