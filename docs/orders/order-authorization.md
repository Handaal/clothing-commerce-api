# Order Authorization

## Permissions

Phase 2D introduces three platform-global permission keys, seeded by migration into
`public.permissions` (no role assignment): `orders.read`, `orders.create`, `orders.cancel`. There is no
`orders.manage`.

## Resource model — POS is branch-authorized, ONLINE is brand-authorized

The Phase 1D authorization model requires every requested resource to be covered by a permission-
granting assignment (AND across resources; a `tenant`-mode assignment covers all). Phase 2D uses a
single resource per command, selected by channel:

| Command                         | Channel                     | Authorized resource                                    |
| ------------------------------- | --------------------------- | ------------------------------------------------------ |
| `orders.create`                 | POS                         | `{ kind:'branch', id: branch resolved from register }` |
| `orders.create`                 | ONLINE (workforce/internal) | `{ kind:'brand', id: brand derived from lines }`       |
| `orders.read` / `orders.cancel` | POS order                   | `{ kind:'branch', id: order.branch_id }`               |
| `orders.read` / `orders.cancel` | ONLINE order                | `{ kind:'brand', id: order.brand_id }`                 |

Consequences (both intended):

- A **branch-scoped cashier** holding `orders.create` on Branch A (no brand scope) **can** ring POS
  sales at Branch A.
- A **brand-only** user **cannot** originate a POS sale at an arbitrary branch — branch authority is
  required and sufficient for POS; brand is not independently required.

**Brand↔branch eligibility** (the order's brand is carried by the branch, via `branch_brands`) is a
separate application _validation_ at NEW-command time, not an authorization check.

**Known limitation:** per-brand-within-a-branch POS restriction is not expressible under the current
AND-only model without an OR-style resource set; it is deferred and does not modify Phase 1D.

ONLINE customer checkout is **not** routed through the workforce Membership/permission model; a future
public/customer orchestration layer will create the same Order aggregate. Phase 2D implements only the
internal staff surface.

## createOrder state machine (replay-safe ordering)

```
1. Strict Zod parse (reject caller tenantId/brandId/branchId/actor/unitPrice/totals)
2. Resolve verified AuthorizationContext (tenant comes from here)
3. Normalize idempotency key
4. Build canonical CLIENT-INTENT fingerprint input
5. Preflight: resolveIdempotentReplayTarget(tenant, key, intent)   [before any business auth/catalog]
      conflict → IDEMPOTENCY_CONFLICT
      replay   → authorize against the PERSISTED resource, then return the original order
      none     → NEW-command path
```

**NEW POS**: resolve register → current branch (bootstrap) → authorize `orders.create` on that branch →
validate register active, branch active → derive brand from lines → validate `branch_brands` → validate
variant sellability, resolve active price + snapshots → `create_order`.

**NEW ONLINE**: derive brand from variants (bootstrap) → authorize on brand → validate/resolve → create.

## Replay authorization

A NEW command authorizes against **current** requested resources; an idempotent replay authorizes
against the **immutable persisted** resources of the existing order (POS: `order.branch_id`; ONLINE:
`order.brand_id`). Therefore:

- Register reassignment after the original create does not change replay authorization — the replay
  uses the persisted branch, not the register's current branch.
- Catalog mutation (price change, variant archival, name/option changes) and register disabling do not
  block replay — those are consulted only on the NEW path, which a replay skips.
- Possession of an idempotency key never bypasses authorization: every replay still authorizes; a
  caller not authorized for the persisted branch/brand is denied even though the order exists.

## Authorization-bootstrap reads (the documented exception)

A small set of repository lookups run **before** authorization purely to resolve the resource an
operation must be authorized against: `resolveIdempotentReplayTarget`, `getRegisterContext` (register →
branch), `deriveBrandForVariants`, and `getOrderRouting` / `getOrderRoutingByNumber`. They are
tenant-constrained by the verified `tenantId`, return only routing/foundational metadata (never lines,
prices, totals, notes, or timestamps), and — for the replay preflight — disclose routing identifiers
only on a matching client-intent fingerprint. Every **commercial** read (`getOrder`) and every mutation
asserts the authorization proof before any privileged access.

## RLS relationship

RLS is tenant containment; application authorization is permission/scope semantics. `service_role`
bypassing RLS is not authorization. Orders deny all direct `anon`/`authenticated` access; reads flow
through the server-side repository after the application authorizes the correct branch/brand resource.
