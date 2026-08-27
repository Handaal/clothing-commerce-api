# Order Persistence

## Tables and ownership

| Table                    | Meaning                                       | Key ownership/integrity                                                      |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `orders`                 | Canonical sales aggregate root                | Direct `tenant_id`; composite `(tenant_id,id)` and `(tenant_id,id,brand_id)` |
| `order_lines`            | Immutable commercial snapshot lines           | Composite tenant/order/brand, product/brand, and product/variant FKs         |
| `order_number_sequences` | Per-tenant transactional order-number counter | `tenant_id` PK; writer-internal                                              |

All three tables are owned by the dedicated non-login `orders_writer` role and live behind the same
privilege boundary as Phase 2B/2C inventory: `service_role` holds `SELECT` on `orders`/`order_lines`
(none on the counter) and `EXECUTE` on the sanctioned functions only — it has **no direct DML**. Every
write runs as `orders_writer` inside a `SECURITY DEFINER` function. All FKs are `ON DELETE RESTRICT`.

## Declarative single-brand chain

Phase 2D adds two additive composite uniques so the single-brand invariant needs no trigger:

- `products (tenant_id, brand_id, id)` and `registers (tenant_id, branch_id, id)`
  (`20260825180000_add_order_composite_keys.sql`).

Then `order_lines` carry `brand_id` + `product_id` and the FK chain
`order_lines(tenant_id,order_id,brand_id) → orders(tenant_id,id,brand_id)`,
`order_lines(tenant_id,brand_id,product_id) → products(tenant_id,brand_id,id)`,
`order_lines(tenant_id,product_id,variant_id) → product_variants(tenant_id,product_id,id)` forces every
line's variant to belong to the order's brand.

## POS provenance

`orders(tenant_id, branch_id, register_id) → registers(tenant_id, branch_id, id)` (MATCH SIMPLE, so
ONLINE's all-null pair is not checked) structurally enforces that a POS order's register belongs to its
stored branch. The application resolves `branch_id` from the register server-side; a caller never
supplies it. A CHECK enforces `channel='pos' ⇒ branch+register not null` and
`channel='online' ⇒ both null`. There is intentionally **no** `inventory_location_id`.

## Money and totals

All monetary columns are `bigint` minor units (matching `variant_prices.amount_minor`). Currency is on
the order only (single-currency invariant); it is not repeated on lines. `create_order` computes each
`line_total_minor = quantity * unit_price_minor` and `orders.total_minor = Σ line_total_minor` using
`numeric`, rejecting any value outside the bigint range (`22003`) before storing. A line CHECK
(`line_total_minor = quantity * unit_price_minor`) is the backstop. The application boundary carries
amounts as JS safe integers and range-checks with BigInt before persisting, so an order is always
readable.

## Idempotency and the replay preflight

`orders` carries `idempotency_key`, a generated `normalized_idempotency_key`, and `payload_fingerprint`
with a partial unique index on `(tenant_id, normalized_idempotency_key)`. The fingerprint is the
**client intent only** — `orders_private.order_intent_fingerprint(tenant, channel, currency, register,
ordered (variant_id, quantity) lines)`; it excludes resolved prices, snapshots, notes, actor, and
derived brand/branch, so a retry after a catalog change replays instead of conflicting. The same helper
is used by both `create_order` and the preflight, so the two never drift.

`orders_private.resolve_idempotent_replay_target(tenant, normalized_key, intent)` is a narrow
authorization-bootstrap preflight: it returns only routing metadata (`order_id, channel, brand_id,
branch_id`) and only when the fingerprint matches; a conflict returns identifiers `NULL`; a missing key
returns zero rows. It never exposes lines/prices/totals/notes.

## Order numbers

`order_number` is generated inside `create_order` by locking (or race-safely creating) the tenant's
`order_number_sequences` row `FOR UPDATE` and incrementing it in the same transaction. A rolled-back
create — including an idempotency-race loser resolved inside the function's `BEGIN … EXCEPTION` block —
rolls back the increment, so a failed create does not burn a number. Numbers are **not guaranteed
gapless** and are **not** fiscal invoice numbers. `(tenant_id, normalized_order_number)` is unique.

## Immutability

`order_lines` reject all UPDATE/DELETE (append-only trigger). `orders` reject DELETE and reject UPDATE
except during a `cancel_order` call, which sets a transaction-local flag the guard trigger honours.
These triggers are defense-in-depth; the real boundary is the `orders_writer` + function-grant privilege
model. Orders are never hard-deleted.

## Functions

| Function                                               | Purpose                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `orders_private.order_intent_fingerprint(...)`         | Canonical client-intent md5 (shared).                                                               |
| `orders_private.resolve_idempotent_replay_target(...)` | Authorization-bootstrap replay preflight.                                                           |
| `orders_private.create_order(...)`                     | Sole atomic order+lines creation; authoritative idempotency; per-tenant number; money-range checks. |
| `orders_private.cancel_order(...)`                     | Atomic write-once `placed → cancelled`.                                                             |

`create_order` performs structural validation only (tenant-safe FKs, single brand/currency, channel
provenance, positive quantities, money ranges, atomic insert, idempotency). It resolves **no** catalog
or pricing data and authorizes **no** user — those are application responsibilities.

## RLS

RLS is enabled (not forced) on all three tables with **zero policies**: `anon` and `authenticated` have
no access at all — deliberately stricter than catalog/inventory, because orders are commercially
sensitive and a future PII carrier. `service_role` reads through its `SELECT` grant (bypassing RLS as
infrastructure) and mutates only through the private functions. See
[tenant-rls](../security/tenant-rls.md).

## Migration order

1. `20260825180000_add_order_composite_keys.sql` — additive `products`/`registers` composite uniques.
2. `20260825180100_seed_platform_permissions.sql` — idempotent platform permission catalog seed.
3. `20260825180200_create_orders.sql` — `orders_writer`, `orders_private`, tables, constraints,
   indexes, append-only triggers, ownership transfer.
4. `20260825180300_create_order_functions.sql` — the four functions.
5. `20260825180400_enable_orders_rls.sql` — RLS + grants.

`supabase/config.toml` exposes `orders_private` to PostgREST so the service-role client can call the
functions by name; the EXECUTE grants (service_role only) remain the boundary.
