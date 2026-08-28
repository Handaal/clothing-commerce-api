\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(condition boolean, label text)
returns void
language plpgsql
as $function$
begin
  if condition is distinct from true then
    raise exception 'assertion failed: %', label;
  end if;
end;
$function$;

create or replace function pg_temp.assert_raises(statement text, expected_state text, label text)
returns void
language plpgsql
as $function$
declare
  actual_state text;
begin
  begin
    execute statement;
  exception
    when others then
      get stacked diagnostics actual_state = returned_sqlstate;
      if actual_state = expected_state then
        return;
      end if;
      raise exception 'assertion failed: %, expected SQLSTATE %, received %',
        label, expected_state, actual_state;
  end;

  raise exception 'assertion failed: %, expected SQLSTATE %, but statement succeeded',
    label, expected_state;
end;
$function$;

-- =====================================================================================================
-- Fixtures. One tenant with a brand, one product, two variants, a branch, three inventory locations
-- (active+enabled, active+not-enabled, inactive+enabled), opening stock, and three placed online orders.
-- =====================================================================================================
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('10000000-0000-4000-8000-000000000001', 'ff-a', 'FF A', 'active', 'completed', 'USD'),
  ('10000000-0000-4000-8000-000000000002', 'ff-b', 'FF B', 'active', 'completed', 'USD');

insert into public.user_identities (id, display_name, primary_email)
values ('70000000-0000-4000-8000-000000000001', 'FF User', 'ff@example.test');

insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
values ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Tee', 'tee', 'active');

insert into public.product_variants (id, tenant_id, product_id, sku, option_signature, status)
values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'TEE-M', 'm', 'active'),
  ('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'TEE-L', 'l', 'active');

insert into public.branches (id, tenant_id, code, display_name, timezone, status)
values ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRA', 'Branch A', 'UTC', 'active');

insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type, status, is_fulfillment_enabled)
values
  ('e0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC1', 'Loc 1', 'store', 'active', true),
  ('e0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC2', 'Loc 2', 'store', 'active', false),
  ('e0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC3', 'Loc 3', 'store', 'inactive', true);

select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 100);
select inventory_private.record_opening('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 100);

create temp table ff_order_a on commit drop as
  select orders_private.create_order(
    '10000000-0000-4000-8000-000000000001', 'online', 'USD', '20000000-0000-4000-8000-000000000001', null, null, null,
    'order-a', null, null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":5,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-M"},
      {"variant_id":"60000000-0000-4000-8000-000000000002","product_id":"30000000-0000-4000-8000-000000000001","quantity":3,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-L"}]'::jsonb
  ) as order_id;

create temp table ff_order_b on commit drop as
  select orders_private.create_order(
    '10000000-0000-4000-8000-000000000001', 'online', 'USD', '20000000-0000-4000-8000-000000000001', null, null, null,
    'order-b', null, null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":5,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-M"}]'::jsonb
  ) as order_id;

create temp table ff_order_c on commit drop as
  select orders_private.create_order(
    '10000000-0000-4000-8000-000000000001', 'online', 'USD', '20000000-0000-4000-8000-000000000001', null, null, null,
    'order-c', null, null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":2,"unit_price_minor":1000,"product_name":"Tee","sku":"TEE-M"}]'::jsonb
  ) as order_id;

-- Order line ids (generated) for order A, keyed by variant.
create temp table ff_a_lines on commit drop as
  select id, variant_id from public.order_lines where order_id = (select order_id from ff_order_a);
create temp table ff_b_lines on commit drop as
  select id, variant_id from public.order_lines where order_id = (select order_id from ff_order_b);
create temp table ff_c_lines on commit drop as
  select id, variant_id from public.order_lines where order_id = (select order_id from ff_order_c);

-- =====================================================================================================
-- Structural + privilege invariants.
-- =====================================================================================================
select pg_temp.assert_true(to_regclass('public.fulfillments') is not null, 'fulfillments table exists');
select pg_temp.assert_true(to_regclass('public.fulfillment_lines') is not null, 'fulfillment_lines table exists');

-- No status column (a row existing means the physical execution happened) and no updated_at (immutable).
select pg_temp.assert_true(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'fulfillments' and column_name = 'status'
  ),
  'fulfillments has no status column'
);
select pg_temp.assert_true(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'fulfillments' and column_name = 'updated_at'
  ),
  'fulfillments has no updated_at column'
);

select pg_temp.assert_true(
  (select is_nullable = 'NO' from information_schema.columns
   where table_schema = 'public' and table_name = 'fulfillments' and column_name = 'inventory_operation_id'),
  'fulfillments.inventory_operation_id is NOT NULL'
);
select pg_temp.assert_true(
  (select is_nullable = 'NO' from information_schema.columns
   where table_schema = 'public' and table_name = 'fulfillments' and column_name = 'idempotency_key'),
  'fulfillments.idempotency_key is NOT NULL'
);

-- One InventoryOperation per Fulfillment: a unique key on (tenant_id, inventory_operation_id).
select pg_temp.assert_true(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.fulfillments'::regclass and contype = 'u'
      and conname = 'fulfillments_operation_unique'
  ),
  'fulfillments enforce one inventory operation per fulfillment'
);

-- RLS enabled, never forced, on both tables.
select pg_temp.assert_true(
  (select bool_and(relrowsecurity and not relforcerowsecurity)
   from pg_catalog.pg_class
   where oid in ('public.fulfillments'::regclass, 'public.fulfillment_lines'::regclass)),
  'RLS is enabled and not forced on the fulfillment tables'
);

-- No policy targets anon or authenticated on either table (deny by default for clients).
select pg_temp.assert_true(
  (select count(*) = 0
   from pg_catalog.pg_policies
   where schemaname = 'public' and tablename in ('fulfillments', 'fulfillment_lines')
     and (roles && array['anon', 'authenticated']::name[])),
  'no fulfillment policy targets anon or authenticated'
);

-- The two commanding functions are SECURITY DEFINER, empty search_path, owned by fulfillments_writer.
select pg_temp.assert_true(
  (select count(*) = 2
   from pg_catalog.pg_proc procedure
   join pg_catalog.pg_namespace ns on ns.oid = procedure.pronamespace
   join pg_catalog.pg_roles owner on owner.oid = procedure.proowner
   where ns.nspname = 'fulfillments_private'
     and procedure.proname in ('record_fulfillment', 'resolve_fulfillment_replay_target')
     and procedure.prosecdef and procedure.proconfig @> array['search_path=""']
     and owner.rolname = 'fulfillments_writer'),
  'the fulfillment command functions are SECURITY DEFINER, empty search_path, owned by fulfillments_writer'
);

select pg_temp.assert_true(
  (select not rolcanlogin and not rolbypassrls from pg_catalog.pg_roles where rolname = 'fulfillments_writer'),
  'fulfillments_writer is non-login and non-bypassrls'
);

-- record_fulfillment_issue lives in inventory_private, is SECURITY DEFINER, owned by inventory_writer.
select pg_temp.assert_true(
  (select procedure.prosecdef and owner.rolname = 'inventory_writer'
     and procedure.proconfig @> array['search_path=""']
   from pg_catalog.pg_proc procedure
   join pg_catalog.pg_namespace ns on ns.oid = procedure.pronamespace
   join pg_catalog.pg_roles owner on owner.oid = procedure.proowner
   where ns.nspname = 'inventory_private' and procedure.proname = 'record_fulfillment_issue'),
  'record_fulfillment_issue is SECURITY DEFINER owned by inventory_writer'
);

-- Only fulfillments_writer may execute record_fulfillment_issue; service_role and clients cannot.
select pg_temp.assert_true(
  (select has_function_privilege('fulfillments_writer', procedure.oid, 'EXECUTE')
     and not has_function_privilege('service_role', procedure.oid, 'EXECUTE')
     and not has_function_privilege('public', procedure.oid, 'EXECUTE')
     and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
   from pg_catalog.pg_proc procedure
   join pg_catalog.pg_namespace ns on ns.oid = procedure.pronamespace
   where ns.nspname = 'inventory_private' and procedure.proname = 'record_fulfillment_issue'),
  'only fulfillments_writer may execute record_fulfillment_issue'
);

-- fulfillments_writer may NOT execute the generic record_operation.
select pg_temp.assert_true(
  (select not has_function_privilege('fulfillments_writer', procedure.oid, 'EXECUTE')
   from pg_catalog.pg_proc procedure
   join pg_catalog.pg_namespace ns on ns.oid = procedure.pronamespace
   where ns.nspname = 'inventory_private' and procedure.proname = 'record_operation'),
  'fulfillments_writer cannot execute the generic record_operation'
);

-- inventory_writer may SELECT inventory_locations but never mutate it.
select pg_temp.assert_true(
  has_table_privilege('inventory_writer', 'public.inventory_locations', 'SELECT')
    and not has_table_privilege('inventory_writer', 'public.inventory_locations', 'INSERT')
    and not has_table_privilege('inventory_writer', 'public.inventory_locations', 'UPDATE')
    and not has_table_privilege('inventory_writer', 'public.inventory_locations', 'DELETE'),
  'inventory_writer has SELECT-only on inventory_locations'
);

-- service_role: SELECT on the two tables, NO direct DML.
select pg_temp.assert_true(
  has_table_privilege('service_role', 'public.fulfillments', 'SELECT')
    and has_table_privilege('service_role', 'public.fulfillment_lines', 'SELECT'),
  'service_role may select the fulfillment tables'
);
select pg_temp.assert_true(
  not has_table_privilege('service_role', 'public.fulfillments', 'INSERT')
    and not has_table_privilege('service_role', 'public.fulfillments', 'UPDATE')
    and not has_table_privilege('service_role', 'public.fulfillments', 'DELETE')
    and not has_table_privilege('service_role', 'public.fulfillment_lines', 'INSERT')
    and not has_table_privilege('service_role', 'public.fulfillment_lines', 'UPDATE')
    and not has_table_privilege('service_role', 'public.fulfillment_lines', 'DELETE'),
  'service_role holds no direct DML on the fulfillment tables'
);

-- service_role may EXECUTE the two sanctioned functions but NOT the internal fingerprint helper.
select pg_temp.assert_true(
  (select bool_and(has_function_privilege('service_role', procedure.oid, 'EXECUTE'))
   from pg_catalog.pg_proc procedure
   join pg_catalog.pg_namespace ns on ns.oid = procedure.pronamespace
   where ns.nspname = 'fulfillments_private'
     and procedure.proname in ('record_fulfillment', 'resolve_fulfillment_replay_target')),
  'service_role may execute the sanctioned fulfillment functions'
);
select pg_temp.assert_true(
  (select not has_function_privilege('service_role', procedure.oid, 'EXECUTE')
   from pg_catalog.pg_proc procedure
   join pg_catalog.pg_namespace ns on ns.oid = procedure.pronamespace
   where ns.nspname = 'fulfillments_private' and procedure.proname = 'fulfillment_intent_fingerprint'),
  'service_role cannot execute the internal fingerprint helper'
);

-- orders_writer gained the narrow SELECT on fulfillments (for the cancellation guard) but no DML.
select pg_temp.assert_true(
  has_table_privilege('orders_writer', 'public.fulfillments', 'SELECT')
    and not has_table_privilege('orders_writer', 'public.fulfillments', 'INSERT')
    and not has_table_privilege('orders_writer', 'public.fulfillments', 'UPDATE')
    and not has_table_privilege('orders_writer', 'public.fulfillments', 'DELETE'),
  'orders_writer has narrow SELECT-only on fulfillments'
);

-- anon/authenticated have no access to the fulfillment tables.
select pg_temp.assert_true(
  not has_table_privilege('anon', 'public.fulfillments', 'SELECT')
    and not has_table_privilege('authenticated', 'public.fulfillments', 'SELECT')
    and not has_table_privilege('anon', 'public.fulfillment_lines', 'SELECT')
    and not has_table_privilege('authenticated', 'public.fulfillment_lines', 'SELECT'),
  'anon and authenticated cannot select the fulfillment tables'
);

-- orders.fulfill permission is seeded in the catalog...
select pg_temp.assert_true(
  exists (select 1 from public.permissions where key = 'orders.fulfill'),
  'orders.fulfill permission is provisioned'
);
-- ...but never assigned to any Role (catalog provisioning is not granting).
select pg_temp.assert_true(
  not exists (
    select 1 from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where p.key = 'orders.fulfill'
  ),
  'orders.fulfill is not assigned to any role'
);

-- =====================================================================================================
-- Functional invariants.
-- =====================================================================================================

-- Happy path: fulfill 2 of order A variant 1 from LOC1.
create temp table ff1 on commit drop as
  select * from fulfillments_private.record_fulfillment(
    '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_a), 'e0000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001', 'ff-a-1', null,
    (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 2))
     from ff_a_lines where variant_id = '60000000-0000-4000-8000-000000000001')
  );

select pg_temp.assert_true(
  (select count(*) = 1 from public.fulfillments where order_id = (select order_id from ff_order_a)),
  'one fulfillment exists for order A'
);
select pg_temp.assert_true(
  (select count(*) = 1 and bool_and(quantity = 2 and variant_id = '60000000-0000-4000-8000-000000000001')
   from public.fulfillment_lines where fulfillment_id = (select fulfillment_id from ff1)),
  'the fulfillment has one line for variant 1 quantity 2 with the server-derived variant'
);
select pg_temp.assert_true(
  (select on_hand_quantity = 98 from public.inventory_balances
   where variant_id = '60000000-0000-4000-8000-000000000001' and inventory_location_id = 'e0000000-0000-4000-8000-000000000001'),
  'on-hand at LOC1 dropped from 100 to 98'
);
select pg_temp.assert_true(
  (select operation_type = 'issue' from public.inventory_operations where id = (select inventory_operation_id from ff1)),
  'the linked inventory operation has type issue'
);
select pg_temp.assert_true(
  (select count(*) = 1 and bool_and(quantity_delta = -2)
   from public.inventory_movements where operation_id = (select inventory_operation_id from ff1)),
  'the inventory operation carries exactly one negative movement of -2'
);

-- Replay: same key + intent returns the SAME ids and issues nothing further.
create temp table ff1_replay on commit drop as
  select * from fulfillments_private.record_fulfillment(
    '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_a), 'e0000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001', 'ff-a-1', null,
    (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 2))
     from ff_a_lines where variant_id = '60000000-0000-4000-8000-000000000001')
  );
select pg_temp.assert_true(
  (select r.fulfillment_id = (select fulfillment_id from ff1)
     and r.inventory_operation_id = (select inventory_operation_id from ff1)
   from ff1_replay r),
  'replaying the same key + intent returns the original ids'
);
select pg_temp.assert_true(
  (select on_hand_quantity = 98 from public.inventory_balances
   where variant_id = '60000000-0000-4000-8000-000000000001' and inventory_location_id = 'e0000000-0000-4000-8000-000000000001'),
  'replay did not issue stock a second time'
);

-- Same key, different intent -> ID409.
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_a), 'e0000000-0000-4000-8000-000000000001',
      '71000000-0000-4000-8000-000000000001', 'ff-a-1', null,
      (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 3))
       from ff_a_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  'ID409',
  'same key with a different intent is an idempotency conflict'
);

-- Over-fulfillment: remaining on variant 1 is 3; requesting 4 fails.
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_a), 'e0000000-0000-4000-8000-000000000001',
      '71000000-0000-4000-8000-000000000001', 'ff-a-over', null,
      (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 4))
       from ff_a_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  'FF013',
  'over-fulfilling an order line is rejected'
);

-- Fulfill the remaining 3; the line is then fully fulfilled and on-hand is 95.
create temp table ff2 on commit drop as
  select * from fulfillments_private.record_fulfillment(
    '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_a), 'e0000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001', 'ff-a-2', null,
    (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 3))
     from ff_a_lines where variant_id = '60000000-0000-4000-8000-000000000001')
  );
select pg_temp.assert_true(
  (select on_hand_quantity = 95 from public.inventory_balances
   where variant_id = '60000000-0000-4000-8000-000000000001' and inventory_location_id = 'e0000000-0000-4000-8000-000000000001'),
  'the second fulfillment issued the remaining 3 (on-hand 95)'
);
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_a), 'e0000000-0000-4000-8000-000000000001',
      '71000000-0000-4000-8000-000000000001', 'ff-a-3', null,
      (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 1))
       from ff_a_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  'FF013',
  'a fully fulfilled line has no remainder'
);

-- Location capability: not-enabled (LOC2), inactive (LOC3), and missing all fail before any issue.
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_b), 'e0000000-0000-4000-8000-000000000002',
      null, 'ff-b-loc2', null,
      (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 1))
       from ff_b_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  'FF022',
  'a not-fulfillment-enabled location is rejected'
);
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_b), 'e0000000-0000-4000-8000-000000000003',
      null, 'ff-b-loc3', null,
      (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 1))
       from ff_b_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  'FF021',
  'an inactive location is rejected'
);
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_b), 'e0000000-0000-4000-8000-0000000000ff',
      null, 'ff-b-missing', null,
      (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 1))
       from ff_b_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  'FF020',
  'a missing location is rejected'
);

-- Tenant isolation: the same order id under a different tenant is not found.
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000002', (select order_id from ff_order_b), 'e0000000-0000-4000-8000-000000000001',
      null, 'ff-cross-tenant', null,
      (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 1))
       from ff_b_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  'FF010',
  'an order id under a different tenant is not found'
);

-- Cancellation interaction: an order with zero fulfillments cancels; then it cannot be fulfilled.
select pg_temp.assert_true(
  (select already_cancelled = false and status = 'cancelled'
   from orders_private.cancel_order(
     '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_c),
     '71000000-0000-4000-8000-000000000001', 'no fulfillments yet')),
  'an order with no fulfillments cancels normally'
);
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_c), 'e0000000-0000-4000-8000-000000000001',
      null, 'ff-c-cancelled', null,
      (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 1))
       from ff_c_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  'FF011',
  'a cancelled order cannot be fulfilled'
);
-- An order WITH a fulfillment can no longer be cancelled.
select pg_temp.assert_raises(
  $$select * from orders_private.cancel_order(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_a),
      '71000000-0000-4000-8000-000000000001', 'too late')$$,
  'FF030',
  'an order with a fulfillment cannot be cancelled'
);

-- Immutability of committed fulfillment rows.
select pg_temp.assert_raises(
  $$update public.fulfillments set fulfilled_at = now() where id = (select fulfillment_id from ff1)$$,
  '42501',
  'fulfillments cannot be updated'
);
select pg_temp.assert_raises(
  $$delete from public.fulfillment_lines where fulfillment_id = (select fulfillment_id from ff1)$$,
  '42501',
  'fulfillment lines cannot be deleted'
);

-- Duplicate order line within one request is rejected structurally by the function.
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_b), 'e0000000-0000-4000-8000-000000000001',
      null, 'ff-b-dup', null,
      (select jsonb_build_array(
         jsonb_build_object('order_line_id', id, 'quantity', 1),
         jsonb_build_object('order_line_id', id, 'quantity', 1))
       from ff_b_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  '22023',
  'a duplicate order line within one fulfillment is rejected'
);

-- A negative/zero quantity is rejected structurally by the function.
select pg_temp.assert_raises(
  $$select * from fulfillments_private.record_fulfillment(
      '10000000-0000-4000-8000-000000000001', (select order_id from ff_order_b), 'e0000000-0000-4000-8000-000000000001',
      null, 'ff-b-zero', null,
      (select jsonb_build_array(jsonb_build_object('order_line_id', id, 'quantity', 0))
       from ff_b_lines where variant_id = '60000000-0000-4000-8000-000000000001'))$$,
  '22023',
  'a non-positive quantity is rejected'
);

-- Declarative single-order + variant integrity via direct DML (bypassing the function).
-- A line referencing an OrderLine of a DIFFERENT order than its Fulfillment is rejected.
select pg_temp.assert_raises(
  $$insert into public.fulfillment_lines (tenant_id, fulfillment_id, order_id, order_line_id, variant_id, line_number, quantity)
    select '10000000-0000-4000-8000-000000000001', (select fulfillment_id from ff1), (select order_id from ff_order_a),
      (select id from ff_b_lines where variant_id = '60000000-0000-4000-8000-000000000001'),
      '60000000-0000-4000-8000-000000000001', 98, 1$$,
  '23503',
  'a fulfillment line whose order line belongs to another order is rejected'
);
-- A line whose variant_id does not match the referenced OrderLine's variant is rejected.
select pg_temp.assert_raises(
  $$insert into public.fulfillment_lines (tenant_id, fulfillment_id, order_id, order_line_id, variant_id, line_number, quantity)
    select '10000000-0000-4000-8000-000000000001', (select fulfillment_id from ff1), (select order_id from ff_order_a),
      (select id from ff_a_lines where variant_id = '60000000-0000-4000-8000-000000000002'),
      '60000000-0000-4000-8000-000000000001', 99, 1$$,
  '23503',
  'a fulfillment line whose variant does not match its order line is rejected'
);

rollback;
