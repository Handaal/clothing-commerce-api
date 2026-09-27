\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(condition boolean, label text)
returns void language plpgsql as $function$
begin
  if condition is distinct from true then raise exception 'assertion failed: %', label; end if;
end;
$function$;

create or replace function pg_temp.assert_raises(statement text, expected_state text, label text)
returns void language plpgsql as $function$
declare actual_state text;
begin
  begin execute statement;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate;
    if actual_state = expected_state then return; end if;
    raise exception 'assertion failed: %, expected SQLSTATE %, received %', label, expected_state, actual_state;
  end;
  raise exception 'assertion failed: %, expected SQLSTATE %, but statement succeeded', label, expected_state;
end;
$function$;

-- ============================ seed ============================
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency, default_timezone) values
  ('2a000000-0000-4000-8000-000000000001','set-a','Settings A','active','completed','USD','UTC'),
  ('2a000000-0000-4000-8000-000000000002','set-b','Settings B','active','completed','EUR','UTC');
insert into public.user_identities (id, display_name, primary_email) values
  ('2b000000-0000-4000-8000-000000000001','Owner','owner@example.test');
insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at) values
  ('2c000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000001','2b000000-0000-4000-8000-000000000001','active',now(),now());

-- ============================ creation + mutation safety (positive) ============================
do $$
declare
  t constant uuid := '2a000000-0000-4000-8000-000000000001';
  actor constant uuid := '2c000000-0000-4000-8000-000000000001';
  v_brand uuid; v_branch uuid; v_branch2 uuid; v_wh uuid;
  v_loc uuid; v_loc2 uuid; v_locw uuid; v_reg uuid; v_reg2 uuid;
  v_dev uuid; v_json jsonb;
begin
  -- Business: freely-mutable profile fields + tax identifier persisted.
  v_json := settings_private.write_business(t, actor, 'biz-1',
    '{"displayName":"Acme Retail","legalName":"Acme LLC","contactEmail":"ops@acme.test","taxIdentifier":"TAX-9"}');
  perform pg_temp.assert_true(v_json->>'displayName' = 'Acme Retail', 'business display_name editable');
  perform pg_temp.assert_true(v_json->>'taxIdentifier' = 'TAX-9', 'tax identifier persisted');
  -- default_currency same value is a no-op while there is no order.
  perform pg_temp.assert_true(
    settings_private.write_business(t, actor, 'biz-2', '{"defaultCurrency":"USD"}')->>'defaultCurrency' = 'USD',
    'default_currency no-op allowed before commercial history');

  -- Brand: create, mutable names, lifecycle archive, not hard-deleted.
  v_brand := (settings_private.write_brand(t, null, actor, 'br-1', '{"code":"A1","displayName":"Brand A1"}')->>'id')::uuid;
  perform pg_temp.assert_true(exists(select 1 from public.brands where id = v_brand and code = 'A1'), 'brand created with code');
  perform pg_temp.assert_true(
    settings_private.write_brand(t, v_brand, actor, 'br-2', '{"displayName":"Brand A1 v2","legalName":"A1 Co"}')->>'displayName' = 'Brand A1 v2',
    'brand names mutable');
  perform pg_temp.assert_true(
    settings_private.write_brand(t, v_brand, actor, 'br-3', '{"status":"archived","archiveReason":"eol"}')->>'status' = 'archived',
    'brand lifecycle archive');
  perform pg_temp.assert_true(exists(select 1 from public.brands where id = v_brand), 'archived brand is not hard-deleted');
  perform settings_private.write_brand(t, v_brand, actor, 'br-4', '{"status":"active"}');

  -- Branch: create with receipt footer; second branch for cross-branch checks.
  v_branch := (settings_private.write_branch(t, null, actor, 'bn-1',
    '{"code":"BR1","displayName":"Main","timezone":"UTC","receiptFooter":"Thank you"}')->>'id')::uuid;
  perform pg_temp.assert_true((settings_private.get_branch(t, v_branch)->>'receiptFooter') = 'Thank you', 'branch receipt_footer persisted');
  v_branch2 := (settings_private.write_branch(t, null, actor, 'bn-2',
    '{"code":"BR2","displayName":"Second","timezone":"UTC"}')->>'id')::uuid;
  perform pg_temp.assert_true(
    settings_private.write_branch(t, v_branch, actor, 'bn-3', '{"status":"inactive"}')->>'status' = 'inactive',
    'branch lifecycle deactivate');
  perform settings_private.write_branch(t, v_branch, actor, 'bn-4', '{"status":"active"}');

  -- Warehouse: create with capability flag, lifecycle.
  v_wh := (settings_private.write_warehouse(t, null, actor, 'wh-1',
    '{"code":"WH1","displayName":"DC","timezone":"UTC","isReceivingEnabled":true}')->>'id')::uuid;
  perform pg_temp.assert_true((settings_private.get_warehouse(t, v_wh)->>'isReceivingEnabled')::boolean, 'warehouse capability flag set');
  perform pg_temp.assert_true(
    settings_private.write_warehouse(t, v_wh, actor, 'wh-2', '{"status":"inactive"}')->>'status' = 'inactive',
    'warehouse lifecycle');

  -- Inventory locations: under branch and under warehouse; capability flag mutable.
  v_loc := (settings_private.write_inventory_location(t, null, actor, 'lo-1',
    jsonb_build_object('branchId', v_branch, 'code', 'L1', 'displayName', 'Floor', 'locationType', 'branch', 'isSellable', true))->>'id')::uuid;
  perform pg_temp.assert_true((settings_private.get_inventory_location(t, v_loc)->>'branchId') = v_branch::text, 'location created under branch');
  v_locw := (settings_private.write_inventory_location(t, null, actor, 'lo-w',
    jsonb_build_object('warehouseId', v_wh, 'code', 'LW', 'displayName', 'Bulk', 'locationType', 'warehouse'))->>'id')::uuid;
  perform pg_temp.assert_true((settings_private.get_inventory_location(t, v_locw)->>'warehouseId') = v_wh::text, 'location created under warehouse');
  perform pg_temp.assert_true(
    (settings_private.write_inventory_location(t, v_loc, actor, 'lo-1b', '{"isFulfillmentEnabled":true}')->>'isFulfillmentEnabled')::boolean,
    'location capability flag mutable');
  v_loc2 := (settings_private.write_inventory_location(t, null, actor, 'lo-2',
    jsonb_build_object('branchId', v_branch2, 'code', 'L2', 'displayName', 'B2 Floor', 'locationType', 'branch'))->>'id')::uuid;

  -- Branch default location must belong to the branch (composite FK); same-branch succeeds.
  perform settings_private.write_branch(t, v_branch, actor, 'bn-5', jsonb_build_object('defaultInventoryLocationId', v_loc));
  perform pg_temp.assert_true((settings_private.get_branch(t, v_branch)->>'defaultInventoryLocationId') = v_loc::text, 'branch default location (same branch)');

  -- Register: create active with a same-branch default location + selling currency.
  v_reg := (settings_private.write_register(t, null, actor, 'rg-1',
    jsonb_build_object('branchId', v_branch, 'code', 'R1', 'displayName', 'Till 1', 'sellingCurrency', 'USD',
      'defaultInventoryLocationId', v_loc, 'status', 'active'))->>'id')::uuid;
  perform pg_temp.assert_true((settings_private.get_register(t, v_reg)->>'status') = 'active', 'register created active');
  -- selling_currency mutable before the register's first sale.
  perform pg_temp.assert_true(
    settings_private.write_register(t, v_reg, actor, 'rg-2', '{"sellingCurrency":"CAD"}')->>'sellingCurrency' = 'CAD',
    'register currency mutable before first sale');
  perform pg_temp.assert_true(
    settings_private.write_register(t, v_reg, actor, 'rg-3', '{"status":"inactive"}')->>'status' = 'inactive',
    'register deactivate');
  perform settings_private.write_register(t, v_reg, actor, 'rg-4', '{"status":"active"}');
  v_reg2 := (settings_private.write_register(t, null, actor, 'rg-5',
    jsonb_build_object('branchId', v_branch, 'code', 'R2', 'displayName', 'Till 2', 'sellingCurrency', 'USD',
      'defaultInventoryLocationId', v_loc, 'status', 'active'))->>'id')::uuid;

  -- Branch brand eligibility set (replace-in-place).
  perform settings_private.set_branch_brands(t, v_branch, actor, 'elig-1', jsonb_build_array(v_brand));
  perform pg_temp.assert_true(
    (settings_private.get_branch(t, v_branch)->'eligibleBrandIds') = jsonb_build_array(v_brand), 'branch brand eligibility set');

  -- Storefront: create (COD on), toggle COD, change routing location. Currency mutable before online order.
  perform pg_temp.assert_true(
    (settings_private.write_storefront(t, v_brand, actor, 'sf-1',
      jsonb_build_object('inventoryLocationId', v_loc, 'currency', 'USD', 'codEnabled', true))->>'codEnabled')::boolean,
    'storefront created with COD on');
  perform pg_temp.assert_true(
    not (settings_private.write_storefront(t, v_brand, actor, 'sf-2', '{"codEnabled":false}')->>'codEnabled')::boolean,
    'storefront COD toggled off');
  perform pg_temp.assert_true(
    (settings_private.write_storefront(t, v_brand, actor, 'sf-3', jsonb_build_object('inventoryLocationId', v_loc2))->>'inventoryLocationId') = v_loc2::text,
    'storefront routing location changed');

  -- Return settings: enable + window + manual refunds + reasons; unconfigured default read is safe.
  perform pg_temp.assert_true(
    (settings_private.write_return_settings(t, actor, 'rs-1',
      '{"enabled":true,"windowDays":30,"manualRefundsEnabled":true,"maxManualRefundMinor":50000,"allowedReasons":["damaged","wrong_size"]}')->>'enabled')::boolean,
    'return settings enabled');
  perform pg_temp.assert_true((settings_private.get_return_settings(t)->>'windowDays') = '30', 'return window persisted');

  -- Devices: enroll (device-side simulation), assign, reassign preserving history, and no key material.
  insert into public.devices (id, tenant_id, installation_id, device_type, display_name, status, activated_at)
  values (gen_random_uuid(), t, 'inst-1', 'pos-terminal', 'Till A', 'active', now()) returning id into v_dev;
  perform settings_private.assign_device(t, v_reg, v_dev, actor, 'as-1', 'initial');
  perform pg_temp.assert_true(
    (settings_private.get_device(t, v_dev)->'currentAssignment'->>'registerId') = v_reg::text, 'device assigned to register');
  perform pg_temp.assert_true(
    not (settings_private.get_device(t, v_dev) ?| array['privateKey','publicKey','credential','secret','keyMaterial']),
    'device projection exposes no key material');
  -- Reassign to a different register: the prior interval closes, history is preserved.
  perform settings_private.assign_device(t, v_reg2, v_dev, actor, 'as-2', 'reassign');
  perform pg_temp.assert_true(
    (settings_private.get_device(t, v_dev)->'currentAssignment'->>'registerId') = v_reg2::text, 'device reassigned');
  perform pg_temp.assert_true(
    (select count(*) from public.register_device_assignments where tenant_id = t and device_id = v_dev) = 2,
    'reassignment preserves the historical interval');
  perform pg_temp.assert_true(
    (select count(*) from public.register_device_assignments where tenant_id = t and device_id = v_dev and unassigned_at is not null) = 1,
    'exactly one closed prior interval');
  -- Revoke ends the current assignment.
  perform settings_private.revoke_device(t, v_dev, actor, 'rv-1', 'lost');
  perform pg_temp.assert_true((settings_private.get_device(t, v_dev)->>'status') = 'revoked', 'device revoked');
  perform pg_temp.assert_true(settings_private.get_device(t, v_dev)->'currentAssignment' = 'null'::jsonb, 'revoke ended the assignment');

  -- Idempotent replay: same key + identical intent returns the stored response.
  perform pg_temp.assert_true(
    (settings_private.write_brand(t, v_brand, actor, 'br-2', '{"displayName":"Brand A1 v2","legalName":"A1 Co"}')->>'displayName') = 'Brand A1 v2',
    'idempotent replay returns stored response');

  -- List surfaces return arrays.
  perform pg_temp.assert_true(jsonb_typeof(settings_private.list_brands(t, null, null, 50)) = 'array', 'list_brands returns array');
  perform pg_temp.assert_true(jsonb_typeof(settings_private.list_devices(t, null, null, 50)) = 'array', 'list_devices returns array');
  perform pg_temp.assert_true(jsonb_array_length(settings_private.list_storefront(t)) = 1, 'list_storefront returns configured brand');
end $$;

-- ============================ mutation safety (negative) ============================
-- Tenant slug/status are read-only: an unknown/forbidden field is rejected outright.
select pg_temp.assert_raises(
  $$ select settings_private.write_business('2a000000-0000-4000-8000-000000000001','2c000000-0000-4000-8000-000000000001','n-slug','{"slug":"hacked"}') $$,
  '22023', 'tenant slug is immutable');

-- Brand code is immutable after creation (absent from the update allowlist).
select pg_temp.assert_raises(
  $$ select settings_private.write_brand('2a000000-0000-4000-8000-000000000001',
       (select id from public.brands where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='a1'),
       '2c000000-0000-4000-8000-000000000001','n-code','{"code":"A2"}') $$,
  '22023', 'brand code immutable');

-- Inventory location parent + location_type are immutable (never re-parented).
select pg_temp.assert_raises(
  $$ select settings_private.write_inventory_location('2a000000-0000-4000-8000-000000000001',
       (select id from public.inventory_locations where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='l1'),
       '2c000000-0000-4000-8000-000000000001','n-loc','{"locationType":"warehouse"}') $$,
  '22023', 'location_type immutable');
select pg_temp.assert_raises(
  $$ select settings_private.write_inventory_location('2a000000-0000-4000-8000-000000000001',
       (select id from public.inventory_locations where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='l1'),
       '2c000000-0000-4000-8000-000000000001','n-reparent',
       jsonb_build_object('branchId','2a000000-0000-4000-8000-000000000001')) $$,
  '22023', 'inventory location is never re-parented');

-- Inventory location requires exactly one parent at creation.
select pg_temp.assert_raises(
  $$ select settings_private.write_inventory_location('2a000000-0000-4000-8000-000000000001', null,
       '2c000000-0000-4000-8000-000000000001','n-xor',
       jsonb_build_object('code','LX','displayName','X','locationType','branch',
         'branchId',(select id from public.branches where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='br1'),
         'warehouseId',(select id from public.warehouses where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='wh1'))) $$,
  '22023', 'inventory location requires exactly one parent');

-- Register branch_id + code are immutable after creation.
select pg_temp.assert_raises(
  $$ select settings_private.write_register('2a000000-0000-4000-8000-000000000001',
       (select id from public.registers where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='r1'),
       '2c000000-0000-4000-8000-000000000001','n-rbranch',
       jsonb_build_object('branchId','2a000000-0000-4000-8000-000000000001')) $$,
  '22023', 'register branch immutable');

-- A register default location from another branch is rejected by the composite FK.
select pg_temp.assert_raises(
  $$ select settings_private.write_register('2a000000-0000-4000-8000-000000000001',
       (select id from public.registers where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='r1'),
       '2c000000-0000-4000-8000-000000000001','n-rloc',
       jsonb_build_object('defaultInventoryLocationId',(select id from public.inventory_locations where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='l2'))) $$,
  '23503', 'register default location must belong to its branch');

-- Idempotency: same key, different intent conflicts.
select pg_temp.assert_raises(
  $$ select settings_private.write_brand('2a000000-0000-4000-8000-000000000001',
       (select id from public.brands where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='a1'),
       '2c000000-0000-4000-8000-000000000001','br-2','{"displayName":"Different"}') $$,
  'ID409', 'idempotency key reused with a different payload conflicts');

-- Tenant isolation: tenant B cannot read tenant A's brand, and sees an empty list.
select pg_temp.assert_raises(
  $$ select settings_private.get_brand('2a000000-0000-4000-8000-000000000002',
       (select id from public.brands where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='a1')) $$,
  'ST404', 'tenant isolation on brand detail');
select pg_temp.assert_true(
  settings_private.list_brands('2a000000-0000-4000-8000-000000000002', null, null, 50) = '[]'::jsonb,
  'tenant isolation on brand list');

-- ============================ currency locks after commercial history ============================
-- A POS order for the register locks its selling currency; a tenant order locks default_currency;
-- an online order for the brand locks the storefront currency. Same value stays a no-op.
insert into public.orders (id, tenant_id, brand_id, branch_id, register_id, order_number, channel, currency, total_minor, gross_subtotal_minor, discount_total_minor)
select gen_random_uuid(), '2a000000-0000-4000-8000-000000000001',
  (select id from public.brands where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='a1'),
  (select id from public.branches where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='br1'),
  (select id from public.registers where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='r1'),
  'POS-1', 'pos', 'CAD', 1000, 1000, 0;
insert into public.orders (id, tenant_id, brand_id, order_number, channel, currency, total_minor, gross_subtotal_minor, discount_total_minor)
select gen_random_uuid(), '2a000000-0000-4000-8000-000000000001',
  (select id from public.brands where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='a1'),
  'ONLINE-1', 'online', 'USD', 2000, 2000, 0;

select pg_temp.assert_raises(
  $$ select settings_private.write_business('2a000000-0000-4000-8000-000000000001','2c000000-0000-4000-8000-000000000001','lock-cur','{"defaultCurrency":"EUR"}') $$,
  'SC409', 'default_currency locked once the tenant has orders');
select pg_temp.assert_true(
  settings_private.write_business('2a000000-0000-4000-8000-000000000001','2c000000-0000-4000-8000-000000000001','nolock-cur','{"defaultCurrency":"USD"}')->>'defaultCurrency' = 'USD',
  'same default_currency remains a no-op after history');
select pg_temp.assert_raises(
  $$ select settings_private.write_register('2a000000-0000-4000-8000-000000000001',
       (select id from public.registers where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='r1'),
       '2c000000-0000-4000-8000-000000000001','lock-rcur','{"sellingCurrency":"USD"}') $$,
  'SC409', 'register selling_currency locked after first sale');
select pg_temp.assert_raises(
  $$ select settings_private.write_storefront('2a000000-0000-4000-8000-000000000001',
       (select id from public.brands where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_code='a1'),
       '2c000000-0000-4000-8000-000000000001','lock-scur','{"currency":"EUR"}') $$,
  'SC409', 'storefront currency locked after first online order');

-- ============================ return policy snapshots are not rewritten ============================
-- A stored return with a policy snapshot is untouched when the tenant edits return settings.
insert into public.inventory_operations (id, tenant_id, operation_type, occurred_at)
values ('2d000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000001','adjustment', now());
insert into public.returns (id, tenant_id, order_id, channel, source, actor_membership_id, currency, amount_minor, normalized_key, intent, policy_snapshot)
select '2e000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000001',
  (select id from public.orders where tenant_id='2a000000-0000-4000-8000-000000000001' and normalized_order_number='pos-1'),
  'pos','management','2c000000-0000-4000-8000-000000000001','CAD',100,'ret-key','{}'::jsonb,
  '{"windowDays":30,"enabled":true}'::jsonb;
select settings_private.write_return_settings('2a000000-0000-4000-8000-000000000001','2c000000-0000-4000-8000-000000000001','rs-2','{"windowDays":7,"enabled":false}');
select pg_temp.assert_true(
  (select policy_snapshot->>'windowDays' from public.returns where id='2e000000-0000-4000-8000-000000000001') = '30',
  'editing return settings does not rewrite an existing return policy snapshot');

rollback;
