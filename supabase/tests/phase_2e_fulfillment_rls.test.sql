begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

-- The two command functions are hardened exactly like the orders/inventory mutation paths.
select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles as owner on owner.oid = procedure.proowner
    where namespace.nspname = 'fulfillments_private'
      and procedure.proname in ('record_fulfillment', 'resolve_fulfillment_replay_target')
      and procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
      and owner.rolname = 'fulfillments_writer'
  ),
  2::bigint,
  'the fulfillment command functions are SECURITY DEFINER, empty search_path, owned by fulfillments_writer'
);

-- The dedicated writer role is non-login and non-bypassrls.
select ok(
  (
    select not rolcanlogin and not rolbypassrls
    from pg_catalog.pg_roles
    where rolname = 'fulfillments_writer'
  ),
  'fulfillments_writer is non-login and non-bypassrls'
);

-- Only service_role may execute the two sanctioned fulfillment functions; clients cannot.
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
    where namespace.nspname = 'fulfillments_private'
      and procedure.proname in ('record_fulfillment', 'resolve_fulfillment_replay_target')
  ),
  'only service_role may execute the sanctioned fulfillment functions'
);

-- service_role may NOT execute the internal fingerprint helper.
select ok(
  (
    select not has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      and not has_function_privilege('public', procedure.oid, 'EXECUTE')
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'fulfillments_private'
      and procedure.proname = 'fulfillment_intent_fingerprint'
  ),
  'the internal fingerprint helper is not executable by service_role or clients'
);

-- record_fulfillment_issue: fulfillments_writer EXECUTE; service_role and clients NO EXECUTE.
select ok(
  (
    select has_function_privilege('fulfillments_writer', procedure.oid, 'EXECUTE')
      and not has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      and not has_function_privilege('public', procedure.oid, 'EXECUTE')
      and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'inventory_private' and procedure.proname = 'record_fulfillment_issue'
  ),
  'record_fulfillment_issue is executable only by fulfillments_writer'
);

-- fulfillments_writer may NOT execute the generic record_operation.
select ok(
  (
    select bool_and(not has_function_privilege('fulfillments_writer', procedure.oid, 'EXECUTE'))
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'inventory_private' and procedure.proname = 'record_operation'
  ),
  'fulfillments_writer cannot execute the generic inventory record_operation'
);

-- fulfillments_writer holds no direct DML on the inventory tables (custody is only via the sanctioned
-- issue function, which runs as inventory_writer).
select ok(
  not has_table_privilege('fulfillments_writer', 'public.inventory_operations', 'INSERT')
    and not has_table_privilege('fulfillments_writer', 'public.inventory_movements', 'INSERT')
    and not has_table_privilege('fulfillments_writer', 'public.inventory_balances', 'INSERT')
    and not has_table_privilege('fulfillments_writer', 'public.inventory_balances', 'UPDATE'),
  'fulfillments_writer has no direct inventory DML'
);

-- RLS is enabled but not forced on both tables (owner/writer path must remain).
select ok(
  (
    select bool_and(relrowsecurity and not relforcerowsecurity)
    from pg_catalog.pg_class
    where oid in ('public.fulfillments'::regclass, 'public.fulfillment_lines'::regclass)
  ),
  'RLS is enabled and not forced on the fulfillment tables'
);

-- No policy on either table targets anon or authenticated (deny by default for clients).
select is(
  (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('fulfillments', 'fulfillment_lines')
      and (roles && array['anon', 'authenticated']::name[])
  ),
  0::bigint,
  'no fulfillment policy targets anon or authenticated'
);

-- anon has no direct access to the fulfillment tables.
select ok(
  not has_table_privilege('anon', 'public.fulfillments', 'SELECT')
    and not has_table_privilege('anon', 'public.fulfillment_lines', 'SELECT'),
  'anon cannot select the fulfillment tables'
);

-- authenticated is DENIED direct access (no tenant-wide backstop, matching orders).
select ok(
  not has_table_privilege('authenticated', 'public.fulfillments', 'SELECT')
    and not has_table_privilege('authenticated', 'public.fulfillment_lines', 'SELECT'),
  'authenticated cannot select the fulfillment tables directly'
);

-- service_role may SELECT both tables (the repository reads through it).
select ok(
  has_table_privilege('service_role', 'public.fulfillments', 'SELECT')
    and has_table_privilege('service_role', 'public.fulfillment_lines', 'SELECT'),
  'service_role may select the fulfillment tables'
);

-- service_role has NO direct DML on the fulfillment tables.
select ok(
  not has_table_privilege('service_role', 'public.fulfillments', 'INSERT')
    and not has_table_privilege('service_role', 'public.fulfillments', 'UPDATE')
    and not has_table_privilege('service_role', 'public.fulfillments', 'DELETE')
    and not has_table_privilege('service_role', 'public.fulfillment_lines', 'INSERT')
    and not has_table_privilege('service_role', 'public.fulfillment_lines', 'UPDATE')
    and not has_table_privilege('service_role', 'public.fulfillment_lines', 'DELETE'),
  'service_role holds no direct DML on the fulfillment tables'
);

-- inventory_writer may read inventory_locations but never mutate it.
select ok(
  has_table_privilege('inventory_writer', 'public.inventory_locations', 'SELECT')
    and not has_table_privilege('inventory_writer', 'public.inventory_locations', 'UPDATE')
    and not has_table_privilege('inventory_writer', 'public.inventory_locations', 'INSERT')
    and not has_table_privilege('inventory_writer', 'public.inventory_locations', 'DELETE'),
  'inventory_writer has SELECT-only on inventory_locations'
);

select * from finish();

rollback;
