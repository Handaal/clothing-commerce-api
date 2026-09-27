# ADR-039: Operational settings mutation safety

**Status:** Accepted (Phase 2R-A)
**Related:** [operational settings core](../settings/operational-settings-core.md), ADR-036 (SDK)

## Context

V1 needs a real retailer to configure its business without a developer editing the database. The
underlying organization/config tables already exist. The risk is that a generic "settings" surface
quietly breaks frozen domain invariants (Tenant != Brand, Branch != Warehouse, InventoryLocation !=
Register, Device != Register) or lets identifiers/currencies change after commercial history exists.

## Decision

Expose the existing tables through a hardened, tenant-wide management surface — not a generic settings
engine, and without redesigning the organization model. The following are **frozen**:

1. **Permissions.** One coherent pair, `settings.read` and `settings.manage`, tenant-wide only and
   mutually independent. No scoped settings access; a brand/branch grant never confers it. `/me/context`
   exposes `access.settings { canRead, canManage }` as guidance only.
2. **Placement.** `tenants.tax_identifier` (business tax id) and `branches.receipt_footer` (receipt
   footer line). No receipt templates.
3. **Immutable identifiers/relationships.** brand/branch/warehouse/register `code`; an
   InventoryLocation's `branch_id XOR warehouse_id` parent and its `location_type`. Never re-parented.
4. **Currency locks.** `tenants.default_currency` is mutable only until the tenant has any Order;
   `registers.selling_currency` only until the register's first POS Order; a storefront's `currency`
   only until the brand's first ONLINE Order. The same value is always an accepted no-op.
5. **No destructive deletion** of commercial organization entities: lifecycle
   activate/deactivate/archive only. Brand↔branch eligibility (`branch_brands`) is the only
   replace-in-place association set.
6. **Device governance.** Admin/API may list/revoke devices and manage the append-only Register/Device
   assignment intervals; enrollment, private-key generation, and key rotation stay device-side. No key
   material is ever exposed.

## Enforcement

Server-side, in SECURITY DEFINER RPCs owned by a NOLOGIN NOBYPASSRLS `settings_writer` (least-privilege
DML grants + `FOR ALL` policies, mirroring `offline_pos_writer`; empty `search_path`; fully-qualified
names). Immutability = field omitted from the update allowlist (`22023`) or a composite FK (`23503`);
currency locks raise `SC409`; idempotency via the `settings_commands` ledger (`ID409` on intent change).
Proven by `pnpm test:settings:persistence` (52 assertions, twice from empty).

## Consequences

Configuration is safe by construction and the domain invariants cannot be collapsed. Scoped settings,
role/permission authoring, receipt templating, and POS cash-drawer/session config remain deferred.
