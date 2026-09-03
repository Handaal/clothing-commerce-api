# Management API

The management API is the first stable, authenticated **workforce** API. Its first consumer is
`clothing-commerce-admin-mobile` (business owner, authorized managers, stock/branch managers). It is not
a platform/super-admin console, a tenant-provisioning backoffice, a billing surface, or a public
customer/storefront API. Server-side RBAC is authoritative; a tenant header, client metadata, role name,
or `service_role` is never treated as authorization.

Phase 2F-A shipped a **read-only** boundary. Phase 2G adds the first **inventory write** operations
(receive, adjust, transfer) on top of the same boundary, delegating to the existing Phase 2C inventory
application service. See [ADR-034](../decisions/ADR-034-management-api-external-boundary.md) and
[inventory-operations.md](../inventory/inventory-operations.md).

## Endpoints (frozen surface)

All endpoints live under `/api/v1`.

| Method & path                 | Tenant header | Idempotency-Key | Permission           | Description                                                           |
| ----------------------------- | ------------- | --------------- | -------------------- | --------------------------------------------------------------------- |
| `GET /me/tenants`             | no            | no              | none (identity only) | The caller's own selectable active tenants.                           |
| `GET /me/context`             | yes           | no              | derived              | The caller's effective read capability for the tenant.                |
| `GET /products`               | yes           | no              | `catalog.read`       | Paginated product summaries in the caller's brand scope.              |
| `GET /products/{productId}`   | yes           | no              | `catalog.read`       | One product's detail (variants, options, prices).                     |
| `GET /inventory`              | yes           | no              | `inventory.read`     | Paginated balances in the caller's location scope.                    |
| `POST /inventory/receipts`    | yes           | yes             | `inventory.receive`  | Receive stock into one location.                                      |
| `POST /inventory/adjustments` | yes           | yes             | `inventory.adjust`   | Reconcile a counted on-hand (version-guarded).                        |
| `POST /inventory/transfers`   | yes           | yes             | `inventory.transfer` | Move stock between two locations (source **and** destination scoped). |
| `GET /orders`                 | yes           | no              | `orders.read`        | Paginated order summaries in the caller's brand/branch scope.         |
| `GET /orders/{orderId}`       | yes           | no              | `orders.read`        | One order's detail with embedded fulfillment progress.                |

Opening-stock and generic issue are intentionally **not** exposed: opening stock is an
initialization-only primitive (the domain forbids re-opening after activity, and routine initial counts
go through adjust), and generic issue has no reason/audit model — the sanctioned depletion path is order
fulfillment. There are no catalog, orders, fulfillment, organization-browsing, reporting/dashboard,
payment, reservation, return, purchasing, or customer write endpoints in this phase.

## Inventory writes and idempotency

Each write authorizes its permission against the target inventory location(s) through the existing
authorization service, then delegates to the Phase 2C inventory service; no inventory SQL or business
rule lives in the HTTP layer. Transfer authorizes **both** the source and the destination location
independently — access to the source never implies permission over an arbitrary destination.

Every write **requires** an `Idempotency-Key` header (1–200 chars). The mechanism is enforced in the
database: replaying the same key with the same body returns the original result without re-applying the
mutation, and reusing the same key with a **different** body is rejected with `409 IDEMPOTENCY_CONFLICT`.
An adjustment additionally carries `expectedVersion`; a stale version is `409 CONCURRENT_MODIFICATION`
rather than a blind overwrite. Insufficient source stock on a transfer is `409 INSUFFICIENT_STOCK`.

### Inventory read version (Adjust flow)

Every `GET /inventory` row carries `version`, the authoritative optimistic-concurrency token of the
persisted balance (0 for a variant/location with no history). This is the value an adjustment guards
against, so a fresh read is self-sufficient for the safe recount flow:

1. `GET /inventory` → authoritative `onHand` **and** `version`.
2. `POST /inventory/adjustments` with `countedQuantity` + that `expectedVersion`.
3. On `409 CONCURRENT_MODIFICATION`, re-`GET /inventory` to obtain the newer `version`, require user
   reconfirmation, and retry.

The version is read straight from the balance row — it is never client-manufactured, derived from
`onHand`, or carried over from a previous mutation response.

## Authentication and tenant selection

See [authentication.md](authentication.md). Tenant-scoped routes require a present, UUID-valid
`X-Tenant-Id`. Missing/invalid → 400; a valid tenant the caller has no active membership in → 403.

`GET /me/tenants` is an **identity-scoped bootstrap**: it requires only a valid session (no
`X-Tenant-Id`) and returns solely the verified caller's own active memberships against active tenants.
It is NOT tenant/admin enumeration and never returns another identity's memberships.

## Visibility semantics

Read visibility is derived purely from the verified `AuthorizationContext` assignments. There is no
hierarchy inference and no generic SQL authorization engine.

- **Tenant-scope grant** → `tenantWide = true`, `canRead = true`.
- **Explicit grant with ≥1 relevant target** → `tenantWide = false`, `canRead = true`, ids = union of
  relevant exact targets.
- **Explicit grant with only wrong-kind targets** → `canRead = false`, empty id arrays.
- **No grant** → `canRead = false`.

Relevant target kinds: `catalog.read` → brand; `inventory.read` → inventory_location; `orders.read` →
brand and/or branch. Examples that yield `canRead=false`: `orders.read` only against a warehouse;
`catalog.read` only against a branch; `inventory.read` only against a brand.

`canRead` is an **endpoint-usable capability**, not "an assignment exists". A wrong-kind-only scope
produces `canRead=false` and an empty list (200), not a 403. Lacking the permission entirely on a list
endpoint is 403.

### List authorization happens before pagination

Every list query applies the tenant + visibility predicate **before** `ORDER BY`, the cursor condition,
and `LIMIT`. The service never fetches a page and then filters, and never authorizes rows one by one.

- Catalog: tenant-wide → `WHERE tenant_id = T`; explicit → `AND brand_id IN (authorized brands)`.
- Inventory: tenant-wide → `WHERE tenant_id = T`; explicit → `AND inventory_location_id IN (authorized)`.
- Orders: tenant-wide → `WHERE tenant_id = T`; explicit →
  `AND ((channel='online' AND brand_id IN authorizedBrands) OR (channel='pos' AND branch_id IN authorizedBranches))`.
  A Branch grant never implies Brand visibility, and a Brand grant never implies POS Branch visibility.

### Explicit filters: 404 vs 403

For `products?brandId`, `inventory?inventoryLocationId`, `orders?brandId`, `orders?branchId`: a
foreign/nonexistent resource is **404** (tenant-contained existence lookup miss), and an in-tenant but
out-of-scope resource is **403**. The visibility predicate still applies before pagination.

## `GET /me/context`

Returns a permission-specific context. `canRead`/`tenantWide` per endpoint, plus hydrated names for the
resources the caller's effective access already covers (all tenant resources when tenant-wide, only the
authorized ids when explicit). It never returns raw `RolePermission`, `AccessScope`, permission keys, or
scope targets.

### Inventory write capability (`access.inventory.write`)

`access.inventory.write` lets the Mobile client decide which write actions and locations to offer
**before** submitting, instead of discovering permission through a `403` after the fact. It reports
top-level `canReceive` / `canAdjust` / `canTransfer` plus a per-location `locations[]` with
`canReceive`, `canAdjust`, `canTransferOrigin`, and `canTransferDestination`.

Each flag is **server-derived** by combining three facts, exactly as the mutation path authorizes them:

- **permission** — the caller holds `inventory.receive` / `inventory.adjust` / `inventory.transfer`;
- **authorization scope** — that grant is tenant-wide, or explicitly targets the location (a scoped
  caller is never shown a location outside its scope);
- **location operational capability** — the location's status and capability flags permit the op
  (receive → receiving-enabled + active; adjust → not archived; transfer origin → origin-enabled + not
  archived; transfer destination → destination-enabled + active).

Transfer is split into origin vs destination because the two are governed by independent location
flags; top-level `canTransfer` is true only when a valid origin and a **distinct** valid destination
both exist (a single location cannot transfer to itself).

**This block is UX guidance ONLY.** It never grants access: every `POST` route performs the full
server-side authorization independently and no mutation relies on the context result. There is no
owner/admin bypass.

## Pagination, serialization, and errors

See [pagination.md](pagination.md), [serialization.md](serialization.md), and [errors.md](errors.md).

## OpenAPI

`openapi/openapi.json` is generated from the Zod contracts (`pnpm openapi:generate`) and checked by
`pnpm test:openapi`. It declares a Clerk bearer security scheme, places `X-Tenant-Id` on tenant-scoped
routes only (never on `/health` or `/me/tenants`), places the required `Idempotency-Key` header on the
inventory write operations only, and reuses `ApiError`, `PageInfo`, and the management DTO schemas. No
private RPCs or functions appear in the document.

## SDK

The packed SDK (`@shifted/clothing-commerce-sdk`) `0.3.0` adds the typed tenant-scoped write methods
`receiveInventory`, `adjustInventory`, and `transferInventory`. Each takes an explicit `idempotencyKey`
which the SDK sends as the `Idempotency-Key` header (never in the body). The tenant header remains
SDK-owned and the auth token remains supplied by the caller's token provider.

`0.3.1` is an additive client-contract patch (no new methods, no breaking changes): the inventory list
row now carries `version`, and `getContext()` returns `access.inventory.write` — both flow through the
existing `listInventory` and `getContext` methods via their shared contract types.

## Local validation

The inventory write boundary has a dedicated integration suite that exercises the real HTTP handlers
against a freshly reset local database with a disposable fixture:
`pnpm test:inventory:write:integration` (requires Docker + local Supabase). It proves once-only
application, safe replay, conflicting-replay rejection, authorization/scope enforcement, and tenant
isolation.
