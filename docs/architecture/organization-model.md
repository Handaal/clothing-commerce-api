# Organization Model

## Model boundary

The organizational model preserves explicit retail meanings instead of reducing them to a generic
facility or channel hierarchy.

```text
Platform
└── Tenant
    ├── Brand(s)
    ├── Branch(es)
    │   ├── Register(s)
    │   └── InventoryLocation(s)
    └── Warehouse(s)
        └── InventoryLocation(s)
```

- **CONFIRMED:** Tenant, Brand, Branch, Warehouse, InventoryLocation, Register, Device, and
  SalesChannel are different concepts.
- **CONFIRMED:** Tenants may omit capabilities they do not use. A single-brand tenant is one row and
  ordinary defaults, not a different model.
- **RECOMMENDED:** Branch and Brand have an explicit many-to-many supported-brand association. The
  association expresses selling/operational eligibility, not stock ownership.
- **RECOMMENDED:** Warehouses may service multiple brands. Physical stock is still located by
  InventoryLocation; future product/variant records carry the relevant merchandise attribution.

## Concept responsibilities

| Concept           | Meaning                                                | Does not mean                           |
| ----------------- | ------------------------------------------------------ | --------------------------------------- |
| Platform          | SaaS operator and global policy/catalog boundary       | A tenant or merchant                    |
| Tenant            | Isolated customer organization                         | A consumer-facing brand                 |
| Brand             | Trading/merchandising identity within a tenant         | Tenant ownership or a stock balance     |
| Branch            | Physical retail/business location                      | Warehouse, stock bin, or sales channel  |
| Warehouse         | Logistics and stock-holding facility                   | Customer-facing shop by default         |
| InventoryLocation | Smallest authoritative physical stock-holding location | Branch, warehouse, register, or channel |
| Register          | POS checkout context within a branch                   | Device or inventory balance             |
| Device            | Enrolled physical/software installation identity       | Register or user membership             |
| SalesChannel      | Origin/classification of future commerce activity      | Stock owner                             |

## Cross-cutting rules

1. **CONFIRMED:** One tenant can have multiple brands, branches, and warehouses.
2. **CONFIRMED:** One branch can have multiple registers and inventory locations.
3. **CONFIRMED:** Multiple registers can sell from the same sellable branch inventory location.
4. **CONFIRMED:** One warehouse can have multiple inventory locations and hold merchandise for
   multiple brands.
5. **CONFIRMED:** InventoryLocation belongs to exactly one Branch or exactly one Warehouse.
6. **CONFIRMED:** Organizational records are statused/archived, not deleted when history depends on
   them.
7. **CONFIRMED:** POS and online use one future product, inventory, order, and customer domain.

## Capability relationships

Brand support, selling eligibility, fulfillment eligibility, receiving capability, transfer
capability, and default inventory source are explicit relationships or properties at their proper
domain boundary. They are not inferred from similar names or address proximity.

**RECOMMENDED:** A branch's default POS inventory source references one active, sellable
InventoryLocation owned by that same branch. A register may override it with its own valid default.
No default creates or owns stock.

**RECOMMENDED:** Archiving a parent prevents new operational use of its descendants but does not
silently rewrite child status or historical records. An archival workflow must validate or
explicitly transition active registers, devices, inventory locations, open work, and future stock
obligations.

## Rejected abstraction

**RECOMMENDED:** Do not introduce `Facility` in Phase 1C. Branch and Warehouse have materially
different retail semantics, relationships, and policies. Shared address/contact value shapes can be
reused without a shared persistence supertype. Revisit only if a third facility kind demonstrates
stable common behavior rather than merely shared columns.

## Future order invariant

> **CONFIRMED INVARIANT:** POS and online orders belong to one future Order domain. SalesChannel
> identifies origin, such as `POS` or `ONLINE`; it does not create separate order models, inventory
> balances, or customer truth.

Order entities, channel enums, fulfillment, and transaction behavior are outside Phase 1B. This
invariant prevents the organizational model from creating channel-owned commerce silos.
