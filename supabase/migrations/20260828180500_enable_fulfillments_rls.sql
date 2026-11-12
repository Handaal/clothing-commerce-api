-- Phase 2E (6/7): deny-by-default RLS and the complete Phase 2E privilege graph.
--
-- Fulfillments carry commercially sensitive execution data, so the stance matches Orders: authenticated
-- has NO direct access at all (no tenant-wide SELECT). Every read flows through the server-side
-- repository on the service-role client; every write flows through the sanctioned functions running as
-- fulfillments_writer. service_role holds SELECT on the two tables and EXECUTE only on the sanctioned
-- functions; it has NO direct INSERT/UPDATE/DELETE and, critically, NO EXECUTE on
-- inventory_private.record_fulfillment_issue.
--
-- This migration also installs the narrow cross-role read policies the internal writer roles need under
-- the foundational/orders RLS (they are NOBYPASSRLS non-owners): fulfillments_writer must read
-- orders/order_lines to record a Fulfillment, and orders_writer must read fulfillments to enforce the
-- cancellation guard (migration 7).

alter table public.fulfillments enable row level security;
alter table public.fulfillment_lines enable row level security;

-- No permissive policy for anon/authenticated: RLS enabled with zero matching policies denies all
-- non-bypass access. service_role and the table owner (fulfillments_writer) bypass RLS as the
-- documented infrastructure path. RLS is enabled, never FORCED, so the owner keeps its bypass.

do $block$
declare
  table_name text;
  fulfillment_tables constant text[] := array['fulfillments', 'fulfillment_lines'];
begin
  foreach table_name in array fulfillment_tables loop
    execute pg_catalog.format('revoke all privileges on table public.%I from public', table_name);
  end loop;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    foreach table_name in array fulfillment_tables loop
      execute pg_catalog.format('revoke all privileges on table public.%I from anon', table_name);
    end loop;
    execute 'revoke all on schema fulfillments_private from anon';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    foreach table_name in array fulfillment_tables loop
      execute pg_catalog.format('revoke all privileges on table public.%I from authenticated', table_name);
    end loop;
    execute 'revoke all on schema fulfillments_private from authenticated';
  end if;

  -- service_role: SELECT on the two tables (the repository reads through it) and EXECUTE only on the
  -- two sanctioned RPCs. NO direct DML; NO execute on the internal fingerprint helper; and NO execute
  -- on inventory_private.record_fulfillment_issue (asserted in the RLS test).
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant select on table public.fulfillments to service_role';
    execute 'grant select on table public.fulfillment_lines to service_role';
    execute 'grant usage on schema fulfillments_private to service_role';
    execute 'grant execute on function fulfillments_private.resolve_fulfillment_replay_target(uuid, text, jsonb) to service_role';
    execute 'grant execute on function fulfillments_private.record_fulfillment('
      || 'uuid, uuid, uuid, uuid, text, timestamptz, jsonb) to service_role';
  end if;
end;
$block$;

-- fulfillments_writer reads orders/order_lines inside record_fulfillment and the replay preflight. It
-- is a NOBYPASSRLS non-owner, so under the Orders RLS (enabled, zero policies) a SELECT grant alone
-- returns nothing. Grant SELECT AND add narrow permissive read policies scoped to this internal role.
-- It gets NO DML on either table.
grant select on table public.orders to fulfillments_writer;
grant select on table public.order_lines to fulfillments_writer;

create policy fulfillments_writer_order_read
on public.orders
for select
to fulfillments_writer
using (true);

create policy fulfillments_writer_order_line_read
on public.order_lines
for select
to fulfillments_writer
using (true);

comment on policy fulfillments_writer_order_read on public.orders is
  'Lets record_fulfillment / the replay preflight (running as fulfillments_writer) read Order status and commercial routing. Read-only; fulfillments_writer holds no Order DML.';

-- orders_writer reads fulfillments inside cancel_order (migration 7) to enforce the "no cancellation
-- once fulfilled" guard. It is a NOBYPASSRLS non-owner of fulfillments, so it needs SELECT plus a
-- narrow permissive read policy. It gets NO fulfillment DML.
grant select on table public.fulfillments to orders_writer;

create policy orders_writer_fulfillment_read
on public.fulfillments
for select
to orders_writer
using (true);

comment on policy orders_writer_fulfillment_read on public.fulfillments is
  'Lets cancel_order (running as orders_writer) detect any existing Fulfillment before cancelling. Read-only; orders_writer holds no fulfillment DML.';
