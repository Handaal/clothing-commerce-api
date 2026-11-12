-- Phase 2D (1/5): additive composite unique keys that let the Orders schema enforce its single-brand
-- and register-belongs-to-branch invariants declaratively (no triggers).
--
-- These are fix-forward, additive changes to already-merged foundational/catalog tables. The merged
-- migrations are never rewritten. Each key is trivially satisfiable (its trailing column is already a
-- primary key), so no data can violate it and no populated-table backfill is required.

-- Enables order_lines(tenant_id, brand_id, product_id) -> products(tenant_id, brand_id, id): a line's
-- Product must belong to the same Brand as its Order. products.brand_id is NOT NULL, so the composite
-- has no null-bearing rows.
alter table public.products
  add constraint products_tenant_brand_id_unique unique (tenant_id, brand_id, id);

-- Enables orders(tenant_id, branch_id, register_id) -> registers(tenant_id, branch_id, id): a POS
-- Order's Register must belong to the Order's stored operational Branch. registers.branch_id is NOT
-- NULL, so the composite has no null-bearing rows.
alter table public.registers
  add constraint registers_tenant_branch_id_unique unique (tenant_id, branch_id, id);
