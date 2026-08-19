# Identity Integration and Application Authorization

## Purpose and security boundary

Phase 1D implements the staff/admin authorization layer above PostgreSQL RLS. Both layers remain
mandatory:

```text
verified Clerk session
  -> provider binding
  -> active UserIdentity
  -> explicitly selected active Tenant
  -> active Membership
  -> current Role + Permission + AccessScope assignments
  -> resource Tenant ownership
  -> authorized operation proof
  -> narrow privileged repository operation

PostgreSQL RLS remains a separate deny-by-default backstop.
```

Clerk proves an external subject. It does not define the platform UserIdentity, Tenant,
Membership, Role, Permission, or AccessScope. Clerk organization roles, email, public/private
metadata, request headers, and client-supplied internal IDs are not authorization inputs.

The main implementation files are:

- `src/authentication/clerk-request-verifier.ts`: verifies a Clerk session request and returns
  provider `clerk` plus Clerk `userId` as the external subject.
- `src/authentication/server-authorization-boundary.ts`: server-only production composition root.
- `src/authorization/context-resolver.ts`: maps verified provenance to current internal state.
- `src/authorization/authorization-service.ts`: evaluates Permission, assignment-coupled scope,
  and resource ownership and creates an opaque operation proof.
- `src/authorization/supabase-authorization-repository.ts`: private, read-only authorization-state
  adapter around the service-role client.
- `src/authorization/role-governance.ts`: protected-role mutation guard.

There is no new public route. Future protected handlers must accept a Tenant selector as requested
context, call the boundary, authorize the operation, and pass the resulting proof to a narrow
repository operation. They must not construct an `AuthorizationContext` from request data.

## Trusted identity derivation

`@clerk/backend` `authenticateRequest()` accepts only Clerk session tokens and checks an explicit
`authorizedParties` origin allowlist. The optional Clerk JWT public key enables networkless
signature verification; otherwise Clerk may retrieve verification keys. The verifier returns only
the verified Clerk `userId` and non-authoritative diagnostic session ID. It does not read Clerk
role or user metadata.

The context resolver queries `user_identity_provider_bindings` for the exact pair
`('clerk', verified_user_id)`. Exactly one linked row must exist. No row produces
`PROVIDER_BINDING_MISSING`; an unlinked or ambiguous result produces
`PROVIDER_BINDING_INVALID`. The database uniqueness constraint prevents duplicates in normal
operation, while the application still fails closed if its repository returns ambiguous state.

The binding's `user_identity_id`, not a request field, selects the global UserIdentity. Email is
profile data only. A future provider can implement the same verifier interface and use its own
provider key without creating a parallel identity table. Account linking, merging, provider
migration, deletion-webhook processing, and provisioning remain governed workflows to design;
until then unknown, unlinked, or unverifiable accounts are denied.

## Tenant and lifecycle evaluation

A request must select one Tenant by UUID. The selection is a locator, not authority. The resolver
requires exactly one Membership for the derived UserIdentity and selected Tenant and checks the
Membership before returning Tenant-specific lifecycle detail. It never chooses the first or a
default Membership.

Current staff/admin behavior is:

| Record                         | Eligible state                           | Denied states                                               |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| UserIdentity                   | `active`                                 | `suspended`, `deactivated`, missing, ambiguous              |
| Tenant                         | `active`                                 | `provisioning`, `suspended`, `archived`, missing, ambiguous |
| Membership                     | `active`                                 | `invited`, `suspended`, `deactivated`, missing, ambiguous   |
| Role                           | `active`                                 | `archived` grants nothing                                   |
| Permission                     | `active`                                 | `deprecated` grants nothing                                 |
| AccessScope                    | `active`                                 | `archived` grants nothing                                   |
| MembershipRoleAssignment       | assigned now and `unassigned_at IS NULL` | future or ended assignment                                  |
| verified Device, when supplied | `active`                                 | `enrolled`, `revoked`, missing, foreign Tenant              |

Tenant suspension denies staff/admin operations. Public storefront behavior during suspension is
still a separate founder/business decision and no storefront route exists. A global identity
suspension blocks every Tenant even if Memberships remain active.

Device authentication itself is not implemented. `verifiedDevice` is an explicit extension point
for a future credential verifier; arbitrary Device headers are ignored. Once a trusted Device is
provided, a revoked Device fails with `DEVICE_REVOKED`. Disconnected/offline POS revocation and
authorization windows remain out of scope.

`VerifiedDeviceIdentity` is intentionally not a runtime capability in this phase: there is no
credential verifier that could legitimately issue one yet. Its plain TypeScript shape must never
be accepted directly from transport input. The server composition root keeps the field absent
until a reviewed verifier can produce a nominal, runtime-verifiable Device result. This preserves
fail-closed behavior without implying that Device authentication is complete.

## Permission and assignment semantics

Authorization uses stable lowercase dotted Permission keys. Tests use only transaction/in-memory
fixture keys such as `test.read`; migrations seed no business Permission catalog. Role names are
not loaded or compared.

Each effective `MembershipRoleAssignment` stays intact as:

```text
one Role's active Permission keys + that assignment's active AccessScope
```

The evaluator first finds assignments that themselves grant the requested Permission. It then
checks scope only among that subset. It never independently unions all Permissions with all
scopes. Thus Permission X on Branch A plus Permission Y on Branch B cannot create Permission X on
Branch B. For a multi-resource operation, every resource must be covered by at least one
assignment that also grants the requested Permission.

An authorization request with no resource means "everywhere in this Tenant" and therefore
requires a tenant-wide assignment. Callers must list every protected resource for narrower or
multi-dimensional operations.

## AccessScope and resource ownership

Scope semantics are deliberately exact and conservative:

- `tenant`: covers every supported resource kind in the selected Tenant.
- `brand`: covers only the explicitly targeted Brand UUID.
- `branch`: covers only the explicitly targeted Branch UUID.
- `warehouse`: covers only the explicitly targeted Warehouse UUID.
- `inventory_location`: covers only the explicitly targeted InventoryLocation UUID.

No hierarchy is inferred. Branch scope does not automatically cover its InventoryLocations, and
Warehouse scope does not cover its InventoryLocations. This supersedes the earlier conceptual
recommendation to infer descendants and avoids granting authority that was not explicitly stored.

Brand and physical location are orthogonal dimensions. Brand scope never means Branch or
Warehouse scope. A future operation involving both must pass both resources; each must receive
permission-coupled coverage. There is no generic ABAC language or arbitrary policy expression.

Before scope can authorize a supplied UUID, the repository returns only that resource's
authoritative `tenant_id`. Missing, ambiguous, or foreign-Tenant ownership returns the same safe
`TENANT_ACCESS_DENIED` response. This owner lookup is part of authorization bootstrap and occurs
before a privileged business operation.

## Privileged database boundary

Supabase `service_role` bypasses RLS and is never authorization. The production adapter keeps its
client private, exposes no generic query or mutation method, and permits only current
authorization-state reads and `tenant_id` owner lookups. These narrow reads are necessary to
establish authorization and return no business payload.

`executeAuthorizedOperation()` performs Permission, scope, and ownership checks before invoking
its callback. The callback receives an immutable `AuthorizedOperationContext` proof containing the
validated Tenant, Permission, deduplicated resources, and granting assignment IDs. Proof issuance
is recorded in a module-private `WeakSet`; there is no exported marker or constructor.
`assertAuthorizedOperationProof()` accepts only the exact in-process object issued by
`AuthorizationService`, so a cast, object literal, spread, or serialized clone fails with
`AUTHORIZATION_PROOF_INVALID`.

Future privileged business repositories must require the proof and invoke the exported assertion
before access. They must remain unreachable from unauthenticated route code, constrain every query
by the proof's Tenant, and validate every referenced resource; the proof does not make a generic
service-role client safe.

## Protected Role governance

The existing `roles.is_protected` column is authoritative governance metadata. It is not inferred
from names such as Owner or Admin.

- Tenant operations cannot rename, archive, delete, or change Permissions on protected Roles.
- No runtime tenant operation can bypass the protected-role guard in this phase. A future
  platform-governed workflow requires separate design; controlled migrations/maintenance remain
  outside this tenant service guard.
- The guard does not itself authorize anything; a future role-management service must first
  require its approved Permission and audit the mutation.
- Unprotected Roles are tenant-created/custom for this foundation. No default Role templates are
  seeded yet.

Which executable Permissions are "high risk" and which tenant actors may delegate them still
requires founder approval and catalog metadata. Phase 1D does not invent that catalog or expose
Role writes. Authenticated database DML remains denied, so high-risk grants fail closed until an
audited management workflow is approved.

## Freshness and revocation

Clerk session tokens establish only external identity. Role, Permission, scope, Membership,
UserIdentity, Tenant, and Device state is loaded from the authoritative database for every context
resolution; it is not copied into long-lived client claims and is not cached. A change therefore
affects the next request even if a Clerk session remains valid. The short interval between context
resolution and an operation is not a general transaction snapshot; future high-risk mutations may
need transaction-level rechecks.

Clerk session revocation/deletion is enforced when Clerk token verification rejects the request.
Provider-binding unlink and internal lifecycle changes provide an independent fail-closed control.
Webhook-driven unlinking and identity provisioning are not implemented.

## Stable failures

`AuthorizationError` exposes a bounded code, safe message, and HTTP mapping. `UNAUTHENTICATED` maps
to 401; all authorization denials map to 403. The internal codes cover missing/invalid binding,
inactive identity/membership/Tenant/Device, permission denial, scope denial, protected-role denial,
and invalid stored state. HTTP handlers should serialize only `authorizationErrorResponse()` and
must not expose raw provider, database, Tenant, Membership, or resource diagnostics.

Missing Memberships, unknown Tenants, unknown resources, and known foreign resources use generic
Tenant denial where practical, preventing UUID probing from distinguishing existence.

The distinct `PROVIDER_BINDING_MISSING` and `PROVIDER_BINDING_INVALID` responses are an accepted,
bounded diagnostic disclosure. They are reachable only after successful external authentication
and describe the caller's verified provider subject; they never return the subject, binding ID,
internal identity ID, row count, unlink time, or database error. This distinction supports safe
provisioning/support diagnosis without enabling anonymous binding enumeration.

## Testing and safe modification

Run `pnpm test:authorization` for deterministic tests using verifier doubles and an in-memory
repository. Run `pnpm test:authorization:integration` for the actual service-role adapter against
a reset local Supabase API stack. The integration runner captures its local service key without
printing it, applies test-only fixtures outside migration history, and always stops the stack
without backup. Controlled constraint bypasses exist only in that disposable database to prove
that duplicate, missing-related-row, invalid tenant-scope-target, partial-Permission, and malformed
target state fails closed. Neither suite calls Clerk or uses cloud/production credentials.

When changing authorization:

1. add an adversarial test first;
2. keep provider proof separate from internal authorization state;
3. preserve assignment-level Permission/scope coupling;
4. list every protected resource and resolve its Tenant before privileged business access;
5. avoid caching or claims-based grants unless a separately reviewed invalidation design exists;
6. rerun unit, deterministic authorization, authorization integration, persistence, and RLS suites.

See [Local authentication](../development/authentication-local.md),
[Tenant RLS](tenant-rls.md), and [ADR-012](../decisions/ADR-012-identity-and-authorization-foundation.md).

## Phase 1D limitations

There is no public auth-context endpoint, provisioning/invitation UI, provider-link workflow,
Role-management API, business Permission catalog, customer authentication, business-domain
schema, offline POS authorization, authorization cache, production deployment, or audit-event
store. Those omissions are explicit boundaries, not implied authorization behavior.
