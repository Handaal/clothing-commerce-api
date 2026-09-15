-- Phase 2J catalog management + Storefront publication acceptance (real database).
-- Runs the full manager flow through the sanctioned write functions and the public read boundary,
-- switching PostgreSQL roles to prove authorization/isolation. Any failed assertion aborts psql via
-- ON_ERROR_STOP; success emits ALL_CATALOG_ACCEPTANCE_ASSERTIONS_PASSED.
\set ON_ERROR_STOP on
do $$
declare
  v_tenant uuid; v_brand uuid; v_other_tenant uuid; v_other_brand uuid;
  v_product uuid; v_replay uuid; v_variant uuid; v_price uuid;
  v_status text; v_sf text; v_pub_at timestamptz;
  v_doc jsonb; v_cnt int;
  v_other_product uuid; v_other_variant uuid;
begin
  insert into public.tenants (slug, display_name, default_currency) values ('acme','Acme','USD') returning id into v_tenant;
  insert into public.brands (tenant_id, code, display_name) values (v_tenant,'MB','Main Brand') returning id into v_brand;
  insert into public.tenants (slug, display_name, default_currency) values ('other','Other','USD') returning id into v_other_tenant;
  insert into public.brands (tenant_id, code, display_name) values (v_other_tenant,'OB','Other Brand') returning id into v_other_brand;

  set role service_role;

  -- 1. create product (draft/unpublished)
  select product_id, status, storefront_status into v_product, v_status, v_sf
    from catalog_private.create_product(v_tenant, v_brand, 'Classic Tee','classic-tee','ST-1','A tee', null, 'k-create-1');
  assert v_status = 'draft', 'new product must be draft';
  assert v_sf = 'unpublished', 'new product must be unpublished';

  -- 2. idempotent replay
  select product_id into v_replay
    from catalog_private.create_product(v_tenant, v_brand, 'Classic Tee','classic-tee','ST-1','A tee', null, 'k-create-1');
  assert v_replay = v_product, 'idempotent replay must return same product id';

  -- 3. idempotency conflict (same key, different payload -> ID409)
  begin
    perform 1 from catalog_private.create_product(v_tenant, v_brand, 'Different','classic-tee','ST-1','x', null, 'k-create-1');
    raise exception 'expected ID409 on payload mismatch';
  exception when sqlstate 'ID409' then null; end;

  -- 4. slug conflict -> CT010
  begin
    perform 1 from catalog_private.create_product(v_tenant, v_brand, 'Dup','classic-tee', null,null, null, 'k-create-2');
    raise exception 'expected CT010 on slug conflict';
  exception when sqlstate 'CT010' then null; end;

  -- 5. variant (active)
  select variant_id into v_variant from catalog_private.create_variant(v_tenant, v_product, 'TEE-BLK-M','Black / M','k-var-1');

  -- 6. SKU conflict -> CT020
  begin
    perform 1 from catalog_private.create_variant(v_tenant, v_product, 'tee-blk-m', null, 'k-var-2');
    raise exception 'expected CT020 on sku conflict';
  exception when sqlstate 'CT020' then null; end;

  -- 7. publish gate: draft product -> CT031
  begin
    perform 1 from catalog_private.publish_product(v_tenant, v_product, 'k-pub-a');
    raise exception 'expected CT031 publishing a draft product';
  exception when sqlstate 'CT031' then null; end;

  -- 8. activate, then publish without price -> CT031
  select status into v_status from catalog_private.set_product_status(v_tenant, v_product,'active', null, 'k-act-1');
  assert v_status = 'active', 'product must be active';
  begin
    perform 1 from catalog_private.publish_product(v_tenant, v_product, 'k-pub-b');
    raise exception 'expected CT031 publishing an unpriced product';
  exception when sqlstate 'CT031' then null; end;

  -- 9. set price, then publish
  select price_id into v_price from catalog_private.set_variant_price(v_tenant, v_variant,'USD',2500,'k-price-1');
  select storefront_status, storefront_published_at into v_sf, v_pub_at
    from catalog_private.publish_product(v_tenant, v_product, 'k-pub-1');
  assert v_sf = 'published', 'product must be published';
  assert v_pub_at is not null, 'published_at must be set';

  -- 10. price replace archives old, keeps exactly one active + retains history
  perform 1 from catalog_private.set_variant_price(v_tenant, v_variant,'USD',3000,'k-price-2');
  select count(*) into v_cnt from public.variant_prices where variant_id = v_variant and status='active';
  assert v_cnt = 1, 'exactly one active price per currency';
  select count(*) into v_cnt from public.variant_prices where variant_id = v_variant;
  assert v_cnt = 2, 'price history retained';

  -- 11. deactivating a published product is rejected -> CT032
  begin
    perform 1 from catalog_private.set_product_status(v_tenant, v_product,'draft', null, 'k-deact-1');
    raise exception 'expected CT032 deactivating a published product';
  exception when sqlstate 'CT032' then null; end;

  -- 12. media add (primary)
  perform 1 from catalog_private.add_product_media(v_tenant, v_product, null,'product-media','acme/tee/front.jpg','Front', 0, true, 'k-media-1');
  select count(*) into v_cnt from public.product_media where product_id = v_product and is_primary and status='active';
  assert v_cnt = 1, 'one active primary media';

  -- 13. anon PUBLIC read
  reset role; set role anon;
  select count(*) into v_cnt from catalog_public.list_published_products(v_tenant, null, 50);
  assert v_cnt = 1, 'anon sees one published product';
  select product into v_doc from catalog_public.get_published_product(v_tenant, 'classic-tee');
  assert v_doc ->> 'slug' = 'classic-tee', 'public doc slug';
  assert v_doc -> 'variants' -> 0 ->> 'sku' = 'TEE-BLK-M', 'public variant sku';
  assert (v_doc -> 'variants' -> 0 -> 'prices' -> 0 ->> 'amountMinor') = '3000', 'public price is current active price';
  assert (v_doc -> 'variants' -> 0 ->> 'availableQuantity') = '0', 'availability derived from inventory truth';
  assert v_doc -> 'media' -> 0 ->> 'path' = 'acme/tee/front.jpg', 'public media reference';
  assert not (v_doc ? 'status'), 'internal status must not leak publicly';

  -- 14. cross-tenant isolation
  select count(*) into v_cnt from catalog_public.list_published_products(v_other_tenant, null, 50);
  assert v_cnt = 0, 'cross-tenant public read is isolated';

  -- 15. anon cannot execute a write function
  begin
    perform 1 from catalog_private.create_product(v_tenant, v_brand,'Hack','hack',null,null,null,'k-x');
    raise exception 'anon must not execute catalog write';
  exception when insufficient_privilege then null; end;
  reset role;

  -- 16. unpublish -> hidden publicly, canonical rows intact
  set role service_role;
  perform 1 from catalog_private.unpublish_product(v_tenant, v_product, 'k-unpub-1');
  reset role; set role anon;
  select count(*) into v_cnt from catalog_public.list_published_products(v_tenant, null, 50);
  assert v_cnt = 0, 'unpublished product is hidden publicly';
  reset role;
  select status, storefront_status into v_status, v_sf from public.products where id = v_product;
  assert v_status = 'active' and v_sf = 'unpublished', 'canonical product state intact after unpublish';
  select count(*) into v_cnt from public.product_variants where id = v_variant and status='active';
  assert v_cnt = 1, 'variant intact after unpublish';

  -- 17. cross-tenant publish isolation
  set role service_role;
  select product_id into v_other_product from catalog_private.create_product(v_other_tenant, v_other_brand,'X','x-slug',null,null,null,'ok-1');
  select variant_id into v_other_variant from catalog_private.create_variant(v_other_tenant, v_other_product,'X-1',null,'ok-2');
  perform 1 from catalog_private.set_variant_price(v_other_tenant, v_other_variant,'USD',500,'ok-3');
  perform 1 from catalog_private.set_product_status(v_other_tenant, v_other_product,'active',null,'ok-4');
  perform 1 from catalog_private.publish_product(v_other_tenant, v_other_product,'ok-5');
  reset role; set role anon;
  select count(*) into v_cnt from catalog_public.list_published_products(v_tenant, null, 50);
  assert v_cnt = 0, 'tenant A sees nothing; no cross-tenant bleed';
  select count(*) into v_cnt from catalog_public.list_published_products(v_other_tenant, null, 50);
  assert v_cnt = 1, 'tenant B sees only its own published product';
  reset role;

  raise notice 'ALL_CATALOG_ACCEPTANCE_ASSERTIONS_PASSED';
end $$;
