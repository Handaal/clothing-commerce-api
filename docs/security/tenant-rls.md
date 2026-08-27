# Tenant Isolation and Row-Level Security

## Purpose and boundary

Phase 1C-B adds PostgreSQL row-level security (RLS) as the database backstop for the foundational
schema. RLS behaves like a mandatory row predicate for non-bypass database roles: a query can only
see or affect rows accepted by a policy. The platform deliberately retains two layers:

```text
Application authorization (implemented in Phase 1D)
                +
PostgreSQL tenant RLS (Phase 1C-B)
```

RLS does not decide business permissions, invitation workflows, protected-role governance, or
AccessScope coverage. Phase 1D application services enforce the implemented staff foundation;
workflow-specific business decisions remain later work.

The implementation is owned by the append-only Phase 1C-B migrations in
`supabase/migrations/`. Security integration tests live in
`supabase/tests/phase_1c_b_tenant_rls.test.sql` and run through the repository-pinned Supabase CLI.

## Request-context trust boundary

An authenticated database request supplies two top-level JWT claims signed by a trusted issuer:

- `user_identity_id`: the provider-neutral platform UserIdentity UUID;
- `tenant_id`: the exact Tenant UUID selected for this request.

The values are selectors, not authority by themselves. `commerce_context.current_membership_id()`
looks up the exact `(tenant_id, user_identity_id)` relationship and returns a Membership only when
its status is `active`. Policies require that validated Membership before tenant or catalog rows are
visible. No policy selects the first membership for a user, so one person can switch explicitly
between valid Tenant contexts without combining their data.

The database verifies that the Tenant selector is a UUID, the UserIdentity selector is a UUID, and
the exact pair has an active Membership. **It does not independently prove that the claimed
`user_identity_id` belongs to the external identity-provider subject who authenticated.** That
identity-provenance guarantee is supplied by the Phase 1D trusted authentication/application
boundary.

Phase 1D verifies the external provider subject, maps that subject server-side through the provider
binding to the internal UserIdentity, and validates the selected Tenant. Any future claim issuance
must occur only after this boundary. Never populate these top-level claims from user-editable
identity metadata.
Never treat client headers, URL values, request bodies, or other client-provided UserIdentity/Tenant
values as authority. Signed claims must come from an approved trusted issuer. Local tests simulate
the PostgREST request setting directly; this is test infrastructure, not a client-controlled
production API.

Missing claims, malformed JSON, invalid UUID text, unknown Tenant IDs, and inactive Memberships all
resolve to no context and therefore no rows. The functions also require PostgreSQL `current_user`
to be `authenticated`, so merely writing claim-shaped session text under `anon` does not create an
authenticated request.

## Threat model

| Threat                                             | Phase 1C-B treatment                                                                                     | Remaining responsibility                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Claimed UserIdentity differs from provider subject | Database requires a trusted signed UUID claim but cannot prove its external provenance                   | Phase 1D maps the verified provider subject server-side      |
| Tenant A reads Tenant B rows                       | Tenant-owned SELECT policies require exact validated Tenant context                                      | Application queries must still carry explicit tenant context |
| Tenant A inserts a Tenant B ID                     | Authenticated users have no direct mutation grants or mutation policies                                  | Phase 1D services authorize privileged writes                |
| Updating a row into another Tenant                 | No authenticated UPDATE policy; composite FKs remain a second barrier                                    | Service code validates every referenced resource             |
| Deleting Tenant B or own history                   | No authenticated DELETE policy                                                                           | Governed maintenance and lifecycle services only             |
| Direct UUID probing                                | Known foreign UUIDs remain invisible under row predicates                                                | HTTP responses must avoid existence leaks                    |
| Manipulated AccessScope target IDs                 | Tenant policies hide foreign targets; composite FKs reject mismatches                                    | Permission/scope evaluation is Phase 1D                      |
| Invited, suspended, or deactivated Membership      | Only `active` Membership resolves request context                                                        | Invitation and lifecycle workflows are Phase 1D              |
| Missing, malformed, or invalid context             | Context functions return `NULL`; policies fail closed                                                    | API must reject malformed authentication earlier             |
| Role/assignment exposure                           | Only current-Tenant rows are readable; MembershipRoleAssignment is self-only                             | Staff-management views and permissions are Phase 1D          |
| Global UserIdentity enumeration                    | A user can read only their own identity in an active Tenant context                                      | Administrative identity lookup remains server-only           |
| Provider-subject exposure                          | No authenticated SELECT grant or policy                                                                  | Provider linking remains Phase 1D/server-only                |
| Permission-catalog mutation                        | Active members may read the catalog; all authenticated mutations are denied                              | Catalog governance remains platform-server-only              |
| Association/history leakage                        | Every association/history table has its own Tenant predicate                                             | Application permission checks may narrow further             |
| Service-role bypass                                | Explicitly documented and tested as a privileged boundary                                                | Every bypassing server operation must authorize tenant scope |
| `SECURITY DEFINER` privilege escalation            | No Phase 1C-B helper uses `SECURITY DEFINER`                                                             | Future functions require separate security review            |
| Policy recursion                                   | Membership policy uses claims directly; helper lookup traverses that non-recursive policy                | Tests guard helper behavior and all policy presence          |
| Unsafe joins                                       | RLS applies to each directly queried table; tenant-safe composite FKs prevent cross-tenant relationships | Query authors must not use bypass roles casually             |

Tenant operational suspension and global UserIdentity lifecycle are enforced by Phase 1D
application authorization. Token issuance/refresh and public storefront behavior remain later
concerns. Active Membership is the Phase 1C-B eligibility rule.

## Context helper functions

The `commerce_context` schema is not exposed through the Data API. It contains five small `STABLE`,
`SECURITY INVOKER` functions with an empty fixed `search_path`:

- `claim_uuid(name)` safely parses one UUID claim and returns `NULL` on malformed input;
- `current_user_identity_id()` reads `user_identity_id` only for the `authenticated` database role;
- `current_tenant_id()` reads `tenant_id` only for the `authenticated` database role;
- `current_membership_id()` derives the active Membership for the exact two claims;
- `has_active_membership()` is the boolean policy predicate.

The Membership lookup uses the existing unique index on `(tenant_id, user_identity_id)`. Adding
`status` to a second index would be redundant because at most one row can match those two leading
columns. No speculative policy index is added.

Only the Supabase `authenticated` role receives schema/function use. The fast PostgreSQL runner
creates non-login role fixtures before applying migrations so explicit Supabase policy targets can
be constructed without pretending to test Supabase authentication behavior.

## Table policy matrix

All 18 foundational tables and all 11 Phase 2A catalog tables have RLS enabled. The foundational
17 SELECT policies and catalog 11 SELECT policies explicitly target `authenticated`, rather than
targeting `PUBLIC` and repeating a database-role predicate. RLS is not forced because
migrations, backups, maintenance, and the Supabase service role require an explicit privileged
path; `FORCE ROW LEVEL SECURITY` would not constrain roles with `BYPASSRLS` in any case.

| Table                             | Authenticated SELECT                         | INSERT | UPDATE | DELETE | Reason                                    |
| --------------------------------- | -------------------------------------------- | ------ | ------ | ------ | ----------------------------------------- |
| `tenants`                         | Selected Tenant with active Membership       | Denied | Denied | Denied | Tenant is platform-managed                |
| `brands`                          | Current Tenant                               | Denied | Denied | Denied | Foundational organization read            |
| `branches`                        | Current Tenant                               | Denied | Denied | Denied | Foundational organization read            |
| `warehouses`                      | Current Tenant                               | Denied | Denied | Denied | Foundational organization read            |
| `branch_brands`                   | Current Tenant                               | Denied | Denied | Denied | Association cannot leak across tenants    |
| `inventory_locations`             | Current Tenant                               | Denied | Denied | Denied | Shared physical inventory context         |
| `registers`                       | Current Tenant                               | Denied | Denied | Denied | Checkout context, not direct mutation API |
| `user_identities`                 | Own identity only, with active Membership    | Denied | Denied | Denied | Prevent global identity enumeration       |
| `user_identity_provider_bindings` | Denied                                       | Denied | Denied | Denied | Provider subjects remain server-only      |
| `memberships`                     | Own active Membership only                   | Denied | Denied | Denied | Staff administration is deferred          |
| `roles`                           | Current Tenant                               | Denied | Denied | Denied | Stored authorization input only           |
| `permissions`                     | Full platform catalog with active Membership | Denied | Denied | Denied | Non-secret stable capabilities            |
| `role_permissions`                | Current Tenant                               | Denied | Denied | Denied | What a tenant Role contains               |
| `access_scopes`                   | Current Tenant                               | Denied | Denied | Denied | Scope definitions, not evaluation         |
| `access_scope_targets`            | Current Tenant                               | Denied | Denied | Denied | Explicit target relationships             |
| `membership_role_assignments`     | Current Membership only                      | Denied | Denied | Denied | Avoid other-staff assignment disclosure   |
| `devices`                         | Current Tenant                               | Denied | Denied | Denied | Enrollment metadata remains tenant-bound  |
| `register_device_assignments`     | Current Tenant                               | Denied | Denied | Denied | Assignment history remains tenant-bound   |

Every catalog table below uses the same current-Tenant plus active-Membership SELECT predicate.
Association rows carry direct `tenant_id`, so policy evaluation never relies on joining through a
parent. Ordinary authenticated INSERT, UPDATE, and DELETE remain denied on every table.

| Catalog tables                                                      | Authenticated SELECT | INSERT | UPDATE | DELETE |
| ------------------------------------------------------------------- | -------------------- | ------ | ------ | ------ |
| `products`, `product_variants`, `variant_barcodes`                  | Current Tenant       | Denied | Denied | Denied |
| `product_options`, `product_option_values`, `variant_option_values` | Current Tenant       | Denied | Denied | Denied |
| `categories`, `product_categories`                                  | Current Tenant       | Denied | Denied | Denied |
| `collections`, `product_collections`                                | Current Tenant       | Denied | Denied | Denied |
| `variant_prices`                                                    | Current Tenant       | Denied | Denied | Denied |

Authenticated mutation denial is intentional. Platform clients are designed to call the central
Commerce API. Phase 1D adds the authorization foundation but no lifecycle or administrative write
service. RLS must not accidentally turn direct Data API access into an unreviewed
write API.

## Phase 2D order tables

`orders`, `order_lines`, and `order_number_sequences` take a **deliberately stricter** stance than the
catalog/inventory tables: they have RLS enabled (not forced) with **zero policies**, so `anon` and
`authenticated` have no direct access at all — there is no tenant-wide authenticated SELECT backstop.
Orders are commercially sensitive and will later carry customer-related data, and every order read flows
through the server-side application repository, so a direct authenticated Data API path has no
legitimate consumer and could bypass the application's brand/branch scope semantics. `service_role`
holds `SELECT` on `orders`/`order_lines` (none on `order_number_sequences`) and `EXECUTE` on the
sanctioned `orders_private` functions only — it has no direct DML. All writes run as the non-login
`orders_writer` role inside the SECURITY DEFINER functions, mirroring the Phase 2B/2C inventory
boundary. The `orders_private` schema is exposed to PostgREST for the service-role RPC calls; the
function EXECUTE grants, not schema exposure, are the boundary. Future storefront customer access must
use a controlled application API, never broadened `anon`/`authenticated` policies.

## Global-table decisions

`user_identities` is self-readable only after active Membership validation in the selected Tenant.
This supports identity display without making the platform directory enumerable.

`user_identity_provider_bindings` is completely unavailable to normal authenticated access. A
provider subject is sensitive linkage metadata and is not required for tenant operation.

`permissions` is readable as a platform catalog by an active member. Its columns are stable
capability metadata, not credentials. Tenant users cannot create, edit, deprecate, or delete catalog
entries.

## AccessScope decision

**AccessScope enforcement is an application responsibility implemented in Phase 1D.** Phase 1C-B
protects the outer Tenant boundary
and narrows personal identity/assignment tables, but it does not infer branch, warehouse, brand, or
InventoryLocation authorization. Full scope enforcement requires Permission evaluation and the
approved operation-specific resource semantics. Implementing only part of that evaluator in RLS
would create ambiguous or recursive policy behavior.

Consequently, any active member currently receives the table-specific tenant-contained
foundational configuration reads shown above, even when a future AccessScope would be narrower.
Phase 1D enforces exact Tenant, Brand, Branch, Warehouse, and InventoryLocation scope for each
operation before privileged business data access.

## Service-role and owner behavior

Supabase `service_role` receives explicit foundational-table DML privileges and, because it has
`BYPASSRLS`, can bypass these policies. PostgreSQL table owners also bypass non-forced RLS. This is
necessary for migrations and controlled server/maintenance operations, but it is not authorization.
Service/secret keys must stay server-side, and every API or job using privileged access must
independently validate UserIdentity, Tenant, Membership, Permission, AccessScope, and resource
ownership.

The local tests use the privileged `postgres` role only to create fixtures and temporarily inspect
metadata. Behavior under the actual Supabase `authenticated` and `anon` roles is tested separately.
No production or cloud credential is stored or required.

## Safe modification and testing

Policy changes must be append-only migrations. Review every table and operation separately; pair
`USING` and `WITH CHECK` for any future mutation, and add rejection tests before granting it. Avoid
helpers that query a table whose policy calls the same helper. A future `SECURITY DEFINER` function
requires a fixed empty `search_path`, narrow ownership, explicit execute grants, and adversarial
tests.

Run:

```powershell
pnpm test:persistence
pnpm test:catalog:persistence
pnpm test:rls
pnpm test:catalog:rls
```

The persistence commands check portable foundational and catalog structure. The RLS commands
verify the approved 87- and 43-assertion plans, reset the supported local Supabase stack, execute
pgTAP policy tests as Supabase roles, and remove disposable local data. Operational setup and
troubleshooting are documented in
[Supabase local development](../development/supabase-local.md).

## Phase 1D closure and remaining limitations

Phase 1C-B itself does not perform application authorization. Phase 1D now verifies Clerk staff
sessions, maps provider bindings, enforces UserIdentity/Membership/Tenant lifecycle, evaluates
Permission and assignment-coupled exact AccessScope, validates resource Tenant ownership, and gates
privileged operation callbacks. Phase 2A now adds catalog persistence, but there is still no
protected public catalog data API or catalog mutation service.

The Phase 1D foundation closes the former security gates as follows:

1. **Identity provenance:** a verified Clerk subject maps through the server-only provider binding;
   no client internal identity is accepted.
2. **Tenant selection:** context is issued only after proving the exact active Membership.
3. **Permission authorization:** application services evaluate Permission keys, never Role names.
4. **AccessScope:** exact target semantics are implemented with assignment coupling.
5. **Tenant suspension:** staff/admin authorization fails closed.
6. **UserIdentity lifecycle:** suspended/deactivated identities fail closed globally.
7. **Device revocation:** trusted Device context fails closed when revoked; credential and offline
   behavior remain later work.
8. **Privileged mutations:** the proof boundary validates identity, Tenant, Membership, Permission,
   AccessScope, and target ownership before a privileged operation callback.
9. **Token freshness/revocation:** current database state is loaded on every request with no
   authorization cache or Role/scope token claims.

Invitation/provisioning, provider lifecycle webhooks, high-risk delegation, audit storage,
business operations, customer auth, and offline POS security remain unimplemented. See
[Identity and application authorization](identity-and-authorization.md).

See [ADR-009](../decisions/ADR-009-tenant-isolation-strategy.md), the
[tenant isolation strategy](../architecture/tenant-isolation-strategy.md), and the
[identity/membership model](../architecture/identity-membership-role-scope-model.md) for the
authoritative layered architecture.
