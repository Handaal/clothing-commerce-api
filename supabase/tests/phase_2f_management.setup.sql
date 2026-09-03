-- Disposable Phase 2F management-API integration fixtures. Applied only by
-- scripts/test-api-integration.mjs after a local Supabase reset. Not a migration or production seed.
--
-- Graph summary (tenant T):
--   Brands BA, BB; Branches BRA, BRB; Warehouse WH; Locations LA(BRA), LB(BRB), LW(WH).
--   Location write flags: LA=receive+origin+dest, LB=origin-only, LW=receive+dest (no origin).
--   Products: BrandA PA1..PA3 (older->newer), BrandB PB1..PB3 (newer). One variant each; a price on VA1.
--   Balances: (VA1,LA)=5, (VA2,LA)=3, (VB1,LB)=7, (VA3,LW)=9.
--   Orders: online BrandA/BrandB; pos BranchA/BranchB.
--   Identities: full(tenant-wide read all), explicit(BrandA catalog / LA inventory / BrandA+BranchA orders),
--     wrong(wrong-kind-only scopes), noperm(orders-only tenant-wide), inactive-membership, foreign(T2),
--     writer(tenant-wide inventory read+receive/adjust/transfer), write-scoped(same writes, LA only).

begin;

-- Tenants -------------------------------------------------------------------------------------------
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('f2000001-0000-4000-8000-000000000001', 'mgmt-t', 'Management Tenant', 'active', 'completed', 'USD'),
  ('f2000001-0000-4000-8000-000000000002', 'mgmt-t2', 'Foreign Tenant', 'active', 'completed', 'USD');

-- Organization --------------------------------------------------------------------------------------
insert into public.brands (id, tenant_id, code, display_name)
values
  ('f2000002-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'brand-a', 'Brand A'),
  ('f2000002-0000-4000-8000-0000000000a2', 'f2000001-0000-4000-8000-000000000001', 'brand-b', 'Brand B'),
  ('f2000002-0000-4000-8000-0000000000c1', 'f2000001-0000-4000-8000-000000000002', 'brand-t2', 'Brand T2');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values
  ('f2000003-0000-4000-8000-0000000000b1', 'f2000001-0000-4000-8000-000000000001', 'branch-a', 'Branch A', 'UTC'),
  ('f2000003-0000-4000-8000-0000000000b2', 'f2000001-0000-4000-8000-000000000001', 'branch-b', 'Branch B', 'UTC');

insert into public.warehouses (id, tenant_id, code, display_name, timezone)
values
  ('f2000004-0000-4000-8000-0000000000d1', 'f2000001-0000-4000-8000-000000000001', 'wh-1', 'Warehouse 1', 'UTC');

-- Distinct operational capability profiles let /me/context write derivation be tested precisely:
--   LA: receive + transfer-origin + transfer-destination (fully enabled, active)
--   LB: transfer-origin only (receive off, destination off)
--   LW: receive + transfer-destination (transfer-origin off)
insert into public.inventory_locations (id, tenant_id, branch_id, warehouse_id, code, display_name, location_type, is_receiving_enabled, is_transfer_origin_enabled, is_transfer_destination_enabled)
values
  ('f2000005-0000-4000-8000-0000000000e1', 'f2000001-0000-4000-8000-000000000001', 'f2000003-0000-4000-8000-0000000000b1', null, 'loc-a', 'Location A', 'store', true, true, true),
  ('f2000005-0000-4000-8000-0000000000e2', 'f2000001-0000-4000-8000-000000000001', 'f2000003-0000-4000-8000-0000000000b2', null, 'loc-b', 'Location B', 'store', false, true, false),
  ('f2000005-0000-4000-8000-0000000000e3', 'f2000001-0000-4000-8000-000000000001', null, 'f2000004-0000-4000-8000-0000000000d1', 'loc-w', 'Location W', 'warehouse', true, false, true);

insert into public.registers (id, tenant_id, branch_id, code, display_name, status, default_inventory_location_id)
values
  ('f2000006-0000-4000-8000-0000000000f1', 'f2000001-0000-4000-8000-000000000001', 'f2000003-0000-4000-8000-0000000000b1', 'reg-a', 'Register A', 'active', 'f2000005-0000-4000-8000-0000000000e1'),
  ('f2000006-0000-4000-8000-0000000000f2', 'f2000001-0000-4000-8000-000000000001', 'f2000003-0000-4000-8000-0000000000b2', 'reg-b', 'Register B', 'active', 'f2000005-0000-4000-8000-0000000000e2');

-- Catalog -------------------------------------------------------------------------------------------
insert into public.products (id, tenant_id, brand_id, name, slug, style_code, status, created_at)
values
  ('f2000007-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a1', 'Alpha One', 'alpha-one', 'SC-A1', 'active', '2026-03-01T00:00:00Z'),
  ('f2000007-0000-4000-8000-0000000000a2', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a1', 'Alpha Two', 'alpha-two', null, 'active', '2026-03-02T00:00:00Z'),
  ('f2000007-0000-4000-8000-0000000000a3', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a1', 'Alpha Three', 'alpha-three', 'SC-A3', 'draft', '2026-03-03T00:00:00Z'),
  ('f2000007-0000-4000-8000-0000000000b1', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a2', 'Beta One', 'beta-one', 'SC-B1', 'active', '2026-03-04T00:00:00Z'),
  ('f2000007-0000-4000-8000-0000000000b2', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a2', 'Beta Two', 'beta-two', null, 'active', '2026-03-05T00:00:00Z'),
  ('f2000007-0000-4000-8000-0000000000b3', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a2', 'Beta Three', 'beta-three', null, 'active', '2026-03-06T00:00:00Z'),
  ('f2000007-0000-4000-8000-0000000000c1', 'f2000001-0000-4000-8000-000000000002', 'f2000002-0000-4000-8000-0000000000c1', 'Foreign Product', 'foreign-product', null, 'active', '2026-03-07T00:00:00Z');

insert into public.product_variants (id, tenant_id, product_id, sku, status)
values
  ('f2000008-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'f2000007-0000-4000-8000-0000000000a1', 'SKU-A1', 'active'),
  ('f2000008-0000-4000-8000-0000000000a2', 'f2000001-0000-4000-8000-000000000001', 'f2000007-0000-4000-8000-0000000000a2', 'SKU-A2', 'active'),
  ('f2000008-0000-4000-8000-0000000000a3', 'f2000001-0000-4000-8000-000000000001', 'f2000007-0000-4000-8000-0000000000a3', 'SKU-A3', 'active'),
  ('f2000008-0000-4000-8000-0000000000b1', 'f2000001-0000-4000-8000-000000000001', 'f2000007-0000-4000-8000-0000000000b1', 'SKU-B1', 'active');

insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor, status)
values
  ('f2000009-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'f2000008-0000-4000-8000-0000000000a1', 'USD', 1999, 'active');

select set_config('inventory_private.allow_balance_write', 'on', true);
insert into public.inventory_balances (tenant_id, variant_id, inventory_location_id, on_hand_quantity, version)
values
  ('f2000001-0000-4000-8000-000000000001', 'f2000008-0000-4000-8000-0000000000a1', 'f2000005-0000-4000-8000-0000000000e1', 5, 1),
  ('f2000001-0000-4000-8000-000000000001', 'f2000008-0000-4000-8000-0000000000a2', 'f2000005-0000-4000-8000-0000000000e1', 3, 1),
  ('f2000001-0000-4000-8000-000000000001', 'f2000008-0000-4000-8000-0000000000b1', 'f2000005-0000-4000-8000-0000000000e2', 7, 1),
  ('f2000001-0000-4000-8000-000000000001', 'f2000008-0000-4000-8000-0000000000a3', 'f2000005-0000-4000-8000-0000000000e3', 9, 1);
select set_config('inventory_private.allow_balance_write', 'off', true);

-- Orders --------------------------------------------------------------------------------------------
insert into public.orders (id, tenant_id, brand_id, branch_id, register_id, order_number, channel, status, currency, total_minor, placed_at)
values
  ('f200000a-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a1', null, null, 'ORD-A-ONLINE', 'online', 'placed', 'USD', 1999, '2026-04-01T00:00:00Z'),
  ('f200000a-0000-4000-8000-0000000000b1', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a2', null, null, 'ORD-B-ONLINE', 'online', 'placed', 'USD', 500, '2026-04-02T00:00:00Z'),
  ('f200000a-0000-4000-8000-0000000000a2', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a1', 'f2000003-0000-4000-8000-0000000000b1', 'f2000006-0000-4000-8000-0000000000f1', 'ORD-A-POS', 'pos', 'placed', 'USD', 700, '2026-04-03T00:00:00Z'),
  ('f200000a-0000-4000-8000-0000000000b2', 'f2000001-0000-4000-8000-000000000001', 'f2000002-0000-4000-8000-0000000000a2', 'f2000003-0000-4000-8000-0000000000b2', 'f2000006-0000-4000-8000-0000000000f2', 'ORD-B-POS', 'pos', 'placed', 'USD', 900, '2026-04-04T00:00:00Z');

insert into public.order_lines (id, tenant_id, order_id, brand_id, product_id, variant_id, line_number, quantity, unit_price_minor, line_total_minor, product_name_snapshot, sku_snapshot)
values
  ('f200000b-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'f200000a-0000-4000-8000-0000000000a1', 'f2000002-0000-4000-8000-0000000000a1', 'f2000007-0000-4000-8000-0000000000a1', 'f2000008-0000-4000-8000-0000000000a1', 1, 1, 1999, 1999, 'Alpha One', 'SKU-A1');

-- Identities ----------------------------------------------------------------------------------------
insert into public.user_identities (id, status)
values
  ('f2000010-0000-4000-8000-000000000001', 'active'),
  ('f2000010-0000-4000-8000-000000000002', 'active'),
  ('f2000010-0000-4000-8000-000000000003', 'active'),
  ('f2000010-0000-4000-8000-000000000004', 'active'),
  ('f2000010-0000-4000-8000-000000000005', 'active'),
  ('f2000010-0000-4000-8000-000000000006', 'active'),
  ('f2000010-0000-4000-8000-000000000007', 'active'),
  ('f2000010-0000-4000-8000-000000000008', 'active');

insert into public.user_identity_provider_bindings (id, user_identity_id, provider, provider_subject)
values
  ('f2000011-0000-4000-8000-000000000001', 'f2000010-0000-4000-8000-000000000001', 'clerk', 'clerk-full'),
  ('f2000011-0000-4000-8000-000000000002', 'f2000010-0000-4000-8000-000000000002', 'clerk', 'clerk-explicit'),
  ('f2000011-0000-4000-8000-000000000003', 'f2000010-0000-4000-8000-000000000003', 'clerk', 'clerk-wrong'),
  ('f2000011-0000-4000-8000-000000000004', 'f2000010-0000-4000-8000-000000000004', 'clerk', 'clerk-noperm'),
  ('f2000011-0000-4000-8000-000000000005', 'f2000010-0000-4000-8000-000000000005', 'clerk', 'clerk-inactive-membership'),
  ('f2000011-0000-4000-8000-000000000006', 'f2000010-0000-4000-8000-000000000006', 'clerk', 'clerk-foreign'),
  ('f2000011-0000-4000-8000-000000000007', 'f2000010-0000-4000-8000-000000000007', 'clerk', 'clerk-writer'),
  ('f2000011-0000-4000-8000-000000000008', 'f2000010-0000-4000-8000-000000000008', 'clerk', 'clerk-write-scoped');

insert into public.memberships (id, tenant_id, user_identity_id, status, activated_at, suspended_at)
values
  ('f2000012-0000-4000-8000-000000000001', 'f2000001-0000-4000-8000-000000000001', 'f2000010-0000-4000-8000-000000000001', 'active', now(), null),
  ('f2000012-0000-4000-8000-000000000002', 'f2000001-0000-4000-8000-000000000001', 'f2000010-0000-4000-8000-000000000002', 'active', now(), null),
  ('f2000012-0000-4000-8000-000000000003', 'f2000001-0000-4000-8000-000000000001', 'f2000010-0000-4000-8000-000000000003', 'active', now(), null),
  ('f2000012-0000-4000-8000-000000000004', 'f2000001-0000-4000-8000-000000000001', 'f2000010-0000-4000-8000-000000000004', 'active', now(), null),
  ('f2000012-0000-4000-8000-000000000005', 'f2000001-0000-4000-8000-000000000001', 'f2000010-0000-4000-8000-000000000005', 'suspended', now(), now()),
  ('f2000012-0000-4000-8000-000000000006', 'f2000001-0000-4000-8000-000000000002', 'f2000010-0000-4000-8000-000000000006', 'active', now(), null),
  ('f2000012-0000-4000-8000-000000000007', 'f2000001-0000-4000-8000-000000000001', 'f2000010-0000-4000-8000-000000000007', 'active', now(), null),
  ('f2000012-0000-4000-8000-000000000008', 'f2000001-0000-4000-8000-000000000001', 'f2000010-0000-4000-8000-000000000008', 'active', now(), null);

-- Roles carrying the management read permissions (referenced by key from the migration-seeded catalog).
insert into public.roles (id, tenant_id, name, status, is_protected)
values
  ('f2000013-0000-4000-8000-000000000001', 'f2000001-0000-4000-8000-000000000001', 'Full Reader', 'active', false),
  ('f2000013-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'Catalog Reader', 'active', false),
  ('f2000013-0000-4000-8000-0000000000a2', 'f2000001-0000-4000-8000-000000000001', 'Inventory Reader', 'active', false),
  ('f2000013-0000-4000-8000-0000000000a3', 'f2000001-0000-4000-8000-000000000001', 'Orders Reader', 'active', false),
  ('f2000013-0000-4000-8000-0000000000b1', 'f2000001-0000-4000-8000-000000000001', 'Wrong Catalog', 'active', false),
  ('f2000013-0000-4000-8000-0000000000b2', 'f2000001-0000-4000-8000-000000000001', 'Wrong Inventory', 'active', false),
  ('f2000013-0000-4000-8000-0000000000b3', 'f2000001-0000-4000-8000-000000000001', 'Wrong Orders', 'active', false),
  ('f2000013-0000-4000-8000-0000000000c1', 'f2000001-0000-4000-8000-000000000001', 'Orders Only', 'active', false),
  ('f2000013-0000-4000-8000-0000000000d1', 'f2000001-0000-4000-8000-000000000001', 'Inventory Writer', 'active', false);

insert into public.role_permissions (tenant_id, role_id, permission_id)
values
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-000000000001', (select id from public.permissions where key = 'catalog.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-000000000001', (select id from public.permissions where key = 'inventory.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-000000000001', (select id from public.permissions where key = 'orders.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000a1', (select id from public.permissions where key = 'catalog.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000a2', (select id from public.permissions where key = 'inventory.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000a3', (select id from public.permissions where key = 'orders.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000b1', (select id from public.permissions where key = 'catalog.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000b2', (select id from public.permissions where key = 'inventory.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000b3', (select id from public.permissions where key = 'orders.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000c1', (select id from public.permissions where key = 'orders.read')),
  -- Inventory Writer: read plus the three Phase 2G write permissions.
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000d1', (select id from public.permissions where key = 'inventory.read')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000d1', (select id from public.permissions where key = 'inventory.receive')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000d1', (select id from public.permissions where key = 'inventory.adjust')),
  ('f2000001-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-0000000000d1', (select id from public.permissions where key = 'inventory.transfer'));

insert into public.access_scopes (id, tenant_id, name, scope_mode, status)
values
  ('f2000014-0000-4000-8000-000000000001', 'f2000001-0000-4000-8000-000000000001', 'Tenant Wide', 'tenant', 'active'),
  ('f2000014-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'Brand A Catalog', 'explicit', 'active'),
  ('f2000014-0000-4000-8000-0000000000a2', 'f2000001-0000-4000-8000-000000000001', 'Location A Inventory', 'explicit', 'active'),
  ('f2000014-0000-4000-8000-0000000000a3', 'f2000001-0000-4000-8000-000000000001', 'Brand A + Branch A Orders', 'explicit', 'active'),
  ('f2000014-0000-4000-8000-0000000000b1', 'f2000001-0000-4000-8000-000000000001', 'Wrong Catalog Branch', 'explicit', 'active'),
  ('f2000014-0000-4000-8000-0000000000b2', 'f2000001-0000-4000-8000-000000000001', 'Wrong Inventory Brand', 'explicit', 'active'),
  ('f2000014-0000-4000-8000-0000000000b3', 'f2000001-0000-4000-8000-000000000001', 'Wrong Orders Warehouse', 'explicit', 'active'),
  ('f2000014-0000-4000-8000-0000000000d1', 'f2000001-0000-4000-8000-000000000001', 'Location A Write', 'explicit', 'active');

insert into public.access_scope_targets (id, tenant_id, access_scope_id, brand_id, branch_id, warehouse_id, inventory_location_id)
values
  ('f2000015-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'f2000014-0000-4000-8000-0000000000a1', 'f2000002-0000-4000-8000-0000000000a1', null, null, null),
  ('f2000015-0000-4000-8000-0000000000a2', 'f2000001-0000-4000-8000-000000000001', 'f2000014-0000-4000-8000-0000000000a2', null, null, null, 'f2000005-0000-4000-8000-0000000000e1'),
  ('f2000015-0000-4000-8000-0000000000a3', 'f2000001-0000-4000-8000-000000000001', 'f2000014-0000-4000-8000-0000000000a3', 'f2000002-0000-4000-8000-0000000000a1', null, null, null),
  ('f2000015-0000-4000-8000-0000000000a4', 'f2000001-0000-4000-8000-000000000001', 'f2000014-0000-4000-8000-0000000000a3', null, 'f2000003-0000-4000-8000-0000000000b1', null, null),
  ('f2000015-0000-4000-8000-0000000000b1', 'f2000001-0000-4000-8000-000000000001', 'f2000014-0000-4000-8000-0000000000b1', null, 'f2000003-0000-4000-8000-0000000000b1', null, null),
  ('f2000015-0000-4000-8000-0000000000b2', 'f2000001-0000-4000-8000-000000000001', 'f2000014-0000-4000-8000-0000000000b2', 'f2000002-0000-4000-8000-0000000000a1', null, null, null),
  ('f2000015-0000-4000-8000-0000000000b3', 'f2000001-0000-4000-8000-000000000001', 'f2000014-0000-4000-8000-0000000000b3', null, null, 'f2000004-0000-4000-8000-0000000000d1', null),
  ('f2000015-0000-4000-8000-0000000000d1', 'f2000001-0000-4000-8000-000000000001', 'f2000014-0000-4000-8000-0000000000d1', null, null, null, 'f2000005-0000-4000-8000-0000000000e1');

insert into public.membership_role_assignments (id, tenant_id, membership_id, role_id, access_scope_id, assigned_at)
values
  -- full: tenant-wide all three
  ('f2000016-0000-4000-8000-000000000001', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000001', 'f2000013-0000-4000-8000-000000000001', 'f2000014-0000-4000-8000-000000000001', now() - interval '1 day'),
  -- explicit: BrandA catalog, LA inventory, BrandA+BranchA orders
  ('f2000016-0000-4000-8000-0000000000a1', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000002', 'f2000013-0000-4000-8000-0000000000a1', 'f2000014-0000-4000-8000-0000000000a1', now() - interval '1 day'),
  ('f2000016-0000-4000-8000-0000000000a2', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000002', 'f2000013-0000-4000-8000-0000000000a2', 'f2000014-0000-4000-8000-0000000000a2', now() - interval '1 day'),
  ('f2000016-0000-4000-8000-0000000000a3', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000002', 'f2000013-0000-4000-8000-0000000000a3', 'f2000014-0000-4000-8000-0000000000a3', now() - interval '1 day'),
  -- wrong-kind: catalog->branch, inventory->brand, orders->warehouse
  ('f2000016-0000-4000-8000-0000000000b1', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000003', 'f2000013-0000-4000-8000-0000000000b1', 'f2000014-0000-4000-8000-0000000000b1', now() - interval '1 day'),
  ('f2000016-0000-4000-8000-0000000000b2', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000003', 'f2000013-0000-4000-8000-0000000000b2', 'f2000014-0000-4000-8000-0000000000b2', now() - interval '1 day'),
  ('f2000016-0000-4000-8000-0000000000b3', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000003', 'f2000013-0000-4000-8000-0000000000b3', 'f2000014-0000-4000-8000-0000000000b3', now() - interval '1 day'),
  -- noperm: orders-only tenant-wide (no catalog/inventory permission at all)
  ('f2000016-0000-4000-8000-0000000000c1', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000004', 'f2000013-0000-4000-8000-0000000000c1', 'f2000014-0000-4000-8000-000000000001', now() - interval '1 day'),
  -- writer: tenant-wide inventory read + receive/adjust/transfer across all locations
  ('f2000016-0000-4000-8000-0000000000d1', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000007', 'f2000013-0000-4000-8000-0000000000d1', 'f2000014-0000-4000-8000-000000000001', now() - interval '1 day'),
  -- write-scoped: same write role but explicitly scoped to Location A only
  ('f2000016-0000-4000-8000-0000000000d2', 'f2000001-0000-4000-8000-000000000001', 'f2000012-0000-4000-8000-000000000008', 'f2000013-0000-4000-8000-0000000000d1', 'f2000014-0000-4000-8000-0000000000d1', now() - interval '1 day');

commit;
