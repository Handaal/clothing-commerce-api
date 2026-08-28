# Fulfillment persistence

## Purpose

Describe the Phase 2E schema, the declarative integrity, immutability, the privilege graph, and how the
migrations are structured. The enforcement boundary is the privilege model; triggers are
defense-in-depth.

## Tables

### `public.fulfillments`

`id`, `tenant_id`, `order_id`, `inventory_location_id`, `inventory_operation_id` (**NOT NULL**),
`actor_membership_id` (nullable), `idempotency_key` (**NOT NULL**), `normalized_idempotency_key`
(stored generated), `payload_fingerprint` (**NOT NULL**), `fulfilled_at`, `created_at`.

There is **no** `status`, `updated_at`, `cancelled_at`, `branch_id`, `brand_id`, `channel`,
`warehouse_id`, price, payment, or notes column. Tenant-safe FKs (all `ON DELETE RESTRICT`) bind the
Order `(tenant_id, order_id)`, the InventoryLocation `(tenant_id, inventory_location_id)`, the
InventoryOperation `(tenant_id, inventory_operation_id)`, and the actor `(tenant_id,
actor_membership_id)`. Unique keys: `(tenant_id, id)`, `(tenant_id, id, order_id)` (so a line's Order
equals its Fulfillment's Order), `(tenant_id, inventory_operation_id)` (**one InventoryOperation per
Fulfillment**), and `(tenant_id, normalized_idempotency_key)` (authoritative idempotency).

### `public.fulfillment_lines`

`id`, `tenant_id`, `fulfillment_id`, `order_id`, `order_line_id`, `variant_id`, `line_number`,
`quantity` (bigint), `created_at`. Checks: `quantity > 0`, `line_number >= 1`. Unique:
`(tenant_id, fulfillment_id, order_line_id)` (duplicate OrderLine within a Fulfillment forbidden) and
`(tenant_id, fulfillment_id, line_number)`.

## Declarative single-order + variant integrity

Two additive composite keys were added to `public.order_lines` (fix-forward, migration 1):
`UNIQUE (tenant_id, order_id, id)` and `UNIQUE (tenant_id, id, variant_id)`. `fulfillment_lines` then
uses tenant-safe composite FKs:

- `(tenant_id, fulfillment_id, order_id) → fulfillments(tenant_id, id, order_id)` — the line's Order
  equals its Fulfillment's Order;
- `(tenant_id, order_id, order_line_id) → order_lines(tenant_id, order_id, id)` — the referenced
  OrderLine belongs to that same Order;
- `(tenant_id, order_line_id, variant_id) → order_lines(tenant_id, id, variant_id)` — the line's variant
  equals the referenced OrderLine's variant.

A caller can never spoof a variant or cross orders: any mismatch is a structural `23503`.

## Immutability

`fulfillments` and `fulfillment_lines` are fully immutable. `fulfillments_private.forbid_fulfillment_mutation`
rejects `UPDATE`/`DELETE` on both tables unconditionally (there is no sanctioned update path, so no GUC
flag is used). The real boundary is the privilege model: `service_role` holds no DML; all writes run as
`fulfillments_writer` inside the sanctioned functions.

## Privilege graph

- **`fulfillments_writer`** (NOLOGIN, NOINHERIT, NOBYPASSRLS): owns the two tables and the
  `fulfillments_private` functions. Granted `SELECT` on `orders`/`order_lines` (plus narrow read
  policies, since it is a non-owner under Orders RLS) and `EXECUTE` on
  `inventory_private.record_fulfillment_issue`. It has **no** order/inventory DML, no
  `record_operation` `EXECUTE`, and no `inventory_locations` `SELECT`.
- **`inventory_writer`**: gains `SELECT` on `inventory_locations` (grant + a narrow RLS policy) for the
  capability check; no INSERT/UPDATE/DELETE on it.
- **`orders_writer`**: gains narrow `SELECT` on `fulfillments` (for the cancellation guard); no
  fulfillment DML.
- **`service_role`**: `SELECT` on `fulfillments`/`fulfillment_lines`; `EXECUTE` on
  `record_fulfillment` and `resolve_fulfillment_replay_target`; **no** direct DML; **no** `EXECUTE` on
  `record_fulfillment_issue` or the internal fingerprint helper.

## RLS

RLS is enabled and **not forced** on both tables. No policy targets `anon` or `authenticated`
(deny-by-default; stricter than catalog/inventory — no tenant-wide SELECT). `service_role` (bypass) and
the owner (`fulfillments_writer`) are the sanctioned paths. See
[Tenant isolation and RLS](../security/tenant-rls.md).

## Migrations (fix-forward, append-only)

1. `add_fulfillment_order_line_keys` — additive `order_lines` composite keys.
2. `seed_fulfillment_permission` — `orders.fulfill` catalog seed.
3. `create_fulfillments` — role, schema, tables, triggers, and the shared advisory-lock helpers
   (`commerce_locks`).
4. `create_inventory_fulfillment_issue` — `record_fulfillment_issue` + minimal grants/policy.
5. `create_fulfillment_functions` — fingerprint, replay preflight, `record_fulfillment`.
6. `enable_fulfillments_rls` — RLS + the full grant/policy graph.
7. `extend_cancel_order_fulfillment_guard` — shared-lock + fulfillment guard in `cancel_order`.

Ownership transfers follow the Phase 2B/2C/2D non-superuser Supabase pattern (grant `CREATE`, transfer,
revoke). Verified with `supabase db reset` and by applying every migration twice from an empty schema.

## Testing

`pnpm test:fulfillment:persistence` (47 assertions, twice from an empty schema) and
`pnpm test:fulfillment:rls` (14 pgTAP). See [Testing](../development/testing.md).
