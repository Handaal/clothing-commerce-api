-- Storefront site text (SDK 0.52): all website copy outside the catalog and the home hero (promo bar,
-- home section titles, brand note, sign-up box, footer, search-engine title/description, contact details
-- and the FAQ / Terms / Shipping & returns pages), editable from Admin Mobile and the POS Website desk.
--
-- One JSON document per tenant. Its exact shape (known keys, lengths, safe links, email/phone formats) is
-- the API's Zod contract (src/contracts/storefront/site-text.ts), validated on every write; the database
-- keeps the integrity floor: one row per tenant, an object, and a hard size ceiling. Missing keys mean
-- "use the Storefront's built-in text". Deny-by-default: no client role can touch the table; the API
-- reads and writes it only through the security-definer functions below (service_role transport).

create table public.storefront_site_text (
  tenant_id uuid primary key,
  document jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storefront_site_text_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint storefront_site_text_is_object check (jsonb_typeof(document) = 'object'),
  constraint storefront_site_text_size check (octet_length(document::text) <= 131072)
);
alter table public.storefront_site_text enable row level security;
revoke all on public.storefront_site_text from public;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.storefront_site_text from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.storefront_site_text from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.storefront_site_text from service_role;
    grant select on public.storefront_site_text to service_role;
  end if;
end $b$;

-- Management read: the document ('{}' when never saved) and its last save time.
create function catalog_private.storefront_site_text_detail(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'siteText', coalesce(s.document, '{}'::jsonb),
    'updatedAt', case when s.tenant_id is null then null
      else pg_catalog.to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end)
  from (select 1) one
  left join public.storefront_site_text s on s.tenant_id = p_tenant;
$function$;

-- Full replacement of the document (validated by the API contract before it gets here).
create function catalog_private.upsert_storefront_site_text(p_tenant uuid, p_document jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if p_document is null or pg_catalog.jsonb_typeof(p_document) <> 'object' then
    raise exception using errcode = 'SC422', message = 'site text must be an object';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant) then
    raise exception using errcode = 'SC422', message = 'tenant not found';
  end if;
  insert into public.storefront_site_text as st (tenant_id, document)
  values (p_tenant, p_document)
  on conflict (tenant_id) do update set document = excluded.document, updated_at = now();
  return catalog_private.storefront_site_text_detail(p_tenant);
end;
$function$;

-- PUBLIC read for the Storefront: only an active tenant's document; unknown/inactive tenants get '{}'.
create function catalog_private.public_storefront_site_text(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select pg_catalog.jsonb_build_object('siteText', coalesce((
    select s.document
    from public.storefront_site_text s
    join public.tenants t on t.id = s.tenant_id and t.status = 'active'
    where s.tenant_id = p_tenant), '{}'::jsonb));
$function$;

revoke all on function catalog_private.storefront_site_text_detail(uuid) from public;
revoke all on function catalog_private.upsert_storefront_site_text(uuid, jsonb) from public;
revoke all on function catalog_private.public_storefront_site_text(uuid) from public;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function catalog_private.storefront_site_text_detail(uuid) to service_role';
    execute 'grant execute on function catalog_private.upsert_storefront_site_text(uuid, jsonb) to service_role';
    execute 'grant execute on function catalog_private.public_storefront_site_text(uuid) to service_role';
  end if;
end;
$block$;
