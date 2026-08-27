-- Phase 2D (5/5): deny-by-default RLS and grants for the order tables.
--
-- Orders are commercially sensitive and will later carry customer-related data, so the stance is
-- deliberately STRICTER than the catalog/inventory tables: authenticated has NO direct access at all
-- (no tenant-wide SELECT backstop). Every order read/write flows through the server-side application
-- repository, which uses the service-role client. The privilege boundary matches Phase 2B/2C:
-- service_role holds SELECT on orders/order_lines and may EXECUTE only the sanctioned functions; it
-- has NO direct INSERT/UPDATE/DELETE. All writes run as orders_writer inside the definer functions.

alter table public.orders enable row level security;
alter table public.order_lines enable row level security;
alter table public.order_number_sequences enable row level security;

-- No policy is created for any role: RLS enabled with zero permissive policies denies all non-bypass
-- access. anon and authenticated therefore cannot SELECT or mutate. service_role and the table owner
-- (orders_writer) bypass RLS as the documented infrastructure path.

do $block$
declare
  table_name text;
  order_tables constant text[] := array['orders', 'order_lines', 'order_number_sequences'];
begin
  foreach table_name in array order_tables loop
    execute pg_catalog.format('revoke all privileges on table public.%I from public', table_name);
  end loop;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    foreach table_name in array order_tables loop
      execute pg_catalog.format('revoke all privileges on table public.%I from anon', table_name);
    end loop;
    execute 'revoke all on schema orders_private from anon';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    foreach table_name in array order_tables loop
      execute pg_catalog.format('revoke all privileges on table public.%I from authenticated', table_name);
    end loop;
    execute 'revoke all on schema orders_private from authenticated';
  end if;

  -- service_role: SELECT on orders/order_lines only (the repository reads through it). NO select on
  -- order_number_sequences (writer-internal). NO direct DML on any order table. EXECUTE only the
  -- sanctioned functions.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'revoke all privileges on table public.order_number_sequences from service_role';
    execute 'grant select on table public.orders to service_role';
    execute 'grant select on table public.order_lines to service_role';
    execute 'grant usage on schema orders_private to service_role';
    execute 'grant execute on function orders_private.resolve_idempotent_replay_target(uuid, text, jsonb) to service_role';
    execute 'grant execute on function orders_private.create_order('
      || 'uuid, text, text, uuid, uuid, uuid, uuid, text, timestamptz, text, jsonb) to service_role';
    execute 'grant execute on function orders_private.cancel_order(uuid, uuid, uuid, text) to service_role';
  end if;
end;
$block$;
