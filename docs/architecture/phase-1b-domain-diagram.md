# Phase 1B Conceptual Domain Diagram

This diagram shows conceptual ownership and cardinality. It is not a database schema and does not
prescribe columns or SQL types.

```mermaid
erDiagram
    PLATFORM ||--o{ TENANT : operates
    TENANT ||--o{ BRAND : owns
    TENANT ||--o{ BRANCH : owns
    TENANT ||--o{ WAREHOUSE : owns
    TENANT ||--o{ MEMBERSHIP : admits
    TENANT ||--o{ ROLE : defines
    TENANT ||--o{ ACCESS_SCOPE : defines

    BRAND }o--o{ BRANCH : supported_at

    BRANCH o|--o{ INVENTORY_LOCATION : may_contain
    WAREHOUSE o|--o{ INVENTORY_LOCATION : may_contain
    BRANCH ||--o{ REGISTER : contains
    INVENTORY_LOCATION ||--o{ REGISTER : default_source_for

    USER_IDENTITY ||--o{ MEMBERSHIP : participates_through
    MEMBERSHIP ||--o{ MEMBERSHIP_ROLE_ASSIGNMENT : receives
    ROLE ||--o{ MEMBERSHIP_ROLE_ASSIGNMENT : assigned_as
    ACCESS_SCOPE ||--o{ MEMBERSHIP_ROLE_ASSIGNMENT : limits
    ROLE }o--o{ PERMISSION : grants

    ACCESS_SCOPE }o--o{ BRAND : may_target
    ACCESS_SCOPE }o--o{ BRANCH : may_target
    ACCESS_SCOPE }o--o{ WAREHOUSE : may_target
    ACCESS_SCOPE }o--o{ INVENTORY_LOCATION : may_target

    TENANT ||--o{ DEVICE : enrolls
    REGISTER ||--o{ REGISTER_DEVICE_ASSIGNMENT : has_history
    DEVICE ||--o{ REGISTER_DEVICE_ASSIGNMENT : has_history
```

The two parent relationships drawn to InventoryLocation express an exclusive-or invariant: each
location has exactly one parent, Branch or Warehouse, never both. The Register/Device assignment
relationships preserve sequential history; the recommended initial policy permits at most one
active assignment on either side.

Role-to-Permission and Branch-to-Brand are many-to-many conceptual relationships. Scope target
relationships represent explicit allowlisted roots. The entire-tenant scope has no individual
resource targets.

## Domain invariants beyond the diagram

- **CONFIRMED:** Future stock belongs to `Variant + InventoryLocation`, not SalesChannel.
- **CONFIRMED:** POS and ONLINE are origins in one future Order domain, not separate order models.
- **CONFIRMED:** Register is not Device; neither is an inventory owner.
- **CONFIRMED:** UserIdentity is global; Membership carries tenant participation.
- **CONFIRMED:** Permission is not Role, and AccessScope does not grant Permission.
