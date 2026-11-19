-- Phase 3 (Storefront program): drop-alert / newsletter sign-ups from the Storefront.
--
-- A shopper leaves an email on the website; the brand's owners and managers see the list in Admin
-- Mobile. Sign-up is public and unauthenticated, so the write goes through one SECURITY DEFINER
-- function that validates the tenant (and optional brand) and never reveals whether an address was
-- already on the list. Emails are stored once per tenant (case-insensitive). No discount or sending
-- is implied here; exporting/sending is up to the brand.

create table public.storefront_subscribers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  brand_id uuid,
  email text not null,
  normalized_email text generated always as (pg_catalog.lower(pg_catalog.btrim(email))) stored,
  source text not null default 'website',
  created_at timestamptz not null default pg_catalog.now(),
  constraint storefront_subscribers_tenant_fk foreign key (tenant_id)
    references public.tenants (id) on delete cascade,
  constraint storefront_subscribers_brand_fk foreign key (tenant_id, brand_id)
    references public.brands (tenant_id, id) on delete set null (brand_id),
  constraint storefront_subscribers_email_valid check (
    pg_catalog.length(email) between 3 and 254
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint storefront_subscribers_source_valid check (source ~ '^[a-z0-9-]{1,40}$'),
  constraint storefront_subscribers_tenant_email_unique unique (tenant_id, normalized_email)
);

create index storefront_subscribers_tenant_created_idx
  on public.storefront_subscribers (tenant_id, created_at desc, id desc);

alter table public.storefront_subscribers enable row level security;
revoke all on table public.storefront_subscribers from public, anon, authenticated;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    -- Reads only: the sanctioned function below is the only writer.
    execute 'revoke all on table public.storefront_subscribers from service_role';
    execute 'grant select on table public.storefront_subscribers to service_role';
  end if;
end;
$block$;

comment on table public.storefront_subscribers is
  'Email sign-ups from the Storefront (drop alerts). Written only by online_private.subscribe_storefront_email.';

-- Returns true when the address was newly added, false when it was already on the list. The public
-- route ignores the flag so the response never reveals membership.
create function online_private.subscribe_storefront_email(
  p_tenant_id uuid,
  p_brand_id uuid,
  p_email text,
  p_source text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_rows integer;
begin
  if not exists (select 1 from public.tenants where id = p_tenant_id and status = 'active') then
    raise exception using errcode = 'MK001', message = 'storefront not available';
  end if;
  if p_brand_id is not null and not exists (
    select 1 from public.brands where tenant_id = p_tenant_id and id = p_brand_id and status = 'active'
  ) then
    raise exception using errcode = 'MK001', message = 'storefront not available';
  end if;

  insert into public.storefront_subscribers (tenant_id, brand_id, email, source)
  values (p_tenant_id, p_brand_id, pg_catalog.btrim(p_email), coalesce(p_source, 'website'))
  on conflict (tenant_id, normalized_email) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$function$;

revoke all on function online_private.subscribe_storefront_email(uuid, uuid, text, text) from public;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function online_private.subscribe_storefront_email(uuid, uuid, text, text) to service_role';
  end if;
end;
$block$;
