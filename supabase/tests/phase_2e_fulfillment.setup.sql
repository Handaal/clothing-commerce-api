-- Disposable Phase 2E fulfillment integration fixtures. Applied to a freshly reset local Supabase
-- database by scripts/test-fulfillment-integration.mjs (as supabase_admin). It seeds one tenant with a
-- brand, product, three variants, a branch + active register, four inventory locations (active+enabled,
-- a second active+enabled for multi-location, active+not-enabled, and inactive), opening stock, and a
-- set of placed Orders (created through the sanctioned create_order) whose ids the suite resolves at
-- runtime by their known idempotency keys. Authorization is exercised through explicit in-memory
-- assignments in the suite, so no role_permissions rows are seeded.

insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values ('10000000-0000-4000-8000-000000000001', 'ff-int', 'FF Integration', 'active', 'completed', 'USD');

insert into public.user_identities (id, display_name, primary_email)
values ('70000000-0000-4000-8000-000000000001', 'FF User', 'ff-int@example.test');

insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
values ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A');

-- One product per variant so each keeps the default option signature (a non-default signature requires
-- selected option values, enforced by a deferred catalog constraint that fires on commit).
insert into public.products (id, tenant_id, brand_id, name, slug, status)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Tee', 'tee', 'active'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Arch Tee', 'arch-tee', 'active'),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Low Tee', 'low-tee', 'active');

insert into public.product_variants (id, tenant_id, product_id, sku, option_signature, status)
values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'TEE-A', 'default', 'active'),
  ('60000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 'TEE-ARCH', 'default', 'active'),
  ('60000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'TEE-LOW', 'default', 'active');

insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor)
values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'USD', 1000),
  ('40000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-00000000000c', 'USD', 1000),
  ('40000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-0000000000a1', 'USD', 1000);

insert into public.branches (id, tenant_id, code, display_name, timezone, status)
values ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRA', 'Branch A', 'UTC', 'active');

insert into public.branch_brands (tenant_id, branch_id, brand_id)
values ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');

insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type, status, is_fulfillment_enabled)
values
  ('e0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC1', 'Loc 1', 'store', 'active', true),
  ('e0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC2', 'Loc 2', 'store', 'active', true),
  ('e0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOCD', 'Loc Disabled', 'store', 'active', false),
  ('e0000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOCI', 'Loc Inactive', 'store', 'inactive', true),
  ('e0000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOCRI', 'Loc Replay-Inactive', 'store', 'active', true),
  ('e0000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOCRD', 'Loc Replay-Disabled', 'store', 'active', true);

insert into public.registers (id, tenant_id, branch_id, code, display_name, status, default_inventory_location_id)
values ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'REG', 'Reg', 'active', 'e0000000-0000-4000-8000-000000000001');

-- Opening stock. Plenty of variant A at LOC1/LOC2/disabled/inactive; only 1 of the low variant at LOC1.
select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 1000);
select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 1000);
select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000003', 100);
select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000004', 100);
select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-00000000000c', 'e0000000-0000-4000-8000-000000000001', 100);
select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000005', 100);
select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000006', 100);
select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-000000000001', 1);

-- Placed orders, resolved at runtime by idempotency key. Variant A line quantities are generous so the
-- suite can drive full/partial/multiple/multi-location fulfillments.
select orders_private.create_order('10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',null,null,null,'seed-online',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":10,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-A"}]'::jsonb);
select orders_private.create_order('10000000-0000-4000-8000-000000000001','pos','USD','20000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','seed-pos',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":4,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-A"}]'::jsonb);
select orders_private.create_order('10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',null,null,null,'seed-archive',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-00000000000c","product_id":"30000000-0000-4000-8000-000000000002","quantity":2,"unit_price_minor":1000,"product_name":"Arch Tee","sku":"TEE-ARCH"}]'::jsonb);
select orders_private.create_order('10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',null,null,null,'seed-low',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-0000000000a1","product_id":"30000000-0000-4000-8000-000000000003","quantity":5,"unit_price_minor":1000,"product_name":"Low Tee","sku":"TEE-LOW"}]'::jsonb);
select orders_private.create_order('10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',null,null,null,'seed-cancel-zero',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":2,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-A"}]'::jsonb);
select orders_private.create_order('10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',null,null,null,'seed-cancel-partial',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":5,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-A"}]'::jsonb);
select orders_private.create_order('10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',null,null,null,'seed-cancel-full',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":3,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-A"}]'::jsonb);
select orders_private.create_order('10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',null,null,null,'seed-replay-inactive',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":2,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-A"}]'::jsonb);
select orders_private.create_order('10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',null,null,null,'seed-replay-disabled',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":2,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-A"}]'::jsonb);

-- Archive the variant AFTER its order was placed: an already-placed OrderLine remains fulfillable.
update public.product_variants
  set status = 'archived', archived_at = now()
  where id = '60000000-0000-4000-8000-00000000000c';
