-- Phase 2F-A (2/2): keyset-pagination indexes for the management read API.
--
-- The management list endpoints (GET /products, /inventory, /orders) page with a stable keyset order
-- and always apply the tenant + authorization visibility predicate BEFORE the ORDER BY / cursor
-- condition / LIMIT. Each index below leads with tenant_id (so a single tenant's slice is contiguous)
-- and continues with the exact keyset columns and directions used by the corresponding query, so the
-- cursor comparison and LIMIT are served directly from the index without a sort.
--
-- These are additive covering-order indexes only. No table, column, or existing index is changed. The
-- prior single-column helper indexes (e.g. orders_tenant_created_idx) remain for their existing access
-- paths; they cannot serve the (placed_at DESC, id DESC) keyset order.

-- Products list: ORDER BY created_at DESC, id DESC within a tenant.
create index products_tenant_created_id_idx
  on public.products (tenant_id, created_at desc, id desc);

-- Inventory list: ORDER BY inventory_location_id ASC, variant_id ASC within a tenant. The existing
-- unique (tenant_id, variant_id, inventory_location_id) leads with variant_id and cannot serve this
-- location-then-variant keyset order.
create index inventory_balances_tenant_location_variant_idx
  on public.inventory_balances (tenant_id, inventory_location_id, variant_id);

-- Orders list: ORDER BY placed_at DESC, id DESC within a tenant.
create index orders_tenant_placed_id_idx
  on public.orders (tenant_id, placed_at desc, id desc);
