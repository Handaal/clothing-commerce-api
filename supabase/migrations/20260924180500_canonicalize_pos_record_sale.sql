-- Phase 2P added promotionCode to record_sale with a default, but changing input arguments creates a
-- PostgreSQL overload even when CREATE OR REPLACE is used. Keep one defaulted canonical entrypoint so
-- both legacy seven-parameter and promotion-aware eight-parameter PostgREST calls resolve uniquely.

drop function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb);

grant create on schema pos_sales_private to pos_sales_writer;
alter function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text)
  owner to pos_sales_writer;
revoke create on schema pos_sales_private from pos_sales_writer;

-- The promotion-aware implementation validates the committed net total after Order creation.
grant select on table public.orders to pos_sales_writer;
create policy pos_sales_writer_order_read on public.orders
  for select to pos_sales_writer using (true);

revoke all on function pos_sales_private.record_sale(
  uuid, uuid, uuid, text, bigint, bigint, jsonb, text
) from public;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text) from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text) from authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text) to service_role';
  end if;
end;
$block$;
