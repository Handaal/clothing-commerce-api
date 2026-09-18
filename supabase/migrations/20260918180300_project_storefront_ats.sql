-- Preserve the published projection, replacing physical availability with uncommitted stock.
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
            select pg_catalog.sum(greatest(0, balance.on_hand_quantity - coalesce((
              select sum(r.quantity-r.consumed_quantity) from public.stock_reservations r
              where r.tenant_id=balance.tenant_id and r.variant_id=balance.variant_id
                and r.inventory_location_id=balance.inventory_location_id and r.status='active'
            ),0)))
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
    ), '[]'::jsonb)
  );
$function$;
