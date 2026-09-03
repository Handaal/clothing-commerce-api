-- Disposable Phase 2G inventory-write integration fixtures. Applied only by
-- scripts/test-inventory-write-integration.mjs after a local Supabase reset. Not a migration or seed.
--
-- Graph summary (tenant TG; foreign tenant TG2 for isolation):
--   Brand BG; Branch BRG; Locations LGA, LGB (both fully write-enabled).
--   Product PG1 (active) -> variant VG1 (active). Seed balance (VG1, LGA) = 10 (version 1).
--   Identities:
--     writer  -> tenant-wide inventory.read + receive + adjust + transfer (read enables the
--                fresh-read -> adjust client contract flow).
--     reader  -> tenant-wide inventory.read only (no write permission).
--     scoped  -> inventory.transfer scoped to LGA ONLY (proves destination-scope enforcement).
--     foreign -> member of TG2 only (proves tenant isolation).

begin;

-- Tenants -------------------------------------------------------------------------------------------
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('f2900001-0000-4000-8000-000000000001', 'inv-write-tg', 'Inventory Write Tenant', 'active', 'completed', 'USD'),
  ('f2900001-0000-4000-8000-000000000002', 'inv-write-tg2', 'Inventory Write Foreign', 'active', 'completed', 'USD');

-- Organization --------------------------------------------------------------------------------------
insert into public.brands (id, tenant_id, code, display_name)
values
  ('f2900002-0000-4000-8000-0000000000a1', 'f2900001-0000-4000-8000-000000000001', 'brand-g', 'Brand G');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values
  ('f2900003-0000-4000-8000-0000000000b1', 'f2900001-0000-4000-8000-000000000001', 'branch-g', 'Branch G', 'UTC');

-- Both write locations are fully capability-enabled (the columns default to false).
insert into public.inventory_locations (
  id, tenant_id, branch_id, warehouse_id, code, display_name, location_type,
  is_receiving_enabled, is_transfer_origin_enabled, is_transfer_destination_enabled
)
values
  ('f2900005-0000-4000-8000-0000000000e1', 'f2900001-0000-4000-8000-000000000001', 'f2900003-0000-4000-8000-0000000000b1', null, 'loc-ga', 'Location GA', 'store', true, true, true),
  ('f2900005-0000-4000-8000-0000000000e2', 'f2900001-0000-4000-8000-000000000001', 'f2900003-0000-4000-8000-0000000000b1', null, 'loc-gb', 'Location GB', 'store', true, true, true);

-- Catalog -------------------------------------------------------------------------------------------
-- One product per variant: a product carries a single default variant (a per-product option-signature
-- uniqueness constraint forbids two default variants under one product).
insert into public.products (id, tenant_id, brand_id, name, slug, style_code, status, created_at)
values
  ('f2900007-0000-4000-8000-0000000000a1', 'f2900001-0000-4000-8000-000000000001', 'f2900002-0000-4000-8000-0000000000a1', 'Gamma One', 'gamma-one', 'SC-G1', 'active', '2026-05-01T00:00:00Z'),
  ('f2900007-0000-4000-8000-0000000000a2', 'f2900001-0000-4000-8000-000000000001', 'f2900002-0000-4000-8000-0000000000a1', 'Gamma Two', 'gamma-two', 'SC-G2', 'active', '2026-05-02T00:00:00Z'),
  ('f2900007-0000-4000-8000-0000000000a3', 'f2900001-0000-4000-8000-000000000001', 'f2900002-0000-4000-8000-0000000000a1', 'Gamma Three', 'gamma-three', 'SC-G3', 'active', '2026-05-03T00:00:00Z'),
  ('f2900007-0000-4000-8000-0000000000a4', 'f2900001-0000-4000-8000-000000000001', 'f2900002-0000-4000-8000-0000000000a1', 'Gamma Four', 'gamma-four', 'SC-G4', 'active', '2026-05-04T00:00:00Z');

-- Four variants so each write scenario owns its own balance row and stays deterministic regardless of
-- test ordering: VG1 -> receive, VG2 -> adjust, VG3 -> transfer (source), VG4 -> read->adjust contract.
insert into public.product_variants (id, tenant_id, product_id, sku, status)
values
  ('f2900008-0000-4000-8000-0000000000a1', 'f2900001-0000-4000-8000-000000000001', 'f2900007-0000-4000-8000-0000000000a1', 'SKU-G1', 'active'),
  ('f2900008-0000-4000-8000-0000000000a2', 'f2900001-0000-4000-8000-000000000001', 'f2900007-0000-4000-8000-0000000000a2', 'SKU-G2', 'active'),
  ('f2900008-0000-4000-8000-0000000000a3', 'f2900001-0000-4000-8000-000000000001', 'f2900007-0000-4000-8000-0000000000a3', 'SKU-G3', 'active'),
  ('f2900008-0000-4000-8000-0000000000a4', 'f2900001-0000-4000-8000-000000000001', 'f2900007-0000-4000-8000-0000000000a4', 'SKU-G4', 'active');

-- Seed known starting balances (all on LGA, version 1) so assertions are deterministic.
select set_config('inventory_private.allow_balance_write', 'on', true);
insert into public.inventory_balances (tenant_id, variant_id, inventory_location_id, on_hand_quantity, version)
values
  ('f2900001-0000-4000-8000-000000000001', 'f2900008-0000-4000-8000-0000000000a1', 'f2900005-0000-4000-8000-0000000000e1', 10, 1),
  ('f2900001-0000-4000-8000-000000000001', 'f2900008-0000-4000-8000-0000000000a2', 'f2900005-0000-4000-8000-0000000000e1', 5, 1),
  ('f2900001-0000-4000-8000-000000000001', 'f2900008-0000-4000-8000-0000000000a3', 'f2900005-0000-4000-8000-0000000000e1', 20, 1),
  ('f2900001-0000-4000-8000-000000000001', 'f2900008-0000-4000-8000-0000000000a4', 'f2900005-0000-4000-8000-0000000000e1', 8, 1);
select set_config('inventory_private.allow_balance_write', 'off', true);

-- Identities ----------------------------------------------------------------------------------------
insert into public.user_identities (id, status)
values
  ('f2900010-0000-4000-8000-000000000001', 'active'),
  ('f2900010-0000-4000-8000-000000000002', 'active'),
  ('f2900010-0000-4000-8000-000000000003', 'active'),
  ('f2900010-0000-4000-8000-000000000006', 'active');

insert into public.user_identity_provider_bindings (id, user_identity_id, provider, provider_subject)
values
  ('f2900011-0000-4000-8000-000000000001', 'f2900010-0000-4000-8000-000000000001', 'clerk', 'clerk-g-writer'),
  ('f2900011-0000-4000-8000-000000000002', 'f2900010-0000-4000-8000-000000000002', 'clerk', 'clerk-g-reader'),
  ('f2900011-0000-4000-8000-000000000003', 'f2900010-0000-4000-8000-000000000003', 'clerk', 'clerk-g-scoped'),
  ('f2900011-0000-4000-8000-000000000006', 'f2900010-0000-4000-8000-000000000006', 'clerk', 'clerk-g-foreign');

insert into public.memberships (id, tenant_id, user_identity_id, status, activated_at, suspended_at)
values
  ('f2900012-0000-4000-8000-000000000001', 'f2900001-0000-4000-8000-000000000001', 'f2900010-0000-4000-8000-000000000001', 'active', now(), null),
  ('f2900012-0000-4000-8000-000000000002', 'f2900001-0000-4000-8000-000000000001', 'f2900010-0000-4000-8000-000000000002', 'active', now(), null),
  ('f2900012-0000-4000-8000-000000000003', 'f2900001-0000-4000-8000-000000000001', 'f2900010-0000-4000-8000-000000000003', 'active', now(), null),
  ('f2900012-0000-4000-8000-000000000006', 'f2900001-0000-4000-8000-000000000002', 'f2900010-0000-4000-8000-000000000006', 'active', now(), null);

-- Roles carrying the write permissions (referenced by key from the migration-seeded catalog).
insert into public.roles (id, tenant_id, name, status, is_protected)
values
  ('f2900013-0000-4000-8000-000000000001', 'f2900001-0000-4000-8000-000000000001', 'Inventory Writer', 'active', false),
  ('f2900013-0000-4000-8000-000000000002', 'f2900001-0000-4000-8000-000000000001', 'Inventory Reader', 'active', false),
  ('f2900013-0000-4000-8000-000000000003', 'f2900001-0000-4000-8000-000000000001', 'Inventory Transferrer', 'active', false);

insert into public.role_permissions (tenant_id, role_id, permission_id)
values
  ('f2900001-0000-4000-8000-000000000001', 'f2900013-0000-4000-8000-000000000001', (select id from public.permissions where key = 'inventory.read')),
  ('f2900001-0000-4000-8000-000000000001', 'f2900013-0000-4000-8000-000000000001', (select id from public.permissions where key = 'inventory.receive')),
  ('f2900001-0000-4000-8000-000000000001', 'f2900013-0000-4000-8000-000000000001', (select id from public.permissions where key = 'inventory.adjust')),
  ('f2900001-0000-4000-8000-000000000001', 'f2900013-0000-4000-8000-000000000001', (select id from public.permissions where key = 'inventory.transfer')),
  ('f2900001-0000-4000-8000-000000000001', 'f2900013-0000-4000-8000-000000000002', (select id from public.permissions where key = 'inventory.read')),
  ('f2900001-0000-4000-8000-000000000001', 'f2900013-0000-4000-8000-000000000003', (select id from public.permissions where key = 'inventory.transfer'));

insert into public.access_scopes (id, tenant_id, name, scope_mode, status)
values
  ('f2900014-0000-4000-8000-000000000001', 'f2900001-0000-4000-8000-000000000001', 'Tenant Wide', 'tenant', 'active'),
  ('f2900014-0000-4000-8000-0000000000a1', 'f2900001-0000-4000-8000-000000000001', 'Location GA Only', 'explicit', 'active');

insert into public.access_scope_targets (id, tenant_id, access_scope_id, brand_id, branch_id, warehouse_id, inventory_location_id)
values
  ('f2900015-0000-4000-8000-0000000000a1', 'f2900001-0000-4000-8000-000000000001', 'f2900014-0000-4000-8000-0000000000a1', null, null, null, 'f2900005-0000-4000-8000-0000000000e1');

insert into public.membership_role_assignments (id, tenant_id, membership_id, role_id, access_scope_id, assigned_at)
values
  -- writer: tenant-wide receive + adjust + transfer
  ('f2900016-0000-4000-8000-000000000001', 'f2900001-0000-4000-8000-000000000001', 'f2900012-0000-4000-8000-000000000001', 'f2900013-0000-4000-8000-000000000001', 'f2900014-0000-4000-8000-000000000001', now() - interval '1 day'),
  -- reader: tenant-wide read only
  ('f2900016-0000-4000-8000-000000000002', 'f2900001-0000-4000-8000-000000000001', 'f2900012-0000-4000-8000-000000000002', 'f2900013-0000-4000-8000-000000000002', 'f2900014-0000-4000-8000-000000000001', now() - interval '1 day'),
  -- scoped: transfer permission but covering ONLY location GA
  ('f2900016-0000-4000-8000-000000000003', 'f2900001-0000-4000-8000-000000000001', 'f2900012-0000-4000-8000-000000000003', 'f2900013-0000-4000-8000-000000000003', 'f2900014-0000-4000-8000-0000000000a1', now() - interval '1 day');

commit;
