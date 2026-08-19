# Tenancy Model

## Purpose and status

This document freezes the conceptual tenancy boundary for Phase 1B. It is not a database or API
schema.

- **CONFIRMED:** The Platform is the SaaS system operated by the platform owner.
- **CONFIRMED:** A Tenant is one SaaS customer: the legal or operational organization whose
  commerce data is isolated from every other customer.
- **CONFIRMED:** Tenant and Brand are distinct. A tenant may operate one or many brands.

## Tenant identity and profile

The internal tenant identifier is immutable and is never derived from a slug, name, brand, or
identity-provider organization. The tenant profile conceptually contains:

| Concern                     | Decision                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slug                        | **RECOMMENDED:** Globally unique, human-readable routing key; mutable only through a controlled, audited operation. Never use it as a foreign key.              |
| Display name                | **RECOMMENDED:** Mutable customer-facing administrative name.                                                                                                   |
| Legal/business name         | **RECOMMENDED:** Optional until required by tax or contracting; kept separate from display name.                                                                |
| Operational status          | **RECOMMENDED:** Explicit lifecycle such as active, suspended, archived; independent of onboarding progress.                                                    |
| Onboarding state            | **RECOMMENDED:** Tracks setup progress without granting authority or implying operational status.                                                               |
| Defaults                    | **RECOMMENDED:** BCP 47 locale, IANA timezone, and ISO 4217 currency at tenant level, overridable only where the domain explicitly permits it.                  |
| Country                     | **RECOMMENDED:** Store the registered/primary country independently from postal addresses; it informs defaults but is not itself tax policy.                    |
| Contact information         | **RECOMMENDED:** Optional operational contact points, treated as mutable profile data rather than identity.                                                     |
| Tax configuration reference | **DEFERRED:** Reserve a relationship boundary; tax jurisdictions and calculation are outside Phase 1B. A country code is not a tax configuration.               |
| Subscription/plan reference | **DEFERRED:** Billing owns this concern. Do not put plan behavior into commerce authorization or domain rules.                                                  |
| Settings                    | **RECOMMENDED:** A tenant-owned settings boundary with typed, versioned settings rather than an ungoverned catch-all property bag. Exact settings are deferred. |

Locale, timezone, and currency changes affect presentation and future transaction defaults only.
They must never reinterpret historical financial records.

## Ownership boundary

**CONFIRMED:** Tenant-owned concepts include Brand, Branch, Warehouse, InventoryLocation,
Register, Device enrollment, Membership, Role, AccessScope, their tenant-owned relationship rows,
and future commerce records. These records carry direct tenant identity even where ownership could
also be reached through a parent.

**RECOMMENDED:** Platform-global concepts are UserIdentity and the Permission catalog. Platform
configuration and future role templates may also be global. A Membership connects a global
UserIdentity to one Tenant; it is the tenant-local authority boundary.

The Tenant record is platform-managed and represents the root of its data graph. A tenant does not
own another tenant. Server-side authorization and database policies must resolve an authenticated
request to an active membership and exact tenant before tenant data is accessed.

## Lifecycle

- **RECOMMENDED:** Provisioning/onboarding does not imply active access. Activation is explicit.
- **RECOMMENDED:** Suspension blocks tenant-scoped mutations and privileged client access
  immediately after authorization state is refreshed or invalidated. The precise treatment of
  public storefront reads is a future authorization-policy decision.
- **RECOMMENDED:** Archival is terminal for normal operation but preserves history. Restoration is
  an explicit, audited administrative operation if policy permits it.
- **CONFIRMED:** Once financial, inventory, staff, or audit history exists, hard deletion must not
  destroy that history. Exceptional privacy/legal erasure is a separately governed process, not a
  normal domain delete.
- **RECOMMENDED:** A never-activated, incorrectly provisioned tenant may be purged only by a
  privileged maintenance process after proving that it has no dependent business or audit history.

## Data isolation invariants

1. A request never selects tenant context from an untrusted ID alone.
2. Every tenant-owned relationship must prove that all referenced records have the same tenant.
3. Tenant suspension and membership suspension are independent checks.
4. Slug changes never change tenant identity or ownership.
5. Archived records remain tenant-owned and queryable for authorized historical workflows.

Detailed enforcement and indexing guidance is in
[tenant-isolation-strategy.md](./tenant-isolation-strategy.md).

## Open policy choices

- **HIGH — REQUIRES FOUNDER DECISION:** Decide, before public storefront authorization is designed,
  whether tenant suspension hides public catalog pages, permits read-only maintenance pages, or
  blocks every client response. This does not block foundational persistence.
- **MEDIUM — REQUIRES FOUNDER DECISION:** Define the customer-facing consequences and alias/redirect
  period for a tenant slug change before slugs appear in public URLs. Persistence should keep the
  internal identifier authoritative and can safely proceed.
