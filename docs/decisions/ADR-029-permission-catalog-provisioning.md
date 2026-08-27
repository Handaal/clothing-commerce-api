# ADR-029: Permission Catalog Provisioning

- Status: Accepted
- Date: 2026-08-25

## Context

`public.permissions` is a platform-global, immutable, non-secret capability contract keyed by a stable
text `key`. Earlier phases deliberately deferred seeding, so the inventory permission keys existed only
in application code and tests (`InventoryPermission`). Phase 2D adds order keys and will eventually have
Orders invoke Inventory, making an unseeded contract untenable.

## Decision

- Stable platform permission keys are **seeded by an idempotent migration**
  (`20260825180100_seed_platform_permissions.sql`) using `insert … on conflict (key) do nothing`. This
  reverses the earlier defer: the keys are part of the authorization contract and the schema should own
  them.
- The seed covers the existing inventory keys (`inventory.read/adjust/receive/issue/transfer`) and the
  new order keys (`orders.read/create/cancel`), each with a stable description.
- The seed **grants nothing to any Role** and creates no `role_permissions` row. Catalog provisioning is
  not the same act as granting; default role mappings remain out of scope. A test asserts the eight
  keys exist exactly once and that no role grants were created.

## Alternatives rejected

- **Keep keys only in code/tests:** a growing contract gap; future role governance cannot reference
  keys that do not exist.
- **Application bootstrap command:** adds a runtime step and ordering hazards for data that is part of
  the schema/authorization contract.
- **Seed default role→permission grants too:** tenant role design is separate; provisioning the catalog
  must not silently grant capabilities.
