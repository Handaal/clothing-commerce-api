begin;

create extension if not exists pgtap with schema extensions;

select plan(30);

create or replace function pg_temp.statement_raises(statement text, expected_state text)
returns boolean
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
      return actual_state = expected_state;
  end;

  return false;
end;
$function$;

create or replace function pg_temp.statement_affects_zero(statement text)
returns boolean
language plpgsql
as $function$
declare
  affected_rows bigint;
begin
  execute statement;
  get diagnostics affected_rows = row_count;
  return affected_rows = 0;
exception
  when others then
    return false;
end;
$function$;

-- Policy, helper, and grant structure.
select is(
  (
    select count(*)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relrowsecurity
      and relation.relname = any (
        array['inventory_operations', 'inventory_movements', 'inventory_balances']
      )
  ),
  3::bigint,
  'RLS is enabled on all three inventory tables'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relforcerowsecurity
      and relation.relname = any (
        array['inventory_operations', 'inventory_movements', 'inventory_balances']
      )
  ),
  0::bigint,
  'inventory RLS is intentionally not forced for owners and bypass roles'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and tablename = any (
        array['inventory_operations', 'inventory_movements', 'inventory_balances']
      )
  ),
  3::bigint,
  'all inventory tables have one authenticated SELECT policy'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and cmd <> 'SELECT'
      and tablename = any (
        array['inventory_operations', 'inventory_movements', 'inventory_balances']
      )
  ),
  0::bigint,
  'inventory exposes no authenticated mutation policy'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'inventory_private'
      and procedure.proname in ('forbid_ledger_mutation', 'guard_balance_write')
      and not procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
  ),
  2::bigint,
  'the two inventory trigger helpers are SECURITY INVOKER with an empty fixed search_path'
);

-- The mutation path is a hardened SECURITY DEFINER function owned by the dedicated writer role.
select ok(
  (
    select bool_and(procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
      and owner.rolname = 'inventory_writer')
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles as owner on owner.oid = procedure.proowner
    where namespace.nspname = 'inventory_private'
      and procedure.proname = 'record_operation'
  ),
  'record_operation is SECURITY DEFINER, empty search_path, owned by inventory_writer'
);

select ok(
  not has_schema_privilege('public', 'inventory_private', 'USAGE'),
  'PUBLIC cannot use the private inventory schema'
);

select ok(
  not has_schema_privilege('anon', 'inventory_private', 'USAGE'),
  'anon cannot use the private inventory schema'
);

select ok(
  not has_schema_privilege('authenticated', 'inventory_private', 'USAGE'),
  'authenticated cannot use the private inventory schema'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'inventory_private'
      and has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
  ),
  0::bigint,
  'authenticated cannot execute inventory mutation helpers directly'
);

select is(
  (
    select count(*)
    from unnest(
      array['inventory_operations', 'inventory_movements', 'inventory_balances']
    ) as table_name
    where has_table_privilege('anon', format('public.%I', table_name), 'SELECT')
       or has_table_privilege('anon', format('public.%I', table_name), 'INSERT')
       or has_table_privilege('anon', format('public.%I', table_name), 'UPDATE')
       or has_table_privilege('anon', format('public.%I', table_name), 'DELETE')
  ),
  0::bigint,
  'anon has no inventory table privileges'
);

select is(
  (
    select count(*)
    from unnest(
      array['inventory_operations', 'inventory_movements', 'inventory_balances']
    ) as table_name
    where has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT')
      and not has_table_privilege('authenticated', format('public.%I', table_name), 'INSERT')
      and not has_table_privilege('authenticated', format('public.%I', table_name), 'UPDATE')
      and not has_table_privilege('authenticated', format('public.%I', table_name), 'DELETE')
  ),
  3::bigint,
  'authenticated has read-only grants on all inventory tables'
);

-- F1: service_role holds SELECT only and no direct DML, so it cannot bypass the ledger path.
select is(
  (
    select count(*)
    from unnest(
      array['inventory_operations', 'inventory_movements', 'inventory_balances']
    ) as table_name
    where has_table_privilege('service_role', format('public.%I', table_name), 'SELECT')
      and not has_table_privilege('service_role', format('public.%I', table_name), 'INSERT')
      and not has_table_privilege('service_role', format('public.%I', table_name), 'UPDATE')
      and not has_table_privilege('service_role', format('public.%I', table_name), 'DELETE')
  ),
  3::bigint,
  'service_role has SELECT-only inventory grants and no direct INSERT/UPDATE/DELETE'
);

-- Only service_role may execute the mutation path; clients and PUBLIC cannot.
select ok(
  (
    select bool_and(has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      and not has_function_privilege('public', procedure.oid, 'EXECUTE')
      and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', procedure.oid, 'EXECUTE'))
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'inventory_private'
      and procedure.proname = 'record_operation'
  ),
  'only service_role may execute record_operation'
);

-- Privileged fixtures: one inventory graph per tenant, created only through the ledger path.
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('10000000-0000-4000-8000-000000000001', 'inv-rls-a', 'Inventory RLS A', 'active', 'completed', 'USD'),
  ('10000000-0000-4000-8000-000000000002', 'inv-rls-b', 'Inventory RLS B', 'active', 'completed', 'EUR');

insert into public.user_identities (id, display_name, primary_email)
values
  ('70000000-0000-4000-8000-000000000001', 'Active Inv User', 'active-inv@example.test'),
  ('70000000-0000-4000-8000-000000000002', 'Suspended Inv User', 'suspended-inv@example.test');

insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at, suspended_at)
values
  ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now(), null),
  ('71000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'active', now(), now(), null),
  ('71000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002', 'suspended', now(), now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'B', 'Brand B');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Product A', 'product-a', 'active'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Product B', 'product-b', 'active');

insert into public.product_variants (id, tenant_id, product_id, sku, status)
values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'SKU-A', 'active'),
  ('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'SKU-B', 'active');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRA', 'Branch A', 'UTC'),
  ('b0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'BRB', 'Branch B', 'UTC');

insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type)
values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A', 'Floor A', 'sales_floor'),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'LOC-B', 'Floor B', 'sales_floor');

select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'opening',
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":5}]'::jsonb,
  '71000000-0000-4000-8000-000000000001'
);

select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000002',
  'opening',
  '[{"variant_id":"60000000-0000-4000-8000-000000000002","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":7}]'::jsonb,
  '71000000-0000-4000-8000-000000000002'
);

-- Transaction-local grants let the tests prove RLS itself denies every client mutation.
grant insert, update, delete on
  public.inventory_operations,
  public.inventory_movements,
  public.inventory_balances
to authenticated;

set local role authenticated;
set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000001"}';

select is((select count(*) from public.inventory_operations), 1::bigint, 'active member reads only own operations');
select is((select count(*) from public.inventory_movements), 1::bigint, 'active member reads only own movements');
select is((select count(*) from public.inventory_balances), 1::bigint, 'active member reads only own balances');

select is(
  (
    select count(*) from public.inventory_balances
    where inventory_location_id = '50000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'a known foreign balance location UUID does not bypass RLS'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000002"}';
select is((select count(*) from public.inventory_balances), 1::bigint, 'same user can select the explicitly claimed second tenant');
select is(
  (
    select count(*) from public.inventory_balances
    where inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'switching tenant hides the previously visible balance'
);

set local "request.jwt.claims" = '';
select is((select count(*) from public.inventory_operations), 0::bigint, 'missing claims fail closed for inventory reads');

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000002","tenant_id":"10000000-0000-4000-8000-000000000001"}';
select is((select count(*) from public.inventory_operations), 0::bigint, 'suspended membership fails closed for inventory reads');

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000001"}';
select ok(
  (
    select count(*) = 3
    from unnest(
      array['inventory_operations', 'inventory_movements', 'inventory_balances']
    ) as table_name
    where pg_temp.statement_raises(
      format(
        'insert into public.%I (tenant_id) values (%L)',
        table_name,
        '10000000-0000-4000-8000-000000000001'
      ),
      '42501'
    )
  ),
  'authenticated INSERT is denied on every inventory table'
);

select ok(
  (
    select count(*) = 3
    from unnest(
      array['inventory_operations', 'inventory_movements', 'inventory_balances']
    ) as table_name
    where pg_temp.statement_affects_zero(
      format('update public.%I set tenant_id = tenant_id', table_name)
    )
  ),
  'authenticated UPDATE affects no rows on every inventory table'
);

select ok(
  (
    select count(*) = 3
    from unnest(
      array['inventory_operations', 'inventory_movements', 'inventory_balances']
    ) as table_name
    where pg_temp.statement_affects_zero(format('delete from public.%I', table_name))
  ),
  'authenticated DELETE affects no rows on every inventory table'
);

select ok(
  pg_temp.statement_raises(
    $$select inventory_private.record_operation(
        '10000000-0000-4000-8000-000000000001',
        'opening',
        '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":1}]'::jsonb
      )$$,
    '42501'
  ),
  'authenticated cannot execute the private inventory mutation path'
);

reset role;
set local role service_role;
select is((select count(*) from public.inventory_operations), 2::bigint, 'service_role reads all operations');
select is((select count(*) from public.inventory_movements), 2::bigint, 'service_role reads all movements');
select is((select count(*) from public.inventory_balances), 2::bigint, 'service_role reads all balances');

reset role;
set local role anon;
select ok(
  pg_temp.statement_raises('select count(*) from public.inventory_operations', '42501'),
  'anon cannot turn claim-shaped text into inventory table access'
);

reset role;
select * from finish();

rollback;
