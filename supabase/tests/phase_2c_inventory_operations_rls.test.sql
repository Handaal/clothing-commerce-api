begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

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

-- The two new mutation functions are hardened exactly like record_operation.
select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles as owner on owner.oid = procedure.proowner
    where namespace.nspname = 'inventory_private'
      and procedure.proname in ('record_opening', 'record_count_adjustment')
      and procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
      and owner.rolname = 'inventory_writer'
  ),
  2::bigint,
  'both new functions are SECURITY DEFINER, empty search_path, owned by inventory_writer'
);

-- The dedicated writer role remains non-login and non-bypassrls.
select ok(
  (
    select not rolcanlogin and not rolbypassrls
    from pg_catalog.pg_roles
    where rolname = 'inventory_writer'
  ),
  'inventory_writer is still non-login and non-bypassrls'
);

-- Only service_role may execute each new function; PUBLIC, anon, and authenticated cannot.
select ok(
  (
    select bool_and(
      has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      and not has_function_privilege('public', procedure.oid, 'EXECUTE')
      and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
    )
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'inventory_private'
      and procedure.proname in ('record_opening', 'record_count_adjustment')
  ),
  'only service_role may execute the new inventory functions'
);

select ok(
  not has_schema_privilege('anon', 'inventory_private', 'USAGE'),
  'anon still cannot use the private inventory schema'
);

select ok(
  not has_schema_privilege('authenticated', 'inventory_private', 'USAGE'),
  'authenticated still cannot use the private inventory schema'
);

-- service_role keeps SELECT-only table access; Phase 2C adds no direct DML.
select is(
  (
    select count(*)
    from unnest(array['inventory_operations', 'inventory_movements', 'inventory_balances']) as table_name
    where has_table_privilege('service_role', format('public.%I', table_name), 'SELECT')
      and not has_table_privilege('service_role', format('public.%I', table_name), 'INSERT')
      and not has_table_privilege('service_role', format('public.%I', table_name), 'UPDATE')
      and not has_table_privilege('service_role', format('public.%I', table_name), 'DELETE')
  ),
  3::bigint,
  'service_role retains SELECT-only inventory grants after Phase 2C'
);

-- The operation_type CHECK now admits the generic issue exit.
select ok(
  (
    select pg_catalog.pg_get_constraintdef(oid) like '%''issue''%'
    from pg_catalog.pg_constraint
    where conname = 'inventory_operations_type_valid'
  ),
  'operation_type CHECK admits issue'
);

-- Privileged fixtures used to prove client roles cannot execute the functions.
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values ('10000000-0000-4000-8000-000000000001', 'inv-ops-rls', 'Inventory Ops RLS', 'active', 'completed', 'USD');

insert into public.user_identities (id, display_name, primary_email)
values ('70000000-0000-4000-8000-000000000001', 'Ops User', 'ops-rls@example.test');

insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
values ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'P', 'p', 'active');

insert into public.product_variants (id, tenant_id, product_id, sku, status)
values ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'SKU-A', 'active');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRA', 'Branch A', 'UTC');

insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type, is_receiving_enabled)
values ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A', 'Floor A', 'sales_floor', true);

-- A committed opening so service_role read visibility can be checked.
select inventory_private.record_opening(
  '10000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  5,
  '71000000-0000-4000-8000-000000000001',
  'rls-open'
);

set local role authenticated;
set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000001"}';

select ok(
  pg_temp.statement_raises(
    $$select inventory_private.record_opening(
        '10000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        1, null, 'rls-auth-open')$$,
    '42501'
  ),
  'authenticated cannot execute record_opening'
);

select ok(
  pg_temp.statement_raises(
    $$select inventory_private.record_count_adjustment(
        '10000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        2, 1, null, 'rls-auth-adj')$$,
    '42501'
  ),
  'authenticated cannot execute record_count_adjustment'
);

select is(
  (select count(*) from public.inventory_balances),
  1::bigint,
  'authenticated still reads its own tenant balances'
);

reset role;
set local role anon;
select ok(
  pg_temp.statement_raises(
    $$select inventory_private.record_opening(
        '10000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        1, null, 'rls-anon-open')$$,
    '42501'
  ),
  'anon cannot execute record_opening'
);

reset role;
select * from finish();

rollback;
