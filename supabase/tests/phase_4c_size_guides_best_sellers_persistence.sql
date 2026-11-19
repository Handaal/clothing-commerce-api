-- Phase 2 (Storefront program): category size guides, the public sizeGuide, and best sellers.
-- Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql + phase_2l_online.setup.sql
-- (tenant ...1-...0001, brand ...2-...0001 with COD in USD, published product ...6-...0001 "POS Tee",
-- priced variant ...7-...0001 at 2500, stock 10).
\set ON_ERROR_STOP on
\set t '\'2a000001-0000-4000-8000-000000000001\''
\set p '\'2a000006-0000-4000-8000-000000000001\''

create or replace function pg_temp.guide(p_title text)
returns jsonb language sql as $f$
  select jsonb_build_object('title', p_title, 'unit', 'cm', 'columns', jsonb_build_array('Chest', 'Length'),
    'rows', jsonb_build_array(jsonb_build_object('size', 'M', 'values', jsonb_build_array('104', '72'))),
    'note', null);
$f$;

-- 1. Privileges ----------------------------------------------------------------------------------------
do $b$ begin
  assert has_function_privilege('service_role', 'catalog_private.set_category_size_guide(uuid,uuid,jsonb,text)', 'execute')
     and not has_function_privilege('anon', 'catalog_private.set_category_size_guide(uuid,uuid,jsonb,text)', 'execute')
     and not has_function_privilege('authenticated', 'catalog_private.set_category_size_guide(uuid,uuid,jsonb,text)', 'execute'),
    'P1 only the server can write size guides';
  assert has_function_privilege('anon', 'catalog_public.list_best_selling_products(uuid,uuid,integer,integer)', 'execute'),
    'P2 the storefront can read best sellers';
end $b$;

-- 2. Category tree Men > T-Shirts with the product in T-Shirts -----------------------------------------
set role service_role;
select * from catalog_private.create_category(:t, null, 'Men', 'men', null, 0, 'sg-cat-1');
reset role;
select id as men from public.categories where tenant_id = :t and slug = 'men' \gset
set role service_role;
select * from catalog_private.create_category(:t, :'men', 'T-Shirts', 't-shirts', null, 0, 'sg-cat-2');
reset role;
select id as tees from public.categories where tenant_id = :t and slug = 't-shirts' \gset
set role service_role;
select * from catalog_private.set_product_categories(:t, :p, array[:'tees']::uuid[], 'sg-mem-1');
reset role;

do $b$ begin
  assert (select catalog_public.build_published_product(p) -> 'sizeGuide' = 'null'::jsonb
            from public.products p where p.id = '2a000006-0000-4000-8000-000000000001'),
    'G1 no guide anywhere: sizeGuide is null';
end $b$;

-- 3. A guide on the parent is inherited ---------------------------------------------------------------
set role service_role;
select * from catalog_private.set_category_size_guide(:t, :'men', pg_temp.guide('Men'), 'sg-1');
reset role;
do $b$ begin
  assert (select catalog_public.build_published_product(p) -> 'sizeGuide' ->> 'title' = 'Men'
            from public.products p where p.id = '2a000006-0000-4000-8000-000000000001'),
    'G2 product inherits the parent category guide';
end $b$;

-- 4. The nearer category wins ----------------------------------------------------------------------------
set role service_role;
select * from catalog_private.set_category_size_guide(:t, :'tees', pg_temp.guide('Tees'), 'sg-2');
reset role;
do $b$ begin
  assert (select catalog_public.build_published_product(p) -> 'sizeGuide' ->> 'title' = 'Tees'
            from public.products p where p.id = '2a000006-0000-4000-8000-000000000001'),
    'G3 the nearest category guide wins';
end $b$;

-- 5. Idempotency, shape check and clearing ----------------------------------------------------------------
set role service_role;
select * from catalog_private.set_category_size_guide(:t, :'tees', pg_temp.guide('Tees'), 'sg-2');
reset role;
do $b$ begin
  begin
    perform catalog_private.set_category_size_guide('2a000001-0000-4000-8000-000000000001',
      (select id from public.categories where slug = 't-shirts'), pg_temp.guide('Other'), 'sg-2');
    raise exception 'G4 expected ID409';
  exception when sqlstate 'ID409' then null; end;
  begin
    perform catalog_private.set_category_size_guide('2a000001-0000-4000-8000-000000000001',
      (select id from public.categories where slug = 't-shirts'), '{"unit":"mm","columns":["A"],"rows":[{}]}', 'sg-3');
    raise exception 'G5 expected check violation';
  exception when check_violation then null; end;
  begin
    perform catalog_private.set_category_size_guide('2a000001-0000-4000-8000-000000000001',
      gen_random_uuid(), pg_temp.guide('X'), 'sg-4');
    raise exception 'G6 expected CT050';
  exception when sqlstate 'CT050' then null; end;
end $b$;

set role service_role;
select * from catalog_private.set_category_size_guide(:t, :'tees', null, 'sg-5');
reset role;
do $b$ begin
  assert (select catalog_public.build_published_product(p) -> 'sizeGuide' ->> 'title' = 'Men'
            from public.products p where p.id = '2a000006-0000-4000-8000-000000000001'),
    'G7 clearing the child falls back to the parent guide';
end $b$;

-- Archiving the parent hides its guide along with the branch.
set role service_role;
select * from catalog_private.set_category_status(:t, :'men', 'archived', null, 'sg-arch');
reset role;
do $b$ begin
  assert (select catalog_public.build_published_product(p) -> 'sizeGuide' = 'null'::jsonb
            from public.products p where p.id = '2a000006-0000-4000-8000-000000000001'),
    'G8 archived categories contribute no guide';
end $b$;

-- 6. Best sellers ---------------------------------------------------------------------------------------
do $b$ begin
  assert catalog_public.list_best_selling_products('2a000001-0000-4000-8000-000000000001', null, 90, 10) = '[]'::jsonb,
    'B1 nothing sold yet: empty ranking';
end $b$;

set role service_role;
select online_private.place_checkout('bs-1', jsonb_build_object(
  'tenantId','2a000001-0000-4000-8000-000000000001','brandId','2a000002-0000-4000-8000-000000000001',
  'lines',jsonb_build_array(jsonb_build_object('variantId','2a000007-0000-4000-8000-000000000001','quantity',2)),
  'customer',jsonb_build_object('name','Shopper','email',null,'phone','+201000000000'),
  'delivery',jsonb_build_object('recipientName','Shopper','phone','+201000000000','line1','1 Street','line2',null,
    'city','Nasr City','region',null,'postalCode',null,'countryCode','EG','notes',null),
  'paymentMethod','cash_on_delivery','expectedTotalMinor',5000,'expectedCurrency','USD')) is not null as placed;
reset role;

do $b$
declare ranking jsonb := catalog_public.list_best_selling_products('2a000001-0000-4000-8000-000000000001', null, 90, 10);
begin
  assert ranking = '["2a000006-0000-4000-8000-000000000001"]'::jsonb, 'B2 the sold product is ranked';
  assert catalog_public.list_best_selling_products('2a000001-0000-4000-8000-000000000001',
    gen_random_uuid(), 90, 10) = '[]'::jsonb, 'B3 the brand filter applies';
  assert catalog_public.list_best_selling_products('2a000001-0000-4000-8000-000000000002', null, 90, 10) = '[]'::jsonb,
    'B4 another tenant sees nothing';
end $b$;

-- An unpublished product drops out of the public ranking.
set role service_role;
select * from catalog_private.unpublish_product(:t, :p, 'bs-unpub');
reset role;
do $b$ begin
  assert catalog_public.list_best_selling_products('2a000001-0000-4000-8000-000000000001', null, 90, 10) = '[]'::jsonb,
    'B5 unpublished products are never ranked publicly';
end $b$;

select 'ALL_SIZE_GUIDE_BEST_SELLER_ASSERTIONS_PASSED' as result;
