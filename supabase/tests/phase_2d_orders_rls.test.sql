begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- The three order functions are hardened exactly like the inventory mutation path.
select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles as owner on owner.oid = procedure.proowner
    where namespace.nspname = 'orders_private'
      and procedure.proname in ('resolve_idempotent_replay_target', 'create_order', 'cancel_order')
      and procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
      and owner.rolname = 'orders_writer'
  ),
  3::bigint,
  'the three order functions are SECURITY DEFINER, empty search_path, owned by orders_writer'
);

-- The dedicated writer role is non-login and non-bypassrls.
select ok(
  (
    select not rolcanlogin and not rolbypassrls
    from pg_catalog.pg_roles
    where rolname = 'orders_writer'
  ),
  'orders_writer is non-login and non-bypassrls'
);

-- Only service_role may execute each order function; PUBLIC, anon, and authenticated cannot.
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
    where namespace.nspname = 'orders_private'
      and procedure.proname in ('resolve_idempotent_replay_target', 'create_order', 'cancel_order')
  ),
  'only service_role may execute the order functions'
);

-- The trigger helpers are not executable by any client role.
select ok(
  (
    select bool_and(
      not has_function_privilege('public', procedure.oid, 'EXECUTE')
      and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
    )
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'orders_private'
      and procedure.proname in ('forbid_order_line_mutation', 'guard_order_mutation')
  ),
  'the order trigger helpers are not executable by client roles'
);

-- RLS is enabled but not forced on all three tables (owner/writer path must remain).
select ok(
  (
    select bool_and(relrowsecurity and not relforcerowsecurity)
    from pg_catalog.pg_class
    where oid in ('public.orders'::regclass, 'public.order_lines'::regclass, 'public.order_number_sequences'::regclass)
  ),
  'RLS is enabled and not forced on the order tables'
);

-- Deny-by-default for clients: no policy on any order table targets anon or authenticated. Internal,
-- non-login writer roles have only the narrow SELECT policies required for composition.
select is(
  (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('orders', 'order_lines', 'order_number_sequences')
      and (roles && array['anon', 'authenticated']::name[])
  ),
  0::bigint,
  'the order tables carry no client-facing RLS policy (deny by default)'
);

-- Exact internal allowlist: Fulfillment reads Order and lines, Payment reads Order total/currency,
-- connected POS reads the committed net Order total and created lines, offline POS reads created
-- lines, online composition reads orders and lines, Returns reads both for return validation, and
-- Promotions reads both to redeem against committed order facts.
select is(
  (
    select array_agg(
      format(
        '%s|%s|%s|%s|%s|%s|%s',
        tablename,
        policyname,
        permissive,
        array_to_string(roles, ','),
        cmd,
        coalesce(qual, ''),
        coalesce(with_check, '')
      )
      order by tablename, policyname
    )
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('orders', 'order_lines', 'order_number_sequences')
  ),
  array[
    'order_lines|fulfillments_writer_order_line_read|PERMISSIVE|fulfillments_writer|SELECT|true|',
    'order_lines|offline_writer_order_lines|PERMISSIVE|offline_pos_writer|SELECT|true|',
    'order_lines|online_writer_read|PERMISSIVE|online_writer|SELECT|true|',
    'order_lines|pos_sales_writer_order_line_read|PERMISSIVE|pos_sales_writer|SELECT|true|',
    'order_lines|promotions_writer_read|PERMISSIVE|promotions_writer|SELECT|true|',
    'order_lines|returns_writer_read|PERMISSIVE|returns_writer|SELECT|true|',
    'orders|fulfillments_writer_order_read|PERMISSIVE|fulfillments_writer|SELECT|true|',
    'orders|online_writer_read|PERMISSIVE|online_writer|SELECT|true|',
    'orders|payments_writer_order_read|PERMISSIVE|payments_writer|SELECT|true|',
    'orders|pos_sales_writer_order_read|PERMISSIVE|pos_sales_writer|SELECT|true|',
    'orders|promotions_writer_read|PERMISSIVE|promotions_writer|SELECT|true|',
    'orders|returns_writer_read|PERMISSIVE|returns_writer|SELECT|true|'
  ]::text[],
  'the only order-table policies are the sanctioned internal SELECT-only reads'
);

-- anon has no direct access to the order aggregate tables.
select ok(
  not has_table_privilege('anon', 'public.orders', 'SELECT')
    and not has_table_privilege('anon', 'public.order_lines', 'SELECT'),
  'anon cannot select orders or order_lines'
);

-- authenticated is DENIED direct access (stricter than catalog/inventory: no tenant-wide backstop).
select ok(
  not has_table_privilege('authenticated', 'public.orders', 'SELECT')
    and not has_table_privilege('authenticated', 'public.order_lines', 'SELECT'),
  'authenticated cannot select orders or order_lines directly'
);

-- service_role may SELECT the aggregate tables (the repository reads through it).
select ok(
  has_table_privilege('service_role', 'public.orders', 'SELECT')
    and has_table_privilege('service_role', 'public.order_lines', 'SELECT'),
  'service_role may select orders and order_lines'
);

-- service_role has NO direct DML on the aggregate tables.
select ok(
  not has_table_privilege('service_role', 'public.orders', 'INSERT')
    and not has_table_privilege('service_role', 'public.orders', 'UPDATE')
    and not has_table_privilege('service_role', 'public.orders', 'DELETE')
    and not has_table_privilege('service_role', 'public.order_lines', 'INSERT')
    and not has_table_privilege('service_role', 'public.order_lines', 'UPDATE')
    and not has_table_privilege('service_role', 'public.order_lines', 'DELETE'),
  'service_role holds no direct DML on the order aggregate tables'
);

-- The order-number counter is writer-internal: no client role and not even service_role may read it.
select ok(
  not has_table_privilege('service_role', 'public.order_number_sequences', 'SELECT')
    and not has_table_privilege('anon', 'public.order_number_sequences', 'SELECT')
    and not has_table_privilege('authenticated', 'public.order_number_sequences', 'SELECT'),
  'no role may read the order-number counter'
);

select * from finish();

rollback;
