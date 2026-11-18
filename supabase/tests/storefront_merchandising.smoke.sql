-- Storefront merchandising smoke test (catalog sales, Buy-X-Get-Y, storefront content).
--
-- Runs against a database that already holds a published, priced product with Storefront checkout
-- settings (the local dev seed). Everything executes inside one transaction that is ROLLED BACK, so it
-- never leaves state behind. Run:
--   docker exec -i supabase_db_clothing-commerce-api psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/storefront_merchandising.smoke.sql
begin;

-- Ensure every brand with a published product has Storefront checkout settings (rolled back below).
insert into public.storefront_checkout_settings (tenant_id, brand_id, inventory_location_id, currency, cod_enabled)
select distinct on (p.tenant_id, p.brand_id) p.tenant_id, p.brand_id, l.id, pr.currency, true
from public.products p
join public.variant_prices pr on pr.tenant_id = p.tenant_id and pr.status = 'active'
join public.product_variants v on v.tenant_id = pr.tenant_id and v.id = pr.variant_id and v.product_id = p.id
join public.inventory_locations l on l.tenant_id = p.tenant_id
where p.storefront_status = 'published'
order by p.tenant_id, p.brand_id, l.id
on conflict do nothing;

create temp table ctx on commit drop as
select p.tenant_id, p.brand_id, p.id as product_id, v.id as variant_id, pr.amount_minor as list_price,
  pr.currency
from public.products p
join public.product_variants v on v.tenant_id = p.tenant_id and v.product_id = p.id and v.status = 'active'
join public.variant_prices pr on pr.tenant_id = v.tenant_id and pr.variant_id = v.id and pr.status = 'active'
join public.storefront_checkout_settings s on s.tenant_id = p.tenant_id and s.brand_id = p.brand_id
  and s.currency = pr.currency
where p.storefront_status = 'published' and p.status = 'active' and pr.amount_minor >= 1000
order by p.id, v.id
limit 1;

do $t$
declare
  c record;
  v_sale jsonb;
  v_sale2 jsonb;
  v_price bigint;
  v_product jsonb;
  v_quote jsonb;
  v_promo jsonb;
  v_content jsonb;
begin
  select * into c from ctx;
  if c is null then raise exception 'smoke precondition: no published priced product with storefront settings'; end if;

  -- 1. No sale: effective price = list price, compareAt null.
  assert catalog_private.effective_unit_price(c.tenant_id, c.product_id, c.currency, c.list_price) = c.list_price,
    'no sale must keep the list price';

  -- 2. 34% sale on everything.
  v_sale := catalog_private.create_sale(c.tenant_id, 'smoke-sale-1', jsonb_build_object(
    'name', 'Smoke 34', 'benefitType', 'percentage', 'benefitPercentBp', 3400, 'scope', 'all'));
  v_price := catalog_private.effective_unit_price(c.tenant_id, c.product_id, c.currency, c.list_price);
  assert v_price = c.list_price - floor(c.list_price * 3400 / 10000.0)::bigint, 'percentage sale price';

  -- idempotent create replays the same sale
  assert (catalog_private.create_sale(c.tenant_id, 'smoke-sale-1', jsonb_build_object(
    'name', 'Other', 'benefitType', 'percentage', 'benefitPercentBp', 100, 'scope', 'all'))->>'id') = v_sale->>'id',
    'create_sale must be idempotent on the creation key';

  -- public projection exposes sale + compare-at
  v_product := catalog_public.build_published_product((select p from public.products p where p.id = c.product_id));
  assert exists (select 1 from jsonb_array_elements(v_product->'variants') v, jsonb_array_elements(v->'prices') pr
    where (pr->>'compareAtAmountMinor')::bigint > (pr->>'amountMinor')::bigint), 'compareAt must be exposed on sale';

  -- 3. A better fixed sale scoped to the product wins (lowest price), never stacked.
  v_sale2 := catalog_private.create_sale(c.tenant_id, 'smoke-sale-2', jsonb_build_object(
    'name', 'Smoke fixed', 'benefitType', 'fixed_amount', 'benefitAmountMinor', c.list_price - 1,
    'benefitCurrency', c.currency, 'scope', 'products', 'productIds', jsonb_build_array(c.product_id)));
  assert catalog_private.effective_unit_price(c.tenant_id, c.product_id, c.currency, c.list_price) = 1,
    'lowest sale price wins';
  perform catalog_private.set_sale_status(c.tenant_id, (v_sale2->>'id')::uuid, 'inactive');
  assert catalog_private.effective_unit_price(c.tenant_id, c.product_id, c.currency, c.list_price) = v_price,
    'inactive sale must not apply';

  -- products-scoped sale without products is rejected
  begin
    perform catalog_private.create_sale(c.tenant_id, 'smoke-sale-3', jsonb_build_object(
      'name', 'Empty', 'benefitType', 'percentage', 'benefitPercentBp', 1000, 'scope', 'products', 'productIds', '[]'::jsonb));
    raise exception 'empty products scope must fail';
  exception when sqlstate 'SL422' then null;
  end;

  -- 4. Quote charges the sale price (same resolve_line as checkout).
  v_quote := online_private.quote_checkout(jsonb_build_object('tenantId', c.tenant_id, 'brandId', c.brand_id,
    'lines', jsonb_build_array(jsonb_build_object('variantId', c.variant_id, 'quantity', 3))));
  assert (v_quote->>'grossSubtotalMinor')::bigint = v_price * 3, 'quote gross must use the sale price';

  -- 5. Buy 2 get 1 free (automatic, online): 3 identical units -> one unit free.
  v_promo := promotions_private.create_promotion(c.tenant_id, 'smoke-bxgy', jsonb_build_object(
    'name', 'Buy 2 Get 1', 'benefitType', 'buy_x_get_y', 'buyQuantity', 2, 'getQuantity', 1,
    'targetType', 'order', 'activationType', 'automatic', 'channel', 'pos'));
  assert v_promo->>'channel' = 'online', 'offers are forced online';
  assert (v_promo->>'buyQuantity')::int = 2 and (v_promo->>'getQuantity')::int = 1, 'offer detail shape';
  v_quote := online_private.quote_checkout(jsonb_build_object('tenantId', c.tenant_id, 'brandId', c.brand_id,
    'lines', jsonb_build_array(jsonb_build_object('variantId', c.variant_id, 'quantity', 3))));
  assert (v_quote->>'discountTotalMinor')::bigint = v_price, 'bxgy must make one unit free';
  assert v_quote->'promotion'->>'benefitType' = 'buy_x_get_y', 'applied promotion type';
  -- 2 units: no complete group -> no discount
  v_quote := online_private.quote_checkout(jsonb_build_object('tenantId', c.tenant_id, 'brandId', c.brand_id,
    'lines', jsonb_build_array(jsonb_build_object('variantId', c.variant_id, 'quantity', 2))));
  assert (v_quote->>'discountTotalMinor')::bigint = 0, 'bxgy needs a full group';
  -- POS never sees an online-only offer
  assert (promotions_private.evaluate(c.tenant_id, 'pos', c.currency, c.brand_id, null,
    jsonb_build_array(jsonb_build_object('ord', 1, 'variantId', c.variant_id, 'productId', c.product_id,
      'quantity', 3, 'lineTotalMinor', c.list_price * 3)), null)->>'applied')::boolean = false
    or (promotions_private.evaluate(c.tenant_id, 'pos', c.currency, c.brand_id, null,
    jsonb_build_array(jsonb_build_object('ord', 1, 'variantId', c.variant_id, 'productId', c.product_id,
      'quantity', 3, 'lineTotalMinor', c.list_price * 3)), null)->>'benefitType') <> 'buy_x_get_y',
    'pos must not apply online offers';
  -- offer badge on the public projection
  v_product := catalog_public.build_published_product((select p from public.products p where p.id = c.product_id));
  assert jsonb_array_length(v_product->'offers') >= 1, 'offer must surface on the public product';

  -- 6. Storefront content round trip; unknown ids rejected; public projection only shows visible items.
  v_content := catalog_private.upsert_storefront_content(c.tenant_id, jsonb_build_object(
    'hero', jsonb_build_object('title', 'Summer Drop', 'subtitle', 'New season', 'ctaLabel', 'Shop', 'ctaHref', '/catalog',
      'image', jsonb_build_object('bucket', 'product-media', 'path', c.tenant_id::text || '/storefront/hero.png', 'altText', 'Hero')),
    'featuredHeading', 'Picked for you',
    'featuredProductIds', jsonb_build_array(c.product_id), 'featuredCollectionIds', '[]'::jsonb));
  assert v_content->'hero'->>'title' = 'Summer Drop', 'content round trip';
  v_content := catalog_public.get_storefront_content(c.tenant_id, null);
  assert jsonb_array_length(v_content->'featuredProducts') = 1, 'public featured products';
  assert v_content->'hero'->'image'->>'path' like '%/storefront/hero.png', 'public hero image';
  begin
    perform catalog_private.upsert_storefront_content(c.tenant_id, jsonb_build_object(
      'featuredProductIds', jsonb_build_array(gen_random_uuid())));
    raise exception 'unknown product must fail';
  exception when sqlstate 'SC422' then null;
  end;
  begin
    perform catalog_private.upsert_storefront_content(c.tenant_id, jsonb_build_object(
      'hero', jsonb_build_object('image', jsonb_build_object('bucket', 'product-media', 'path', 'other-tenant/x.png'))));
    raise exception 'out-of-scope image path must fail';
  exception when check_violation then null;
  end;
  begin
    perform catalog_private.upsert_storefront_content(c.tenant_id, jsonb_build_object(
      'hero', jsonb_build_object('ctaHref', 'javascript:alert(1)')));
    raise exception 'unsafe href must fail';
  exception when check_violation then null;
  end;

  raise notice 'storefront merchandising smoke: all assertions passed';
end
$t$;

rollback;
