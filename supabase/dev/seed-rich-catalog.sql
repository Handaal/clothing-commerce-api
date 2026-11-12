-- DEV-ONLY rich catalog seed. Extends provision-dev-commerce-fixture.sql with a broad, realistic
-- catalog (multiple brands, categories, ~20 published products with Size variants, opening inventory,
-- customers, and several orders) so the Storefront, Admin Mobile, and POS render like a real store.
--
-- Safety mirrors the canonical fixture: targets ONLY the local dev-local tenant, grants nothing, adds
-- no function, writes inventory/orders ONLY through the sanctioned domain functions, and is idempotent
-- (deterministic natural keys + ON CONFLICT DO NOTHING; stable idempotency keys for domain writes).

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_tenant_id uuid;
  v_status text;
  v_branch_id uuid;
  v_brand_id uuid;
  v_category_id uuid;
  v_product_id uuid;
  v_option_id uuid;
  v_value_id uuid;
  v_variant_id uuid;

  -- Catalog definition: one row per product. sizes drives the Size option/variants.
  brands jsonb := jsonb_build_array(
    jsonb_build_object('code','DEV-BRAND','name','Dev Threads'),
    jsonb_build_object('code','NILE-DENIM','name','Nile Denim Co.'),
    jsonb_build_object('code','CAIRO-ACTIVE','name','Cairo Active'),
    jsonb_build_object('code','LUXE-LINEN','name','Luxe Linen'),
    jsonb_build_object('code','SAHARA-KNIT','name','Sahara Knitwear')
  );
  categories jsonb := jsonb_build_array(
    jsonb_build_object('slug','t-shirts','name','T-Shirts'),
    jsonb_build_object('slug','shirts','name','Shirts'),
    jsonb_build_object('slug','denim','name','Denim'),
    jsonb_build_object('slug','dresses','name','Dresses'),
    jsonb_build_object('slug','outerwear','name','Outerwear'),
    jsonb_build_object('slug','knitwear','name','Knitwear'),
    jsonb_build_object('slug','activewear','name','Activewear'),
    jsonb_build_object('slug','accessories','name','Accessories')
  );
  products jsonb := jsonb_build_array(
    jsonb_build_object('slug','everyday-crew-tee','name','Everyday Crew Tee','style','RT-CREW-01','brand','DEV-BRAND','cat','t-shirts','price',34900,'sizes',jsonb_build_array('S','M','L','XL'),'publish',true),
    jsonb_build_object('slug','heavyweight-boxy-tee','name','Heavyweight Boxy Tee','style','RT-BOXY-02','brand','DEV-BRAND','cat','t-shirts','price',44900,'sizes',jsonb_build_array('S','M','L','XL'),'publish',true),
    jsonb_build_object('slug','pima-vneck-tee','name','Pima V-Neck Tee','style','RT-VNK-03','brand','DEV-BRAND','cat','t-shirts','price',39900,'sizes',jsonb_build_array('S','M','L'),'publish',true),
    jsonb_build_object('slug','oxford-button-down','name','Oxford Button-Down Shirt','style','SH-OXF-01','brand','LUXE-LINEN','cat','shirts','price',89900,'sizes',jsonb_build_array('S','M','L','XL'),'publish',true),
    jsonb_build_object('slug','linen-camp-shirt','name','Linen Camp Collar Shirt','style','SH-LIN-02','brand','LUXE-LINEN','cat','shirts','price',99900,'sizes',jsonb_build_array('S','M','L','XL'),'publish',true),
    jsonb_build_object('slug','flannel-overshirt','name','Brushed Flannel Overshirt','style','SH-FLN-03','brand','SAHARA-KNIT','cat','shirts','price',119900,'sizes',jsonb_build_array('M','L','XL'),'publish',true),
    jsonb_build_object('slug','slim-stretch-jeans','name','Slim Stretch Jeans','style','DN-SLM-01','brand','NILE-DENIM','cat','denim','price',129900,'sizes',jsonb_build_array('30','32','34','36'),'publish',true),
    jsonb_build_object('slug','relaxed-tapered-jeans','name','Relaxed Tapered Jeans','style','DN-RLX-02','brand','NILE-DENIM','cat','denim','price',139900,'sizes',jsonb_build_array('30','32','34','36'),'publish',true),
    jsonb_build_object('slug','raw-selvedge-jeans','name','Raw Selvedge Jeans','style','DN-SEL-03','brand','NILE-DENIM','cat','denim','price',219900,'sizes',jsonb_build_array('30','32','34'),'publish',true),
    jsonb_build_object('slug','denim-trucker-jacket','name','Denim Trucker Jacket','style','OW-TRK-01','brand','NILE-DENIM','cat','outerwear','price',189900,'sizes',jsonb_build_array('S','M','L','XL'),'publish',true),
    jsonb_build_object('slug','quilted-liner-jacket','name','Quilted Liner Jacket','style','OW-QLT-02','brand','SAHARA-KNIT','cat','outerwear','price',249900,'sizes',jsonb_build_array('M','L','XL'),'publish',true),
    jsonb_build_object('slug','wool-topcoat','name','Wool Blend Topcoat','style','OW-TOP-03','brand','LUXE-LINEN','cat','outerwear','price',429900,'sizes',jsonb_build_array('S','M','L'),'publish',true),
    jsonb_build_object('slug','merino-crew-sweater','name','Merino Crew Sweater','style','KN-MER-01','brand','SAHARA-KNIT','cat','knitwear','price',159900,'sizes',jsonb_build_array('S','M','L','XL'),'publish',true),
    jsonb_build_object('slug','cable-knit-cardigan','name','Cable Knit Cardigan','style','KN-CBL-02','brand','SAHARA-KNIT','cat','knitwear','price',179900,'sizes',jsonb_build_array('S','M','L'),'publish',true),
    jsonb_build_object('slug','wrap-midi-dress','name','Wrap Midi Dress','style','DR-WRP-01','brand','LUXE-LINEN','cat','dresses','price',149900,'sizes',jsonb_build_array('XS','S','M','L'),'publish',true),
    jsonb_build_object('slug','tiered-linen-dress','name','Tiered Linen Dress','style','DR-TIR-02','brand','LUXE-LINEN','cat','dresses','price',169900,'sizes',jsonb_build_array('XS','S','M','L'),'publish',true),
    jsonb_build_object('slug','performance-joggers','name','Performance Joggers','style','AC-JOG-01','brand','CAIRO-ACTIVE','cat','activewear','price',99900,'sizes',jsonb_build_array('S','M','L','XL'),'publish',true),
    jsonb_build_object('slug','training-tech-tee','name','Training Tech Tee','style','AC-TEE-02','brand','CAIRO-ACTIVE','cat','activewear','price',59900,'sizes',jsonb_build_array('S','M','L','XL'),'publish',true),
    jsonb_build_object('slug','seamless-leggings','name','Seamless Leggings','style','AC-LEG-03','brand','CAIRO-ACTIVE','cat','activewear','price',84900,'sizes',jsonb_build_array('XS','S','M','L'),'publish',true),
    jsonb_build_object('slug','canvas-weekender','name','Canvas Weekender Bag','style','AX-WKN-01','brand','DEV-BRAND','cat','accessories','price',119900,'sizes',jsonb_build_array('One Size'),'publish',true),
    jsonb_build_object('slug','leather-card-holder','name','Leather Card Holder','style','AX-CRD-02','brand','LUXE-LINEN','cat','accessories','price',49900,'sizes',jsonb_build_array('One Size'),'publish',true),
    jsonb_build_object('slug','ribbed-beanie','name','Ribbed Beanie','style','AX-BNY-03','brand','SAHARA-KNIT','cat','accessories','price',39900,'sizes',jsonb_build_array('One Size'),'publish',true),
    -- a couple intentionally left as internal-only (draft / unpublished) for realism
    jsonb_build_object('slug','sample-capsule-hoodie','name','Sample Capsule Hoodie','style','DEV-HOOD-01','brand','DEV-BRAND','cat','knitwear','price',139900,'sizes',jsonb_build_array('M','L'),'publish',false)
  );

  prod jsonb;
  brand_def jsonb;
  cat_def jsonb;
  sz text;
  pos int;
  opening_lines jsonb := '[]'::jsonb;
begin
  -- Require the dev-local tenant (created by identity provisioning + base fixture).
  select id, status into v_tenant_id, v_status from public.tenants where normalized_slug = 'dev-local';
  if not found then
    raise exception 'RICH_SEED: tenant dev-local not found. Run dev:provision-identity + dev:provision-commerce-fixture first.';
  end if;
  if v_status <> 'active' then
    raise exception 'RICH_SEED: tenant dev-local status=% (expected active).', v_status;
  end if;

  select id into v_branch_id from public.branches where tenant_id = v_tenant_id and normalized_code = 'dev-branch';
  if v_branch_id is null then
    raise exception 'RICH_SEED: dev-branch missing. Run dev:provision-commerce-fixture first.';
  end if;

  -- Brands.
  for brand_def in select * from jsonb_array_elements(brands) loop
    insert into public.brands (tenant_id, code, display_name, status)
    values (v_tenant_id, brand_def->>'code', brand_def->>'name', 'active')
    on conflict (tenant_id, normalized_code) do nothing;
    -- every brand must be operable by the fixture branch so POS/online validation passes
    select id into v_brand_id from public.brands
    where tenant_id = v_tenant_id and normalized_code = lower(brand_def->>'code');
    insert into public.branch_brands (tenant_id, branch_id, brand_id)
    values (v_tenant_id, v_branch_id, v_brand_id)
    on conflict (tenant_id, branch_id, brand_id) do nothing;
  end loop;

  -- Categories.
  for cat_def in select * from jsonb_array_elements(categories) loop
    insert into public.categories (tenant_id, name, slug, position, status)
    values (v_tenant_id, cat_def->>'name', cat_def->>'slug', 0, 'active')
    on conflict (tenant_id, normalized_slug) do nothing;
  end loop;

  -- Products + options + variants + prices + category links.
  for prod in select * from jsonb_array_elements(products) loop
    select id into v_brand_id from public.brands
    where tenant_id = v_tenant_id and normalized_code = lower(prod->>'brand');
    select id into v_category_id from public.categories
    where tenant_id = v_tenant_id and normalized_slug = lower(prod->>'cat');

    insert into public.products (tenant_id, brand_id, name, slug, style_code, description, status)
    values (
      v_tenant_id, v_brand_id, prod->>'name', prod->>'slug', prod->>'style',
      prod->>'name' || ' — a dev catalog fixture piece.', 'active'
    )
    on conflict (tenant_id, normalized_slug) do nothing;
    select id into v_product_id from public.products
    where tenant_id = v_tenant_id and normalized_slug = lower(prod->>'slug');

    insert into public.product_categories (tenant_id, product_id, category_id)
    values (v_tenant_id, v_product_id, v_category_id)
    on conflict (tenant_id, product_id, category_id) do nothing;

    insert into public.product_options (tenant_id, product_id, name, position, status)
    values (v_tenant_id, v_product_id, 'Size', 0, 'active')
    on conflict (tenant_id, product_id, normalized_name) do nothing;
    select id into v_option_id from public.product_options
    where tenant_id = v_tenant_id and product_id = v_product_id and normalized_name = 'size';

    pos := 0;
    for sz in select jsonb_array_elements_text(prod->'sizes') loop
      insert into public.product_option_values (tenant_id, product_id, option_id, display_value, position, status)
      values (v_tenant_id, v_product_id, v_option_id, sz, pos, 'active')
      on conflict (tenant_id, option_id, normalized_value) do nothing;
      select id into v_value_id from public.product_option_values
      where tenant_id = v_tenant_id and option_id = v_option_id and normalized_value = lower(sz);

      insert into public.product_variants (tenant_id, product_id, sku, display_name, option_signature, status)
      values (
        v_tenant_id, v_product_id,
        prod->>'style' || '-' || upper(replace(sz, ' ', '')),
        sz, v_value_id::text, 'active'
      )
      on conflict (tenant_id, normalized_sku) do nothing;
      select id into v_variant_id from public.product_variants
      where tenant_id = v_tenant_id
        and normalized_sku = lower(prod->>'style' || '-' || upper(replace(sz, ' ', '')));

      insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
      values (v_tenant_id, v_product_id, v_variant_id, v_option_id, v_value_id)
      on conflict (tenant_id, variant_id, option_id) do nothing;

      insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor, status)
      values (v_tenant_id, v_variant_id, 'EGP', (prod->>'price')::bigint, 'active')
      on conflict (tenant_id, variant_id, currency) where status = 'active' do nothing;

      -- opening stock: a varied-but-deterministic quantity so availability looks real
      opening_lines := opening_lines || jsonb_build_array(jsonb_build_object(
        'variant_id', v_variant_id,
        'inventory_location_id', (select id from public.inventory_locations where tenant_id = v_tenant_id and normalized_code = 'dev-loc-1'),
        'quantity_delta', 18 + (pos * 7) + (length(prod->>'slug') % 11)
      ));
      pos := pos + 1;
    end loop;
  end loop;

  -- Opening inventory for every seeded variant through the sole sanctioned write path.
  perform inventory_private.record_operation(
    v_tenant_id, 'opening', opening_lines, null,
    'dev-rich:inventory-opening:v1', null, 'Rich catalog opening stock.'
  );

  -- Publish the flagged products (set AFTER variants + prices exist to satisfy the published precondition).
  for prod in select * from jsonb_array_elements(products) loop
    if (prod->>'publish')::boolean then
      update public.products
      set storefront_status = 'published',
          storefront_published_at = coalesce(storefront_published_at, now())
      where tenant_id = v_tenant_id and normalized_slug = lower(prod->>'slug');
    end if;
  end loop;

  -- Customers (idempotent: skip phones already present for this tenant).
  insert into public.customers (tenant_id, name, email, phone)
  select v_tenant_id, c.name, c.email, c.phone
  from (values
    ('Mariam Hassan',   'mariam.hassan@example.com',  '+201000000011'),
    ('Omar Khaled',     'omar.khaled@example.com',    '+201000000012'),
    ('Nour El-Sayed',   'nour.elsayed@example.com',   '+201000000013'),
    ('Youssef Adel',    'youssef.adel@example.com',   '+201000000014'),
    ('Salma Ibrahim',   'salma.ibrahim@example.com',  '+201000000015'),
    ('Karim Mostafa',   'karim.mostafa@example.com',  '+201000000016')
  ) as c(name, email, phone)
  where not exists (
    select 1 from public.customers x
    where x.tenant_id = v_tenant_id and x.phone = c.phone
  );
end
$$;

commit;

\echo 'Rich catalog seeded.'
