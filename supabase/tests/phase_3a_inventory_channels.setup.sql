-- Disposable ADR-042 channel-stock HTTP integration fixture. Applied after phase_2g_inventory_write.setup.sql
-- by scripts/test-inventory-write-integration.mjs. Seeds variant VG1 at location LGB (12 units, version 1),
-- a stock key no Phase 2G scenario asserts on, so the channel suite owns it.
begin;
select set_config('inventory_private.allow_balance_write', 'on', true);
insert into public.inventory_balances (tenant_id, variant_id, inventory_location_id, on_hand_quantity, version)
values ('f2900001-0000-4000-8000-000000000001', 'f2900008-0000-4000-8000-0000000000a1', 'f2900005-0000-4000-8000-0000000000e2', 12, 1);
select set_config('inventory_private.allow_balance_write', 'off', true);
commit;
