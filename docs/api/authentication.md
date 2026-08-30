# Management API authentication

## Tenant-scoped routes

Tenant-scoped management routes resolve authorization through the existing, single auth model:

```
Request
→ ClerkRequestVerifier.verifyRequest            (verified provider + subject, else 401)
→ AuthorizationContextResolver.resolve({ request, requestedTenantId })
     → exactly one active provider binding
     → active UserIdentity
     → active Membership in the requested tenant
     → active Tenant
     → effective assignments
→ AuthorizationContext
→ read service → AuthorizationService → tenant-filtered repository query
```

No second auth model exists. A tenant header, client metadata (`X-Client-Type`/`X-Client-Version`),
role name, or `service_role` is **never** trusted as authorization.

### `X-Tenant-Id`

Tenant-scoped routes require the `X-Tenant-Id` header:

- missing or not a UUID → **400**
- valid UUID but the caller has no active membership in that tenant → **403**

The tenant is never derived from a Brand, Order, or other resource id.

## Identity-only bootstrap: `GET /me/tenants`

`GET /me/tenants` does **not** require `X-Tenant-Id`. It uses a dedicated, narrow bootstrap boundary
(`IdentityMembershipResolver`) that authenticates the identity without any tenant context:

```
Request
→ Clerk verifies the session (else 401)
→ provider + subject
→ exactly one active provider binding
→ active UserIdentity
→ memberships belonging ONLY to that identity (findMembershipsForIdentity(identityId))
→ active memberships only
→ active/non-suspended tenant summaries
```

Behavior: unauthenticated → 401; valid identity with zero active memberships → `200 []`; one → one row;
multiple → multiple rows; an inactive membership or a non-active tenant is excluded.

This endpoint is an **identity-scoped bootstrap**, NOT tenant/admin enumeration. It returns only the
verified caller's own active memberships and selectable active tenants, and never another identity's
data. There is no caller-supplied identity id anywhere in its path; a dedicated cross-identity/no-leak
test enforces this.

## Client metadata has no authorization effect

`X-Client-Type` and `X-Client-Version` are recorded/forwarded metadata only. They never influence
authentication, authorization, visibility, or status codes.

## Request id

A fresh UUID is generated server-side for every management request, returned as `X-Request-Id`, and
echoed as `error.requestId` on failures. Inbound `X-Request-Id` is never trusted.
