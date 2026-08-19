# Phase 1C Migration Readiness

## Gate summary

Phase 1B fixes the foundational meanings and safety invariants needed to design persistence. Phase
1C may translate them into reviewed, append-only migrations but must not treat this document as SQL.

## 1. Expected foundational persistence entities

**RECOMMENDED:** Tenant, Brand, Branch, BranchBrand association, Warehouse, InventoryLocation,
Register, Device, RegisterDeviceAssignment history, UserIdentity, external identity-provider
binding, Membership, Permission, Role, RolePermission, AccessScope, AccessScopeTarget, and
MembershipRoleAssignment.

Audit-event persistence may be included only after its actor/retention/security design is reviewed.
Storefront, product, variant, quantity, movement ledger, session, order, customer, fulfillment,
payment, and billing entities are outside this gate.

## 2. Relationships and cardinalities

- Platform has many Tenants; Tenant owns zero or many of each optional organizational capability.
- Tenant has many Brands, Branches, Warehouses, Devices, Memberships, Roles, and AccessScopes.
- Brand and Branch are many-to-many through explicit support eligibility.
- Branch and Warehouse each contain many InventoryLocations; every InventoryLocation has exactly
  one of those parent kinds.
- Branch contains many Registers; each Register belongs to one Branch and selects one valid default
  branch InventoryLocation while operational.
- Register and Device assignments are many over time, with at most one active assignment on each
  side under the initial policy.
- UserIdentity has memberships in zero or many Tenants; one current Membership represents each
  Tenant/UserIdentity relationship.
- Role and Permission are many-to-many. Membership, Role, and AccessScope meet in a role assignment.
- An AccessScope is either tenant-wide or has many explicit target resources.

## 3. Identifier rules

- UUIDv7 internal IDs, generated at the authoritative creation boundary.
- IDs are immutable and may be exposed as opaque API references.
- Business codes/slugs are separate, normalized human identifiers.
- Client-generated future offline IDs and command/idempotency IDs are validated, not trusted.

## 4. Uniqueness rules

- Tenant slug, Permission name, provider-plus-subject binding, and Device installation ID have
  global uniqueness boundaries.
- Brand, Branch, Warehouse, and InventoryLocation codes are unique within Tenant.
- Register code is unique within Branch.
- Role name is unique within Tenant.
- Current Membership is unique by Tenant plus UserIdentity.
- All code/name uniqueness includes archived rows; business identifiers are not reused.

## 5. Lifecycle rules

Use explicit status plus archive/revocation metadata, not routine hard delete. Parent archive blocks
new use and requires dependent-state validation; it does not cascade-delete, silently move stock,
or rewrite history. Revoked Devices and deactivated Memberships fail closed. After business history
exists, normal hard deletion is prohibited.

## 6. Tenant ownership

Brand, Branch, Warehouse, InventoryLocation, Register, Device, Membership, Role, AccessScope, and
all tenant-owned joins/assignments carry direct tenant identity. Tenant is the root. UserIdentity
and Permission are platform-global. Cross-tenant relationship construction is prohibited even when
individual IDs exist.

## 7. Security expectations

- Server resolves verified UserIdentity, exact Tenant, active Membership, Permission, AccessScope,
  and resource ownership.
- Tenant predicates exist at application/data-access boundaries.
- PostgreSQL RLS is deny-by-default on tenant-owned tables as a backstop.
- Composite tenant-safe references or equivalent constraints prevent mismatched joins.
- Client metadata, slugs, and IDs do not prove authority.
- Service/background/support access is explicit, least-privileged, and audited.

## 8. Conceptual indexes

- `(tenant_id, id)` on tenant-owned entities for tenant-safe references and lookup.
- `(tenant_id, normalized_code)` or the documented narrower boundary for durable business codes.
- `(tenant_id, parent_id, status)` for branch/warehouse children and register listings.
- `(tenant_id, user_identity_id)` for Membership.
- Tenant-prefixed assignment, role-permission, and scope-target lookup indexes.
- Global normalized indexes for slug, Permission name, provider subject, and installation ID.

Exact indexes must follow final constraints and measured query shapes; RLS predicates need matching
access paths.

## 9. Audit requirements

Migration design must leave a credible path for immutable audit events carrying tenant, actor,
target, old/new state summary, timestamp, reason, request/client/device metadata, and correlation.
Status/archive, capability, supported-brand, register source, device enrollment/assignment,
membership lifecycle, role assignment, permission, and scope changes are auditable.

## 10. Challenged decisions

| Question                                                                | Decision                                                                                                                                     | Status                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Can one branch sell products from multiple brands?                      | Yes, through explicit supported-brand relationships.                                                                                         | **RECOMMENDED**                             |
| Can one warehouse hold inventory for multiple brands?                   | Yes; stock location and merchandise brand are independent.                                                                                   | **RECOMMENDED**                             |
| Is Brand ownership enough to determine future product ownership?        | No. Tenant is the owner; product-to-brand attribution/visibility is designed later.                                                          | **RECOMMENDED**                             |
| Should InventoryLocation belong to exactly one Branch OR one Warehouse? | Yes, exclusive-or.                                                                                                                           | **CONFIRMED**                               |
| Should InventoryLocation support nesting?                               | No in the foundation; revisit for demonstrated authoritative bin stock.                                                                      | **RECOMMENDED**                             |
| Can one Register change its source InventoryLocation?                   | Yes, within its Branch through controlled audited change; future work pins historical/session source.                                        | **RECOMMENDED**                             |
| Can multiple Registers share one source InventoryLocation?              | Yes.                                                                                                                                         | **CONFIRMED**                               |
| Can a Device be reassigned to another Register?                         | Yes within its Tenant, with preserved history and authorization.                                                                             | **RECOMMENDED**                             |
| Can one UserIdentity belong to multiple Tenants?                        | Yes, through distinct Memberships.                                                                                                           | **CONFIRMED**                               |
| Can a Membership have multiple Roles?                                   | Yes, through scoped role assignments.                                                                                                        | **RECOMMENDED**                             |
| Are roles tenant-specific?                                              | Role instances are tenant-owned; Permission catalog and future templates are platform-global.                                                | **RECOMMENDED**                             |
| Can access scope combine Branch and Warehouse scope?                    | Yes, as an explicit union; all resources in a cross-resource action require coverage.                                                        | **CONFIRMED**                               |
| Which entities need direct tenant identity?                             | All tenant-owned entities and their joins/assignments; not Tenant, UserIdentity, or Permission.                                              | **RECOMMENDED**                             |
| What happens when a Branch is archived?                                 | Block new use, validate/resolve dependencies, preserve children and history, and audit; never cascade-delete.                                | **RECOMMENDED**                             |
| Should business codes be reusable after archival?                       | No.                                                                                                                                          | **RECOMMENDED**                             |
| Should Tenant slug changes be allowed?                                  | Yes only through controlled audit; old slug stays reserved and redirect policy is deferred.                                                  | **RECOMMENDED**                             |
| What identifier best supports future offline POS?                       | UUIDv7 plus distinct idempotency/command IDs and server-side validation.                                                                     | **RECOMMENDED**                             |
| Should Tenant suspension block all clients immediately?                 | Block mutations and privileged access immediately; public storefront-read behavior needs founder policy.                                     | **RECOMMENDED / REQUIRES FOUNDER DECISION** |
| Which scope choices need founder input?                                 | Protected-role governance and Brand-plus-location semantics before authorization ships.                                                      | **REQUIRES FOUNDER DECISION**               |
| Is any decision unsafe to defer until Phase 1C?                         | No unresolved blocker remains; exclusive parentage, direct tenant keys, durable IDs/codes, and normalized scope relationships are fixed now. | **CONFIRMED**                               |

## 11. Unresolved questions

| Severity | Status                        | Question                                                                                                               | Required by                  |
| -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| BLOCKER  | **CONFIRMED: none**           | No unresolved issue prevents foundational migration design.                                                            | Phase 1C                     |
| HIGH     | **REQUIRES FOUNDER DECISION** | During Tenant suspension, what public storefront reads remain available?                                               | Public authorization policy  |
| HIGH     | **REQUIRES FOUNDER DECISION** | Which protected default roles may be edited, and who may grant high-risk permissions?                                  | Staff authorization release  |
| HIGH     | **REQUIRES FOUNDER DECISION** | What is the maximum offline authorization window and revocation behavior for disconnected POS Devices?                 | Offline POS authentication   |
| MEDIUM   | **REQUIRES FOUNDER DECISION** | Should Brand scope intersect with location scope for mixed operations, or retain explicit-resource coverage semantics? | Authorization evaluation     |
| MEDIUM   | **REQUIRES FOUNDER DECISION** | Must warehouse rack/bin quantities become authoritative nested locations?                                              | Detailed warehouse design    |
| MEDIUM   | **REQUIRES FOUNDER DECISION** | What public alias/redirect behavior follows Tenant slug changes?                                                       | Public tenant routing        |
| MEDIUM   | **REQUIRES FOUNDER DECISION** | Will the first storefront support multiple storefronts per Brand or cross-brand storefronts?                           | Storefront persistence       |
| LOW      | **REQUIRES FOUNDER DECISION** | What display format and normalization rules apply to business codes?                                                   | External imports/printing    |
| LOW      | **DEFERRED**                  | Exact lifecycle enums, permission catalog, audit retention, address/contact shapes, and settings schemas.              | Relevant contract migrations |

The Phase 1C schema should remain normalized around scope targets and assignment history so the HIGH
and MEDIUM policy choices do not require unsafe ownership changes. None of these questions requires
guessing a business rule in the foundational ownership model.

## Verdict

`READY FOR PHASE 1C`

There are no unresolved BLOCKER items. Phase 1C may design and review foundational persistence and
RLS, but must not expand into products, inventory quantities, orders, authentication, endpoints, or
client features.

## Phase 1C-A implementation status

Phase 1C-A translates the approved foundational ownership model into three append-only migrations.
The implementation and reproducible constraint tests are documented in
[phase-1c-a-foundational-persistence.md](./phase-1c-a-foundational-persistence.md). The migrations
create no RLS policy, authentication integration, permission evaluator, seed catalog, or business
domain table.

Phase 1C-B subsequently implemented the RLS threat model, deny-by-default policies,
identity-provider-neutral request context, privileged-role boundary, and cross-tenant policy tests.
Phase 1D subsequently implemented authentication integration and permission/scope evaluation
without changing these migrations. See [Tenant isolation and RLS](../security/tenant-rls.md) and
[Identity and application authorization](../security/identity-and-authorization.md).
