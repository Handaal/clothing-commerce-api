-- Phase 2 (Storefront program): size guides and best sellers.
--
--   1. categories.size_guide: an optional size chart a brand attaches to a category (e.g. Men → T-Shirts).
--      A product shows the guide of its nearest category that has one (its own categories first, then
--      their ancestors), so one chart covers a whole product type.
--   2. catalog_private.set_category_size_guide: sanctioned, idempotent write (null clears the guide).
--   3. The public product projection gains `sizeGuide`.
--   4. catalog_public.list_best_selling_products: publicly visible products ranked by units sold on
--      placed orders (POS and online) over a recent window. Only the ranking is exposed, never units.
--
-- Shape (validated at the API boundary; the DB enforces the outline):
--   {"title": text|null, "unit": "cm"|"in", "columns": [text, ...],
--    "rows": [{"size": text, "values": [text, ...]}, ...], "note": text|null}

alter table public.categories
  add column size_guide jsonb,
  add constraint categories_size_guide_shape check (
    size_guide is null or (
      pg_catalog.jsonb_typeof(size_guide) = 'object'
      and size_guide ->> 'unit' in ('cm', 'in')
      and pg_catalog.jsonb_typeof(size_guide -> 'columns') = 'array'
      and pg_catalog.jsonb_typeof(size_guide -> 'rows') = 'array'
      and pg_catalog.jsonb_array_length(size_guide -> 'columns') between 1 and 8
      and pg_catalog.jsonb_array_length(size_guide -> 'rows') between 1 and 30
    )
  );

comment on column public.categories.size_guide is
  'Optional size chart shown on the Storefront for products in this category or its descendants.';

create function catalog_private.set_category_size_guide(
  p_tenant_id uuid,
  p_category_id uuid,
  p_size_guide jsonb,
  p_idempotency_key text
)
returns table (category_id uuid, has_size_guide boolean)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_rows integer;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'set_category_size_guide' || E'\n' || p_category_id::text || E'\n'
    || coalesce(p_size_guide::text, 'null')
  );
  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'set_category_size_guide', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'category_id')::uuid, (v_replay ->> 'has_size_guide')::boolean;
    return;
  end if;

  update public.categories
  set size_guide = p_size_guide, updated_at = pg_catalog.now()
  where tenant_id = p_tenant_id and id = p_category_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception using errcode = 'CT050', message = 'category not found for tenant';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('category_id', p_category_id, 'has_size_guide', p_size_guide is not null)
  );
  return query select p_category_id, p_size_guide is not null;
end;
$function$;

-- The size guide of the product's nearest category that has one: its own (publicly active) categories
-- first, then their ancestors; ties go to the lower position, then the name.
create function catalog_public.product_size_guide(p_tenant_id uuid, p_product_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with recursive path as (
    select category.id, category.parent_category_id, category.size_guide, category.position,
      category.name, 0 as depth
    from public.product_categories as membership
    join public.categories as category
      on category.tenant_id = membership.tenant_id and category.id = membership.category_id
    where membership.tenant_id = p_tenant_id
      and membership.product_id = p_product_id
      and catalog_public.is_category_active_path(category.tenant_id, category.id)
    union all
    select parent.id, parent.parent_category_id, parent.size_guide, parent.position, parent.name,
      path.depth + 1
    from path
    join public.categories as parent
      on parent.tenant_id = p_tenant_id and parent.id = path.parent_category_id
    where path.depth < 10
  )
  select path.size_guide
  from path
  where path.size_guide is not null
  order by path.depth, path.position, path.name
  limit 1;
$function$;

-- Publicly visible products ranked by units sold on placed orders in the last p_days days (both
-- channels), optionally for one brand. Returns a JSON array of product ids, best first.
create function catalog_public.list_best_selling_products(
  p_tenant_id uuid,
  p_brand_id uuid,
  p_days integer,
  p_limit integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_agg(ranked.product_id order by ranked.units desc, ranked.last_sold desc, ranked.product_id),
    '[]'::jsonb)
  from (
    select line.product_id, pg_catalog.sum(line.quantity) as units, pg_catalog.max(sale.placed_at) as last_sold
    from public.order_lines as line
    join public.orders as sale on sale.tenant_id = line.tenant_id and sale.id = line.order_id
    join public.products as product on product.tenant_id = line.tenant_id and product.id = line.product_id
    where line.tenant_id = p_tenant_id
      and sale.status = 'placed'
      and sale.placed_at >= pg_catalog.now()
        - pg_catalog.make_interval(days => greatest(1, least(coalesce(p_days, 90), 365)))
      and (p_brand_id is null or product.brand_id = p_brand_id)
      and catalog_public.is_publicly_visible(product)
    group by line.product_id
    having pg_catalog.sum(line.quantity) > 0
    order by units desc, last_sold desc, line.product_id
    limit greatest(1, least(coalesce(p_limit, 12), 50))
  ) as ranked;
$function$;

-- Same projection as 20261119120000 plus `sizeGuide`.
create or replace function catalog_public.build_published_product(p_product public.products)
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
          'optionValues', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object('name', opt.name, 'value', val.display_value)
              order by opt.position, opt.id
            )
            from public.variant_option_values as selection
            join public.product_options as opt
              on opt.tenant_id = selection.tenant_id and opt.id = selection.option_id
            join public.product_option_values as val
              on val.tenant_id = selection.tenant_id and val.id = selection.option_value_id
            where selection.tenant_id = variant.tenant_id and selection.variant_id = variant.id
          ), '[]'::jsonb),
          'prices', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'currency', priced.currency,
                'amountMinor', priced.effective,
                'compareAtAmountMinor', case when priced.effective < priced.amount_minor then priced.amount_minor else null end
              )
              order by priced.currency
            )
            from (
              select price.currency, price.amount_minor,
                catalog_private.effective_unit_price(p_product.tenant_id, p_product.id, price.currency, price.amount_minor) as effective
              from public.variant_prices as price
              where price.tenant_id = variant.tenant_id
                and price.variant_id = variant.id
                and price.status = 'active'
            ) as priced
          ), '[]'::jsonb),
          'availableQuantity', coalesce((
            select pg_catalog.sum(inventory_private.channel_online_sellable(
              balance.tenant_id, balance.inventory_location_id, balance.variant_id, balance.on_hand_quantity))
            from public.inventory_balances as balance
            where balance.tenant_id = variant.tenant_id
              and balance.variant_id = variant.id
              and (not exists(select 1 from public.storefront_checkout_settings s where s.tenant_id=p_product.tenant_id and s.brand_id=p_product.brand_id)
                or balance.inventory_location_id=(select s.inventory_location_id from public.storefront_checkout_settings s where s.tenant_id=p_product.tenant_id and s.brand_id=p_product.brand_id))
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
    ), '[]'::jsonb),
    -- Option dimensions in display order, with only the values a publicly listed variant uses.
    'options', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'name', opt.name,
          'values', (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object('value', val.display_value, 'swatchHex', val.swatch_hex)
              order by val.position, val.display_value
            )
            from public.product_option_values as val
            where val.tenant_id = opt.tenant_id
              and val.option_id = opt.id
              and val.status = 'active'
              and exists (
                select 1
                from public.variant_option_values as selection
                join public.product_variants as variant
                  on variant.tenant_id = selection.tenant_id and variant.id = selection.variant_id
                where selection.tenant_id = val.tenant_id
                  and selection.option_value_id = val.id
                  and variant.status = 'active'
                  and exists (
                    select 1 from public.variant_prices as price
                    where price.tenant_id = variant.tenant_id and price.variant_id = variant.id
                      and price.status = 'active'
                  )
              )
          )
        )
        order by opt.position, opt.id
      )
      from public.product_options as opt
      where opt.tenant_id = p_product.tenant_id
        and opt.product_id = p_product.id
        and opt.status = 'active'
        -- Only dimensions that at least one publicly listed (active, priced) variant uses.
        and exists (
          select 1
          from public.variant_option_values as selection
          join public.product_variants as variant
            on variant.tenant_id = selection.tenant_id and variant.id = selection.variant_id
          where selection.tenant_id = opt.tenant_id
            and selection.option_id = opt.id
            and variant.status = 'active'
            and exists (
              select 1 from public.variant_prices as price
              where price.tenant_id = variant.tenant_id and price.variant_id = variant.id
                and price.status = 'active'
            )
        )
    ), '[]'::jsonb),
    'categories', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('id', category.id, 'slug', category.slug, 'name', category.name)
        order by category.position, category.name
      )
      from public.product_categories as membership
      join public.categories as category
        on category.tenant_id = membership.tenant_id and category.id = membership.category_id
      where membership.tenant_id = p_product.tenant_id
        and membership.product_id = p_product.id
        and catalog_public.is_category_active_path(category.tenant_id, category.id)
    ), '[]'::jsonb),
    'offers', catalog_private.product_offers(p_product),
    'sizeGuide', catalog_public.product_size_guide(p_product.tenant_id, p_product.id)
  );
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------
revoke all on function catalog_private.set_category_size_guide(uuid, uuid, jsonb, text) from public;
revoke all on function catalog_public.product_size_guide(uuid, uuid) from public;
revoke all on function catalog_public.list_best_selling_products(uuid, uuid, integer, integer) from public;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function catalog_private.set_category_size_guide(uuid, uuid, jsonb, text) to service_role';
    execute 'grant execute on function catalog_public.product_size_guide(uuid, uuid) to service_role';
    execute 'grant execute on function catalog_public.list_best_selling_products(uuid, uuid, integer, integer) to service_role';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'grant execute on function catalog_public.product_size_guide(uuid, uuid) to anon';
    execute 'grant execute on function catalog_public.list_best_selling_products(uuid, uuid, integer, integer) to anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function catalog_public.product_size_guide(uuid, uuid) to authenticated';
    execute 'grant execute on function catalog_public.list_best_selling_products(uuid, uuid, integer, integer) to authenticated';
  end if;
end;
$block$;
