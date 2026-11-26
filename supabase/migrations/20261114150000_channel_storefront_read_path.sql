-- ADR-042 §3 — STOREFRONT READ PATH for Website/POS channel pools (additive; nothing activated).
--
-- At a location whose channel_stock_mode = 'enforced' the website may only see and sell its own bucket:
--   website available = website.on_hand_qty - active website reservations (public.stock_reservations)
-- Legacy and shadow locations keep today's number (canonical on-hand - active reservations), so this
-- migration changes nothing customer-facing until a location is enforced, and enforced stays locked by
-- inventory_private.channel_feature_gate.
--
-- Two read/commit points change:
--   1. catalog_public.build_published_product: availableQuantity uses the website bucket when enforced.
--   2. A BEFORE INSERT trigger on public.stock_reservations refuses a checkout reservation that exceeds
--      the website bucket's free quantity (same SQLSTATE/message as the existing checkout check, so the API
--      maps it to INSUFFICIENT_STOCK unchanged). Lock order stays balance -> location -> channel rows:
--      place_checkout locks the balance first, the trigger then takes the location FOR SHARE and the
--      channel rows FOR UPDATE.

-- Website-sellable quantity for one stock key, given its canonical on-hand.
create function inventory_private.channel_online_sellable(
  p_tenant_id uuid, p_location_id uuid, p_variant_id uuid, p_on_hand bigint
) returns bigint language sql stable security definer set search_path = '' as $function$
  select greatest(0,
    case when (select l.channel_stock_mode from public.inventory_locations l
                where l.tenant_id = p_tenant_id and l.id = p_location_id) = 'enforced'
      then coalesce((select b.on_hand_qty from public.inventory_channel_balances b
                      where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
                        and b.variant_id = p_variant_id and b.channel = 'website'), 0)
      else p_on_hand
    end
    - inventory_private.channel_website_reserved(p_tenant_id, p_location_id, p_variant_id))::bigint;
$function$;

create function inventory_private.channel_guard_website_reservation()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_mode text; v_on_hand bigint; v_reserved bigint;
begin
  if new.status <> 'active' then
    return new;
  end if;
  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = new.tenant_id and l.id = new.inventory_location_id
   for share;
  if v_mode is distinct from 'enforced' then
    return new;
  end if;
  perform inventory_private.channel_lock_key(new.tenant_id, new.inventory_location_id, new.variant_id);
  select b.on_hand_qty into v_on_hand from public.inventory_channel_balances b
   where b.tenant_id = new.tenant_id and b.inventory_location_id = new.inventory_location_id
     and b.variant_id = new.variant_id and b.channel = 'website';
  v_reserved := inventory_private.channel_website_reserved(new.tenant_id, new.inventory_location_id, new.variant_id);
  if coalesce(v_on_hand, 0) - v_reserved < new.quantity - new.consumed_quantity then
    raise exception using errcode = '23514', message = 'insufficient available stock', detail = 'website channel';
  end if;
  return new;
end;
$function$;

create trigger stock_reservations_channel_website_guard
  before insert on public.stock_reservations
  for each row execute function inventory_private.channel_guard_website_reservation();

grant create on schema inventory_private to inventory_writer;
alter function inventory_private.channel_online_sellable(uuid, uuid, uuid, bigint) owner to inventory_writer;
alter function inventory_private.channel_guard_website_reservation() owner to inventory_writer;
revoke create on schema inventory_private from inventory_writer;
revoke all on function inventory_private.channel_online_sellable(uuid, uuid, uuid, bigint) from public;
revoke all on function inventory_private.channel_guard_website_reservation() from public;
-- The public projection below is owned by the migration role and calls the helper.
grant execute on function inventory_private.channel_online_sellable(uuid, uuid, uuid, bigint) to postgres;


-- Public product projection (20261113120000), with availableQuantity read through the channel helper.
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
    'offers', catalog_private.product_offers(p_product)
  );
$function$;
