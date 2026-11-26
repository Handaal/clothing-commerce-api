-- Storefront program: shop by brand (SDK 0.50).
--
-- A retailer such as Zee Store sells pieces made by other labels (Zara, Polo, H&M, Armani Exchange,
-- local labels). A **vendor** is that maker. It is deliberately not called "brand" here: `brands` is
-- already the tenant's own selling brand (Zee Store itself). The apps show vendors to people as
-- "Brand".
--
-- Vendors are tenant-wide (like categories and collections). A product has at most one vendor.
-- Lifecycle is active <-> archived; an archived vendor disappears from the Storefront (its products
-- stay listed, just without a vendor). Writes go through sanctioned, idempotent catalog_private
-- functions; the public read adds `vendor` to the published product and lists vendors that have
-- publicly visible products.

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  slug text not null,
  normalized_slug text generated always as (lower(btrim(slug))) stored,
  position integer not null default 0,
  status text not null default 'active',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendors_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint vendors_name_valid check (btrim(name) <> '' and pg_catalog.length(name) <= 120),
  constraint vendors_slug_valid check (normalized_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint vendors_position_nonnegative check (position >= 0),
  constraint vendors_status_valid check (status in ('active', 'archived')),
  constraint vendors_archive_state_consistent check ((status = 'archived') = (archived_at is not null)),
  constraint vendors_updated_after_created check (updated_at >= created_at),
  constraint vendors_tenant_id_unique unique (tenant_id, id),
  constraint vendors_tenant_slug_unique unique (tenant_id, normalized_slug)
);

comment on table public.vendors is
  'Labels a tenant sells (e.g. Zara). Shown as "Brand" in the apps; not the tenant''s own brands.';

create index vendors_tenant_position_idx on public.vendors (tenant_id, position, name);

alter table public.products add column vendor_id uuid;
alter table public.products
  add constraint products_vendor_tenant_fk foreign key (tenant_id, vendor_id)
  references public.vendors (tenant_id, id) on delete restrict;
create index products_vendor_idx on public.products (tenant_id, vendor_id) where vendor_id is not null;

alter table public.vendors enable row level security;
revoke all on table public.vendors from public, anon;

create policy authenticated_tenant_read on public.vendors
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.vendors from authenticated';
    execute 'grant select on table public.vendors to authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    -- Same as the other catalog tables; writes are expected to go through catalog_private.
    execute 'grant select, insert, update, delete on table public.vendors to service_role';
  end if;
end;
$block$;

-- ---------------------------------------------------------------------------------------------------
-- Sanctioned writes (service_role only, idempotent)
-- ---------------------------------------------------------------------------------------------------

create function catalog_private.raise_vendor_write_error(p_constraint text)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_constraint = 'vendors_tenant_slug_unique' then
    raise exception using errcode = 'CT010', message = 'vendor slug already exists';
  elsif p_constraint = 'products_vendor_tenant_fk' then
    raise exception using errcode = 'CT060', message = 'vendor not found for tenant';
  end if;
  raise exception using errcode = '22023', message = pg_catalog.format('invalid vendor (%s)', p_constraint);
end;
$function$;

create function catalog_private.create_vendor(
  p_tenant_id uuid,
  p_name text,
  p_slug text,
  p_position integer,
  p_idempotency_key text
)
returns table (vendor_id uuid, status text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_replay jsonb;
  v_vendor_id uuid;
  v_constraint text;
begin
  v_replay := catalog_private.claim_write(
    p_tenant_id, p_idempotency_key, 'create_vendor',
    pg_catalog.md5(p_tenant_id::text || E'\n' || 'create_vendor' || E'\n' || btrim(p_name) || E'\n'
      || lower(btrim(p_slug)) || E'\n' || coalesce(p_position::text, ''))
  );
  if v_replay is not null then
    return query select (v_replay ->> 'vendor_id')::uuid, v_replay ->> 'status';
    return;
  end if;

  begin
    insert into public.vendors (tenant_id, name, slug, position)
    values (
      p_tenant_id, btrim(p_name), lower(btrim(p_slug)),
      coalesce(p_position, (
        select coalesce(max(position) + 1, 0) from public.vendors where tenant_id = p_tenant_id
      ))
    )
    returning id into v_vendor_id;
  exception
    when unique_violation or foreign_key_violation or check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform catalog_private.raise_vendor_write_error(v_constraint);
  end;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('vendor_id', v_vendor_id, 'status', 'active')
  );
  return query select v_vendor_id, 'active'::text;
end;
$function$;

create function catalog_private.update_vendor(
  p_tenant_id uuid,
  p_vendor_id uuid,
  p_name text,
  p_slug text,
  p_position integer,
  p_idempotency_key text
)
returns table (vendor_id uuid)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_replay jsonb;
  v_constraint text;
  v_rows integer;
begin
  v_replay := catalog_private.claim_write(
    p_tenant_id, p_idempotency_key, 'update_vendor',
    pg_catalog.md5(p_tenant_id::text || E'\n' || 'update_vendor' || E'\n' || p_vendor_id::text || E'\n'
      || btrim(p_name) || E'\n' || lower(btrim(p_slug)) || E'\n' || coalesce(p_position::text, ''))
  );
  if v_replay is not null then
    return query select (v_replay ->> 'vendor_id')::uuid;
    return;
  end if;

  begin
    update public.vendors
    set name = btrim(p_name),
        slug = lower(btrim(p_slug)),
        position = coalesce(p_position, position),
        updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id and id = p_vendor_id;
    get diagnostics v_rows = row_count;
  exception
    when unique_violation or check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform catalog_private.raise_vendor_write_error(v_constraint);
  end;
  if v_rows = 0 then
    raise exception using errcode = 'CT060', message = 'vendor not found for tenant';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key, pg_catalog.jsonb_build_object('vendor_id', p_vendor_id)
  );
  return query select p_vendor_id;
end;
$function$;

create function catalog_private.set_vendor_status(
  p_tenant_id uuid,
  p_vendor_id uuid,
  p_target_status text,
  p_idempotency_key text
)
returns table (vendor_id uuid, status text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_replay jsonb;
  v_rows integer;
begin
  if p_target_status not in ('active', 'archived') then
    raise exception using errcode = '22023', message = 'invalid vendor status';
  end if;
  v_replay := catalog_private.claim_write(
    p_tenant_id, p_idempotency_key, 'set_vendor_status',
    pg_catalog.md5(p_tenant_id::text || E'\n' || 'set_vendor_status' || E'\n' || p_vendor_id::text
      || E'\n' || p_target_status)
  );
  if v_replay is not null then
    return query select (v_replay ->> 'vendor_id')::uuid, v_replay ->> 'status';
    return;
  end if;

  update public.vendors
  set status = p_target_status,
      archived_at = case when p_target_status = 'archived' then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where tenant_id = p_tenant_id and id = p_vendor_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception using errcode = 'CT060', message = 'vendor not found for tenant';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('vendor_id', p_vendor_id, 'status', p_target_status)
  );
  return query select p_vendor_id, p_target_status;
end;
$function$;

-- Set (or clear, with null) the product's vendor. Unknown/cross-tenant vendor ids are rejected by the FK.
create function catalog_private.set_product_vendor(
  p_tenant_id uuid,
  p_product_id uuid,
  p_vendor_id uuid,
  p_idempotency_key text
)
returns table (product_id uuid, vendor_id uuid)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_replay jsonb;
  v_rows integer;
  v_constraint text;
begin
  v_replay := catalog_private.claim_write(
    p_tenant_id, p_idempotency_key, 'set_product_vendor',
    pg_catalog.md5(p_tenant_id::text || E'\n' || 'set_product_vendor' || E'\n' || p_product_id::text
      || E'\n' || coalesce(p_vendor_id::text, ''))
  );
  if v_replay is not null then
    return query select (v_replay ->> 'product_id')::uuid, (v_replay ->> 'vendor_id')::uuid;
    return;
  end if;

  begin
    update public.products
    set vendor_id = p_vendor_id, updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id and id = p_product_id;
    get diagnostics v_rows = row_count;
  exception
    when foreign_key_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform catalog_private.raise_vendor_write_error(v_constraint);
  end;
  if v_rows = 0 then
    raise exception using errcode = 'CT001', message = 'product not found for tenant';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('product_id', p_product_id, 'vendor_id', p_vendor_id)
  );
  return query select p_product_id, p_vendor_id;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Public read boundary
-- ---------------------------------------------------------------------------------------------------

-- The published product keeps its exact previous projection (renamed below) plus `vendor`
-- ({ id, slug, name } of an active vendor, else null). Wrapping instead of copying keeps one
-- definition of the large projection.
alter function catalog_public.build_published_product(public.products)
  rename to build_published_product_base;

create function catalog_public.build_published_product(p_product public.products)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select catalog_public.build_published_product_base(p_product) || pg_catalog.jsonb_build_object(
    'vendor', (
      select pg_catalog.jsonb_build_object('id', vendor.id, 'slug', vendor.slug, 'name', vendor.name)
      from public.vendors as vendor
      where vendor.tenant_id = p_product.tenant_id
        and vendor.id = p_product.vendor_id
        and vendor.status = 'active'
    )
  );
$function$;

-- Active vendors holding at least one publicly visible product, in display order.
create function catalog_public.list_storefront_vendors(p_tenant_id uuid)
returns table (vendor jsonb)
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', vendor.id,
    'slug', vendor.slug,
    'name', vendor.name,
    'position', vendor.position,
    'productCount', counts.product_count
  )
  from public.vendors as vendor
  join (
    select product.vendor_id, pg_catalog.count(*) as product_count
    from public.products as product
    where product.tenant_id = p_tenant_id
      and product.vendor_id is not null
      and catalog_public.is_publicly_visible(product)
    group by product.vendor_id
  ) as counts on counts.vendor_id = vendor.id
  where vendor.tenant_id = p_tenant_id and vendor.status = 'active'
  order by vendor.position, vendor.name;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------
revoke all on function catalog_private.raise_vendor_write_error(text) from public;
revoke all on function catalog_private.create_vendor(uuid, text, text, integer, text) from public;
revoke all on function catalog_private.update_vendor(uuid, uuid, text, text, integer, text) from public;
revoke all on function catalog_private.set_vendor_status(uuid, uuid, text, text) from public;
revoke all on function catalog_private.set_product_vendor(uuid, uuid, uuid, text) from public;
revoke all on function catalog_public.build_published_product(public.products) from public;
revoke all on function catalog_public.build_published_product_base(public.products) from public;
revoke all on function catalog_public.list_storefront_vendors(uuid) from public;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function catalog_private.raise_vendor_write_error(text) to service_role';
    execute 'grant execute on function catalog_private.create_vendor(uuid, text, text, integer, text) to service_role';
    execute 'grant execute on function catalog_private.update_vendor(uuid, uuid, text, text, integer, text) to service_role';
    execute 'grant execute on function catalog_private.set_vendor_status(uuid, uuid, text, text) to service_role';
    execute 'grant execute on function catalog_private.set_product_vendor(uuid, uuid, uuid, text) to service_role';
    execute 'grant execute on function catalog_public.build_published_product(public.products) to service_role';
    execute 'grant execute on function catalog_public.list_storefront_vendors(uuid) to service_role';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'grant execute on function catalog_public.list_storefront_vendors(uuid) to anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function catalog_public.list_storefront_vendors(uuid) to authenticated';
  end if;
end;
$block$;
