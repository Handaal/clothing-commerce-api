-- Phase 2B: deny-by-default tenant RLS and grants for inventory persistence.
-- Inventory mutations are server-side application responsibilities gated by future physical-location
-- authorization; clients never write stock directly and never execute the private mutation path.
-- The privilege boundary is strong: service_role holds SELECT only on the inventory tables and may
-- EXECUTE only inventory_private.record_operation. It has NO direct INSERT/UPDATE/DELETE, so it
-- cannot bypass the ledger to create balance/movement divergence. The function performs every write
-- as the dedicated inventory_writer role that owns the tables.

alter table public.inventory_operations enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.inventory_balances enable row level security;

create policy authenticated_tenant_read on public.inventory_operations
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.inventory_movements
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.inventory_balances
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

do $block$
declare
  table_name text;
  inventory_tables constant text[] := array[
    'inventory_operations',
    'inventory_movements',
    'inventory_balances'
  ];
begin
  foreach table_name in array inventory_tables loop
    execute pg_catalog.format('revoke all privileges on table public.%I from public', table_name);
  end loop;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    foreach table_name in array inventory_tables loop
      execute pg_catalog.format('revoke all privileges on table public.%I from anon', table_name);
    end loop;
    execute 'revoke all on schema inventory_private from anon';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    foreach table_name in array inventory_tables loop
      execute pg_catalog.format('revoke all privileges on table public.%I from authenticated', table_name);
      execute pg_catalog.format('grant select on table public.%I to authenticated', table_name);
    end loop;
    execute 'revoke all on schema inventory_private from authenticated';
  end if;

  -- service_role receives SELECT only. It deliberately has NO direct INSERT/UPDATE/DELETE on any
  -- inventory table, and may EXECUTE only the hardened mutation function (not the trigger helpers).
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    foreach table_name in array inventory_tables loop
      execute pg_catalog.format('grant select on table public.%I to service_role', table_name);
    end loop;
    execute 'grant usage on schema inventory_private to service_role';
    execute 'grant execute on function inventory_private.record_operation('
      || 'uuid, text, jsonb, uuid, text, timestamptz, text) to service_role';
  end if;
end;
$block$;
