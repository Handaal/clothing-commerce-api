# ADR-034: Management API External Boundary

- Status: Accepted
- Date: 2026-08-30

## Context

Phase 2F establishes the first stable, authenticated **workforce management API** — the external HTTP
surface the `clothing-commerce-admin-mobile` client (business owner, authorized managers, stock/branch
managers) consumes. It is NOT a platform/super-admin console, a tenant-provisioning backoffice, a
billing surface, or a public customer/storefront API. Server-side RBAC remains authoritative: the API
must never trust a tenant header, client metadata, role name, or `service_role` as authorization.

## Decision

- **Frozen surface: seven read-only endpoints under `/api/v1`.** `GET /me/tenants`, `GET /me/context`,
  `GET /products`, `GET /products/{productId}`, `GET /inventory`, `GET /orders`,
  `GET /orders/{orderId}`. No mutation, fulfillment, organization-browsing, reporting, payment,
  reservation, return, purchasing, or customer endpoints. Order detail embeds fulfillment progress.
- **Task-oriented external DTOs.** DTOs are minimal, stable, and versionable — never a mechanical mirror
  of internal repositories. Raw DB rows, idempotency keys, payload fingerprints, authorization proofs,
  assignment-graph internals, `service_role` details, `InventoryOperation` internals, signed movement
  deltas, and private routing descriptors are never exposed.
- **One authentication flow for tenant routes.** Request → `ClerkRequestVerifier.verifyRequest` →
  `AuthorizationContextResolver.resolve({ request, requestedTenantId })` → active identity/membership/
  tenant + effective assignments → read service → tenant-filtered repository query. No second auth model
  is created.
- **Identity-only bootstrap for `/me/tenants`.** A dedicated `IdentityMembershipResolver` authenticates
  the identity WITHOUT tenant context and returns only that identity's own active memberships against
  active tenants. Its repository method is identity-bound (`findMembershipsForIdentity(identityId)`),
  never a caller-supplied id, "find all", or search.
- **Tenant selection via `X-Tenant-Id`.** Tenant routes require a present, UUID-valid `X-Tenant-Id`
  (missing/invalid → 400) passed to the existing resolver (no active membership → 403). Tenant is never
  derived from a Brand or other resource id.
- **Pure, domain-specific visibility derivation.** Catalog/inventory/orders read visibility is derived
  in trusted application code from the genuine `AuthorizationContext.assignments` — never a generic SQL
  authorization engine. A tenant-scope grant is tenant-wide; explicit grants union only the relevant
  exact target kinds (catalog→brand, inventory→inventory_location, orders→brand and/or branch). No
  hierarchy is inferred. `canRead` means "the endpoint has at least one usable read scope"; a
  wrong-kind-only scope yields `canRead=false`.
- **List authorization BEFORE pagination (hard invariant).** Every list query applies the tenant +
  visibility predicate BEFORE `ORDER BY`, the cursor condition, and `LIMIT`. The repository never
  fetches-then-filters and never authorizes rows individually.
- **Explicit-filter 404-then-403 sequence.** For `products?brandId`, `inventory?inventoryLocationId`,
  `orders?brandId`, and `orders?branchId`: validate → minimal tenant-contained existence lookup (miss →
  404 `RESOURCE_NOT_FOUND`) → authorize the confirmed in-tenant resource (out of scope / no permission → 403) → execute with the filter, still applying the visibility predicate before pagination.
- **Central route wrapper.** A single `runTenantManagementRoute` / `runIdentityManagementRoute` owns
  request-id generation, tenant-header parsing, context resolution, input/response validation, uniform
  error mapping, and response headers (`X-Request-Id`, `Cache-Control: no-store`, CORS). Route handlers
  contain no try/catch.
- **`catalog.read` provisioned, never granted.** One new permission is seeded (catalog seed only); no
  `RolePermission`, default grant, or owner bypass. `organization.read` is deliberately NOT added;
  organization names are only metadata for already-derived visibility.

## Consequences

- The admin-mobile client has a stable, least-privilege read surface. A branch manager can never read
  another branch, a brand manager never another brand, and POS/ONLINE order visibility never crosses.
- Adding a new endpoint or field is an explicit, reviewable contract change, not an accidental
  consequence of exposing an internal service.
- Mutations, dashboards, reservations, and payments remain out of scope for a later, separately reviewed
  phase.
