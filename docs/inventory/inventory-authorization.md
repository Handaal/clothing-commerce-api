# Inventory Authorization (Phase 2C)

## Purpose

How the Phase 2C inventory application service authorizes stock operations. It reuses the Phase 1D
authorization service unchanged — no new authorization engine, no role-name checks, no Clerk-metadata
authorization, and `service_role` is a database credential, never an authorization decision.

See [identity, membership, role, and scope model](../architecture/identity-membership-role-scope-model.md),
[tenant RLS](../security/tenant-rls.md), and [ADR-020](../decisions/ADR-020-inventory-application-service-boundary.md).

## Flow

Every command runs through `executeAuthorizedOperation` from `src/authorization`:

```
verified AuthorizationContext
  → authorize(permissionKey, resources)     // permission granted + tenant match + scope coverage
  → opaque AuthorizedOperationContext proof
  → privileged repository reads (variant/location state)
  → lifecycle/capability validation
  → privileged mutation (sanctioned ledger function)
```

Authorization happens **before** any privileged database access. The repository asserts the proof
(`assertAuthorizedOperationProof`) before touching the database, so a mutation cannot run without a
genuine, in-process authorization proof. Resource existence is not revealed before authorization: the
authorization step only verifies the target location's tenant; variant existence is read afterward.

The proof check is **provenance-based**: `assertAuthorizedOperationProof` confirms the object was
issued by this process's authorization service (it is held in a `WeakSet`), not that it covers the
exact key being read or written. The `InventoryService` is the trusted binding layer — it is the only
holder of the repository and always constructs the repository key from the same command it authorized,
so the proof and the accessed resource stay aligned. The repository is module-internal and is never
handed to callers outside `src/inventory`, so no external caller can pair a valid proof with an
unrelated key.

## Permission keys

Platform-global, `resource.action`, enforced in application code:

- `inventory.read`
- `inventory.adjust` — governs both `setOpeningStock` and `adjustInventory`
- `inventory.receive`
- `inventory.issue`
- `inventory.transfer`

Opening stock is governed by `inventory.adjust` (a first-time reconciliation of the same custodial
nature); a separate `inventory.open` can be introduced additively if setup ever needs to be restricted
separately. Phase 2C does not seed permission rows in a shared migration; tests seed the rows they
need.

## Resources and scope

Inventory custody is physical: the protected resource is always the **`InventoryLocation`**.

- `getInventoryBalance`, `setOpeningStock`, `adjustInventory`, `receiveInventory`, `issueInventory`
  authorize a single `inventory_location` resource.
- `transferInventory` authorizes **two** `inventory_location` resources (source and destination). The
  authorization service requires each resource to be covered by a permission-granting assignment, so
  both locations must be authorized. Source and destination may be covered by two different
  assignments, but each covering assignment must itself carry `inventory.transfer` — you cannot
  combine "assignment A grants the permission" with "unrelated assignment B grants the location". This
  is the Phase 1D permission-scope coupling that prevents cross-product escalation.

### No implicit hierarchy

Phase 1D uses conservative exact-target scope semantics, and Phase 2C relies on them without change:

- Branch scope does **not** implicitly authorize child InventoryLocations.
- Warehouse scope does **not** implicitly authorize child InventoryLocations.
- Brand scope does **not** authorize physical stock mutation at all.
- Tenant-wide scope authorizes all locations in the tenant.

### Brand vs. location authority

Physical stock mutation requires **InventoryLocation** authority. Brand scope alone never authorizes a
stock mutation: inventory is keyed by `Variant + InventoryLocation`, and Brand and physical-location
targets are orthogonal. An operator authorized for a location may operate on stock there regardless of
brand; a brand manager with only Brand scope has no physical custody. Phase 2C therefore passes only
`inventory_location` resources to the authorization service and never requires a brand resource.

## Actor derivation

The acting Membership is taken from the verified context (`context.membership.id`) and passed to the
ledger as the operation actor. It is never accepted from caller input; the strict command schemas
reject any smuggled `actorMembershipId`. System-origin (null actor) operations remain a future
capability.

## Privilege boundary (unchanged)

- `authenticated` / `anon`: no access to the private inventory schema and no EXECUTE on any mutation
  function; RLS grants read-only SELECT on the inventory tables within their tenant.
- `service_role`: SELECT on the inventory tables (no direct INSERT/UPDATE/DELETE) and EXECUTE on the
  sanctioned functions only (`record_operation`, `record_opening`, `record_count_adjustment`).
- The functions run as `inventory_writer`, the sole role able to write inventory.

The Phase 2C RLS suite (`pnpm test:inventory:operations:rls`) asserts these grants for the new
functions; the integration suite proves permission-denied, scope-denied, cross-tenant rejection, and
that the sanctioned path works end to end.

## Future consumers

POS, Storefront, Orders, Purchasing, and Returns must call these application commands (or a future
HTTP API in front of them). They must never write balances or movements, never invoke the database
function directly, and never hold `service_role`.
