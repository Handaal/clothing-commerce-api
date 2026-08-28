-- Phase 2E (1/7): additive composite unique keys that let the Fulfillment schema enforce, purely
-- declaratively (no triggers), that a FulfillmentLine references an OrderLine of the SAME Order and
-- carries that OrderLine's exact Variant.
--
-- These are fix-forward, additive changes to the already-merged Phase 2D order_lines table. The merged
-- migration is never rewritten. Each key's trailing column beyond (tenant_id, id) is trivially
-- satisfiable because order_lines.id is already the primary key, so no row can violate the new keys and
-- no populated-table backfill is required.

-- Enables fulfillment_lines(tenant_id, order_id, order_line_id) -> order_lines(tenant_id, order_id, id):
-- a FulfillmentLine's OrderLine must belong to the same Order as the Fulfillment (which is itself bound
-- to that Order). order_lines.order_id is NOT NULL, so the composite has no null-bearing rows.
alter table public.order_lines
  add constraint order_lines_tenant_order_id_unique unique (tenant_id, order_id, id);

-- Enables fulfillment_lines(tenant_id, order_line_id, variant_id) -> order_lines(tenant_id, id, variant_id):
-- a FulfillmentLine's variant_id must equal the referenced OrderLine's variant_id. A caller can never
-- spoof a variant: the server derives it from the immutable OrderLine, and this FK makes any mismatch a
-- structural integrity violation. order_lines.variant_id is NOT NULL, so the composite has no
-- null-bearing rows.
alter table public.order_lines
  add constraint order_lines_tenant_id_variant_unique unique (tenant_id, id, variant_id);
