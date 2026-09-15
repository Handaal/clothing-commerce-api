-- Phase 2J (3/4): DB-enforced public Storefront read boundary, catalog-management permission seeds,
-- and execute grants for the sanctioned write functions.
--
-- The public read is a SECURITY DEFINER boundary (owned by the migration role, which bypasses RLS)
-- rather than an application-layer filter: even a defective caller can only ever obtain the PUBLISHED
-- projection. It returns no internal status, no cost, no actor/idempotency data, and no unpublished
-- row. The Storefront calls it with the anon key; the tenant/brand it serves is an explicit argument.

create schema if not exists catalog_public;
revoke all on schema catalog_public from public;

-- A single published-product projection: product + its publicly visible variants (active + priced),
-- active media references, and availability derived from the ONE inventory truth (no channel stock).
create function catalog_public.build_published_product(p_product public.products)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_product.id,
    'brandId', p_product.brand_id,
    'slug', p_product.slug,
    'name', p_product.name,
    'description', p_product.description,
    'publishedAt', p_product.storefront_published_at,
    'media', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', media.id,
          'variantId', media.variant_id,
          'bucket', media.storage_bucket,
          'path', media.storage_path,
          'altText', media.alt_text,
          'position', media.position,
          'isPrimary', media.is_primary
        )
        order by media.is_primary desc, media.position, media.id
      )
      from public.product_media as media
      where media.tenant_id = p_product.tenant_id
        and media.product_id = p_product.id
        and media.status = 'active'
    ), '[]'::jsonb),
    'variants', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', variant.id,
          'sku', variant.sku,
          'displayName', variant.display_name,
          'optionSignature', variant.option_signature,
          'prices', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object('currency', price.currency, 'amountMinor', price.amount_minor)
              order by price.currency
            )
            from public.variant_prices as price
            where price.tenant_id = variant.tenant_id
              and price.variant_id = variant.id
              and price.status = 'active'
          ), '[]'::jsonb),
          'availableQuantity', coalesce((
            select pg_catalog.sum(balance.on_hand_quantity)
            from public.inventory_balances as balance
            where balance.tenant_id = variant.tenant_id
              and balance.variant_id = variant.id
          ), 0)
        )
        order by variant.created_at, variant.id
      )
      from public.product_variants as variant
      where variant.tenant_id = p_product.tenant_id
        and variant.product_id = p_product.id
        and variant.status = 'active'
        and exists (
          select 1 from public.variant_prices as price
          where price.tenant_id = variant.tenant_id
            and price.variant_id = variant.id
            and price.status = 'active'
        )
    ), '[]'::jsonb)
  );
$function$;

-- A product is publicly listable only if published AND it still owns at least one active, priced
-- variant (so a product whose priced variants were all archived after publication does not surface).
create function catalog_public.is_publicly_visible(p_product public.products)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_product.storefront_status = 'published'
    and exists (
      select 1
      from public.product_variants as variant
      where variant.tenant_id = p_product.tenant_id
        and variant.product_id = p_product.id
        and variant.status = 'active'
        and exists (
          select 1 from public.variant_prices as price
          where price.tenant_id = variant.tenant_id
            and price.variant_id = variant.id
            and price.status = 'active'
        )
    );
$function$;

create function catalog_public.list_published_products(
  p_tenant_id uuid,
  p_brand_id uuid default null,
  p_limit integer default 50
)
returns table (product jsonb)
language sql
stable
security definer
set search_path = ''
as $function$
  select catalog_public.build_published_product(product_row)
  from public.products as product_row
  where product_row.tenant_id = p_tenant_id
    and (p_brand_id is null or product_row.brand_id = p_brand_id)
    and catalog_public.is_publicly_visible(product_row)
  order by product_row.storefront_published_at desc nulls last, product_row.id
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$function$;

create function catalog_public.get_published_product(
  p_tenant_id uuid,
  p_slug text
)
returns table (product jsonb)
language sql
stable
security definer
set search_path = ''
as $function$
  select catalog_public.build_published_product(product_row)
  from public.products as product_row
  where product_row.tenant_id = p_tenant_id
    and product_row.normalized_slug = lower(btrim(p_slug))
    and catalog_public.is_publicly_visible(product_row)
  limit 1;
$function$;

-- Grants: the public read is callable by the Storefront's anon key; the write functions are callable
-- only by service_role. PUBLIC keeps no execute anywhere in either private/public catalog schema.
do $block$
begin
  execute 'revoke all on all functions in schema catalog_private from public';
  execute 'revoke all on all functions in schema catalog_public from public';

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on all functions in schema catalog_private to service_role';
    execute 'grant execute on all functions in schema catalog_public to service_role';
  end if;

  -- The public read boundary is the ONLY catalog surface anon/authenticated may execute directly.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'grant usage on schema catalog_public to anon';
    execute 'grant execute on function catalog_public.list_published_products(uuid, uuid, integer) to anon';
    execute 'grant execute on function catalog_public.get_published_product(uuid, text) to anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'grant usage on schema catalog_public to authenticated';
    execute 'grant execute on function catalog_public.list_published_products(uuid, uuid, integer) to authenticated';
    execute 'grant execute on function catalog_public.get_published_product(uuid, text) to authenticated';
  end if;
end;
$block$;

comment on schema catalog_public is
  'DB-enforced published-only Storefront read boundary. Never exposes unpublished or internal catalog data.';

-- Phase 2J permission seeds. catalog.author covers ordinary catalog editing; catalog.publish is a
-- distinct, more sensitive capability for Storefront publication. Seeding never grants: a tenant must
-- explicitly create, grant, and scope a Role that carries these keys. Idempotent.
insert into public.permissions (key, description)
values
  ('catalog.author', 'Create and edit products, variants, prices, media, and taxonomy in the authorized brand scope.'),
  ('catalog.publish', 'Publish and unpublish products to the Storefront in the authorized brand scope.')
on conflict (key) do nothing;
