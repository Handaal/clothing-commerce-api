# Operational Settings Core (Phase 2R-A)

Lets a real retailer operate V1 without a developer editing the database. It exposes the **existing**
organization/configuration tables through a hardened management surface. It is **not** a generic
settings engine and it does **not** redesign the organization model. The frozen mutation-safety
decisions live in [ADR-039](../decisions/ADR-039-operational-settings-mutation-safety.md); this
document is the surface reference.

## Architecture

```
/api/v1/settings/*  →  SettingsService (authorize settings.read | settings.manage; validate body)
                    →  SettingsRepository (tenant + actor from the proof; opaque cursor <-> keyset)
                    →  settings_private.* SECURITY DEFINER RPCs (owned by non-login settings_writer)
                    →  existing tables: tenants, brands, branches, branch_brands, warehouses,
                       inventory_locations, registers, devices, register_device_assignments,
                       storefront_checkout_settings, return_settings
```

`settings_writer` is `NOLOGIN NOBYPASSRLS`. Rather than reassign ownership of the foundational tables
(other writer roles already own or read them), it receives least-privilege DML grants plus a permissive
`FOR ALL` policy on each table it mutates — the exact precedent `offline_pos_writer` set for
`public.devices`. Clients never get direct DML: only the SECURITY DEFINER functions run as
`settings_writer`. Every function has an empty `search_path`, fully-qualified names, derives the tenant
from the caller-supplied verified id, and is idempotent through the single `settings_commands` ledger
(same `(tenant, key)` + intent replays the stored response; a changed intent conflicts with `ID409`).

## Permission model

One coherent tenant-wide pair: **`settings.read`** (list/detail) and **`settings.manage`** (mutations).
They are **independent** — neither implies the other. There is no scoped settings access in V1: a
brand/branch-scoped grant never confers tenant-wide settings, because the service authorizes with no
resource target and the shared authorizer then requires a permission-coupled **tenant-wide** grant.
Every request re-authorizes server-side. `getContext().access.settings` returns `{ canRead, canManage }`
as UI guidance only.

## Mutation-safety matrix

| Resource              | Freely mutable                                                                                                                                                                           | Immutable after creation                                       | Locked / guarded                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Business/Tenant**   | display_name, legal_name, contact_email, contact_phone, default_timezone, country_code, **tax_identifier**                                                                               | slug / normalized_slug, status                                 | **default_currency**: rejected once the tenant has any Order (same value is a no-op)                                                 |
| **Brand**             | display_name, legal_name; lifecycle status (active/inactive/archived)                                                                                                                    | **code**                                                       | never hard-deleted (lifecycle only)                                                                                                  |
| **Branch**            | display_name, timezone, address/contact fields, fulfillment flag, click-and-collect flag, **default_inventory_location** (same branch), **receipt_footer**, brand eligibility; lifecycle | **code**                                                       | default location must belong to the branch (composite FK); never hard-deleted                                                        |
| **Warehouse**         | display_name, timezone, address/contact fields, capability flags; lifecycle                                                                                                              | **code**                                                       | never hard-deleted                                                                                                                   |
| **InventoryLocation** | display_name, capability flags (sellable/fulfillment/receiving/transfer); lifecycle                                                                                                      | **branch_id XOR warehouse_id parent**, **location_type**, code | exactly one parent at creation; cannot lose capabilities required by an enabled Storefront or active Register                        |
| **Register**          | display_name, **default_inventory_location** (same branch), lifecycle                                                                                                                    | **branch_id**, **code**                                        | **selling_currency** locks after first POS Order; active requires an active Branch plus active, fulfillment-enabled default location |
| **Storefront**        | inventory_location_id, cod_enabled                                                                                                                                                       | (per-brand identity)                                           | **currency** locks after first ONLINE Order; COD-enabled requires active Brand plus active, sellable, fulfillment-enabled location   |
| **ReturnSettings**    | enabled, window_days, manual_refunds_enabled, max_manual_refund_minor, allowed_reasons                                                                                                   | —                                                              | hard integrity ceilings enforced by table CHECKs; editing never rewrites stored return policy snapshots                              |

Immutability is enforced by omitting the field from the update allowlist (`22023` on an attempt), by
composite foreign keys (`23503` for a cross-branch default location), and by not exposing any hard-delete
operation. Currency locks raise `SC409`. Codes are unique per tenant (`23505`).

Operational readiness is enforced in both directions. Enabling COD validates the same Tenant/Brand/
InventoryLocation state used by public checkout. Activating a Register validates the actual POS rule:
its Branch and default location must be active and the location must be fulfillment-enabled; POS does
not require `is_sellable`. A disabled Storefront or inactive Register may retain a non-operational
location. Once enabled/active, Settings rejects later Brand/Branch/location lifecycle or capability
changes that would invalidate the dependency. Device assignment remains identity governance and adds
no second readiness rule.

The API returns stable conflicts for Admin mapping: `STOREFRONT_LOCATION_NOT_OPERATIONAL`,
`STOREFRONT_DEPENDENCY_CONFLICT`, `REGISTER_LOCATION_NOT_OPERATIONAL`, and
`REGISTER_DEPENDENCY_CONFLICT`. SQL diagnostics are never returned to clients.

## Device governance boundary

Admin/API may **list** devices (identity, type, status, safe key-_metadata_, current Register
assignment, timestamps), **revoke** a device (ends any current assignment, marks it revoked), and
**assign/reassign** a device to a Register through the existing **append-only** interval model. Assigning
closes any open interval on either side first, preserving history and keeping at most one current
assignment per side (partial unique indexes are the backstop). **Device != Register** is preserved.

Never exposed or performed here: private-key/credential material, initial enrollment, key creation, and
credential rotation — those remain physical POS/device-side operations.

## Receipt / POS context identity

The canonical `GET /pos/context` is enriched with **server-owned** business identity for receipt
rendering (not a receipt template): top-level `business.tenant` (`displayName`, `legalName`,
`taxIdentifier`) and per-register `branch` (`displayName`, address/contact fields, `receiptFooter`). The
existing monetary sale facts are unchanged. New columns backing this: `tenants.tax_identifier` and
`branches.receipt_footer`.

## API surface

`business` (GET/PATCH); `brands` + `{brandId}`; `branches` + `{branchId}` + `{branchId}/brands` (PUT
eligibility); `warehouses` + `{warehouseId}`; `inventory-locations` + `{locationId}`; `registers` +
`{registerId}`; `storefront` (list) + `{brandId}` (GET/PUT upsert); `returns` (GET/PUT); `devices` +
`{deviceId}` + `{deviceId}/revoke` (POST) + `{deviceId}/assignment` (PUT). Lists use the shared opaque
keyset cursor; every mutation requires an `Idempotency-Key`. Full shapes: `openapi/openapi.json` (tag
`settings`) and SDK `0.14.0`.

Run `pnpm test:settings:persistence` for two clean migration cycles plus the Settings mutation-safety,
topology, reverse-dependency, idempotency, and private-schema privilege regressions. The online and
connected-POS integration suites prove the saved configurations at their runtime boundaries.

## Deferred configuration (not built)

Receipt templates/designers; theme settings; shipping engine; payment-gateway config; catalog-publication
duplication; scoped (per-brand/branch) settings authorization; role/scope/permission authoring; moving
deployment identity values (tenant/site ids) out of env; POS cash-drawer/session configuration.
