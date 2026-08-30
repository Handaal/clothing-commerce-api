# Management API

The management API is the first stable, authenticated **workforce** API. Its first consumer is
`clothing-commerce-admin-mobile` (business owner, authorized managers, stock/branch managers). It is not
a platform/super-admin console, a tenant-provisioning backoffice, a billing surface, or a public
customer/storefront API. Server-side RBAC is authoritative; a tenant header, client metadata, role name,
or `service_role` is never treated as authorization.

Phase 2F-A is **read-only**. See [ADR-034](../decisions/ADR-034-management-api-external-boundary.md).

## Endpoints (frozen surface)

All endpoints live under `/api/v1`.

| Method & path               | Tenant header | Permission           | Description                                                   |
| --------------------------- | ------------- | -------------------- | ------------------------------------------------------------- |
| `GET /me/tenants`           | no            | none (identity only) | The caller's own selectable active tenants.                   |
| `GET /me/context`           | yes           | derived              | The caller's effective read capability for the tenant.        |
| `GET /products`             | yes           | `catalog.read`       | Paginated product summaries in the caller's brand scope.      |
| `GET /products/{productId}` | yes           | `catalog.read`       | One product's detail (variants, options, prices).             |
| `GET /inventory`            | yes           | `inventory.read`     | Paginated balances in the caller's location scope.            |
| `GET /orders`               | yes           | `orders.read`        | Paginated order summaries in the caller's brand/branch scope. |
| `GET /orders/{orderId}`     | yes           | `orders.read`        | One order's detail with embedded fulfillment progress.        |

There are no mutation, fulfillment, organization-browsing, reporting/dashboard, payment, reservation,
return, purchasing, or customer endpoints in this phase.

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

## Pagination, serialization, and errors

See [pagination.md](pagination.md), [serialization.md](serialization.md), and [errors.md](errors.md).

## OpenAPI

`openapi/openapi.json` is generated from the Zod contracts (`pnpm openapi:generate`) and checked by
`pnpm test:openapi`. It declares a Clerk bearer security scheme, places `X-Tenant-Id` on tenant-scoped
routes only (never on `/health` or `/me/tenants`), and reuses `ApiError`, `PageInfo`, and the management
DTO schemas. No private RPCs or functions appear in the document.
