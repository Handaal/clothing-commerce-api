-- Phase 1A (Storefront program): product options, swatches, categories and the public projection.
-- Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql + phase_2l_online.setup.sql
-- (tenant ...1-...0001, published product ...6-...0001 "POS Tee", priced variant ...7-...0001).
-- Each write is its own top-level statement so the deferred canonical-signature trigger fires at COMMIT.
\set ON_ERROR_STOP on
\set t '\'2a000001-0000-4000-8000-000000000001\''
\set foreign '\'2a000001-0000-4000-8000-000000000002\''
\set p '\'2a000006-0000-4000-8000-000000000001\''
\set v '\'2a000007-0000-4000-8000-000000000001\''

-- 1. Privileges --------------------------------------------------------------------------------------
do $b$ begin
  assert has_function_privilege('service_role', 'catalog_private.set_variant_options(uuid,uuid,uuid,jsonb,text)', 'execute')
     and has_function_privilege('service_role', 'catalog_private.create_variant_with_options(uuid,uuid,text,text,jsonb,text)', 'execute')
     and has_function_privilege('service_role', 'catalog_private.create_category(uuid,uuid,text,text,text,integer,text)', 'execute'),
    'P1 server can call the sanctioned option/category writes';
  assert not has_function_privilege('anon', 'catalog_private.set_variant_options(uuid,uuid,uuid,jsonb,text)', 'execute')
     and not has_function_privilege('authenticated', 'catalog_private.create_category(uuid,uuid,text,text,text,integer,text)', 'execute')
     and not has_function_privilege('anon', 'catalog_private.apply_variant_options(uuid,uuid,uuid,jsonb)', 'execute'),
    'P2 shoppers cannot call catalog writes or internal helpers';
  assert has_function_privilege('anon', 'catalog_public.list_storefront_categories(uuid)', 'execute'),
    'P3 the public category list is callable by the storefront';
end $b$;

-- 2. Set options on the existing variant ----------------------------------------------------------------
set role service_role;
select * from catalog_private.set_variant_options(:t, :p, :v, '[{"name":"Size","value":"M"},{"name":"Colour","value":"Black"}]', 'opt-1');
reset role;
do $b$ begin
  assert (select count(*) = 2 from public.product_options where product_id = '2a000006-0000-4000-8000-000000000001'),
    'O1 options created on first use';
  assert (select option_signature <> 'default' from public.product_variants where id = '2a000007-0000-4000-8000-000000000001'),
    'O2 variant signature is canonical (not default)';
end $b$;

-- Replay returns the stored result; a different payload under the same key is rejected.
set role service_role;
select * from catalog_private.set_variant_options(:t, :p, :v, '[{"name":"Size","value":"M"},{"name":"Colour","value":"Black"}]', 'opt-1');
reset role;
do $b$ begin
  begin
    perform catalog_private.set_variant_options('2a000001-0000-4000-8000-000000000001','2a000006-0000-4000-8000-000000000001',
      '2a000007-0000-4000-8000-000000000001','[{"name":"Size","value":"L"}]','opt-1');
    raise exception 'O3 expected ID409';
  exception when sqlstate 'ID409' then null; end;
end $b$;

-- 3. Create a variant with options atomically; duplicate combinations are rejected ----------------------
set role service_role;
select * from catalog_private.create_variant_with_options(:t, :p, 'POS-TEE-WHT-M', null,
  '[{"name":"size","value":"m"},{"name":"colour","value":"White"}]', 'opt-2');
reset role;
do $b$ begin
  assert (select count(*) = 2 from public.product_options where product_id = '2a000006-0000-4000-8000-000000000001'),
    'C1 option names match case-insensitively (no duplicate dimensions)';
  assert (select count(*) = 3 from public.product_option_values where product_id = '2a000006-0000-4000-8000-000000000001'),
    'C2 values M, Black, White exist once each';
  begin
    perform catalog_private.create_variant_with_options('2a000001-0000-4000-8000-000000000001','2a000006-0000-4000-8000-000000000001',
      'POS-TEE-DUP', null, '[{"name":"SIZE","value":"M"},{"name":"Colour","value":"black"}]', 'opt-3');
    raise exception 'C3 expected CT021';
  exception when sqlstate 'CT021' then null; end;
  begin
    perform catalog_private.set_variant_options('2a000001-0000-4000-8000-000000000001','2a000006-0000-4000-8000-000000000001',
      '2a000007-0000-4000-8000-000000000001','[{"name":"Size","value":"M"},{"name":"size","value":"L"}]','opt-4');
    raise exception 'C4 expected 22023';
  exception when sqlstate '22023' then null; end;
  begin
    perform catalog_private.set_variant_options('2a000001-0000-4000-8000-000000000001','2a000006-0000-4000-8000-000000000001',
      gen_random_uuid(),'[{"name":"Size","value":"S"}]','opt-5');
    raise exception 'C5 expected CT002';
  exception when sqlstate 'CT002' then null; end;
end $b$;

-- 4. Swatches -----------------------------------------------------------------------------------------
select id as black from public.product_option_values where product_id = :p and normalized_value = 'black' \gset
set role service_role;
select * from catalog_private.update_option_values(:t, :p, jsonb_build_array(jsonb_build_object('valueId', :'black', 'swatchHex', '#1A1A1A')), 'sw-1');
reset role;
do $b$ begin
  assert (select swatch_hex = '#1a1a1a' from public.product_option_values where normalized_value = 'black'),
    'W1 swatch stored lowercase';
  begin
    update public.product_option_values set swatch_hex = 'red' where normalized_value = 'black';
    raise exception 'W2 expected check violation';
  exception when check_violation then null; end;
  begin
    perform catalog_private.update_option_values('2a000001-0000-4000-8000-000000000001','2a000006-0000-4000-8000-000000000001',
      jsonb_build_array(jsonb_build_object('valueId', gen_random_uuid(), 'swatchHex', null)), 'sw-2');
    raise exception 'W3 expected CT022';
  exception when sqlstate 'CT022' then null; end;
end $b$;

-- 5. Categories ---------------------------------------------------------------------------------------
set role service_role;
select * from catalog_private.create_category(:t, null, 'Men', 'Men', null, null, 'cat-1');
reset role;
select id as men from public.categories where tenant_id = :t and slug = 'men' \gset
set role service_role;
select * from catalog_private.create_category(:t, :'men', 'T-Shirts', 'men-t-shirts', null, null, 'cat-2');
reset role;
select id as tees from public.categories where tenant_id = :t and slug = 'men-t-shirts' \gset
set role service_role;
select * from catalog_private.set_product_categories(:t, :p, array[:'tees']::uuid[], 'cat-3');
reset role;
do $b$
declare men uuid; tees uuid;
begin
  select id into men from public.categories where slug = 'men';
  select id into tees from public.categories where slug = 'men-t-shirts';
  assert (select parent_category_id = men from public.categories where id = tees), 'K1 child category under Men';
  begin
    perform catalog_private.update_category('2a000001-0000-4000-8000-000000000001', men, tees, 'Men', 'men', null, null, 'cat-4');
    raise exception 'K2 expected CT051';
  exception when sqlstate 'CT051' then null; end;
  begin
    perform catalog_private.create_category('2a000001-0000-4000-8000-000000000001', null, 'Men again', 'MEN', null, null, 'cat-5');
    raise exception 'K3 expected CT010';
  exception when sqlstate 'CT010' then null; end;
  begin
    -- A foreign tenant's product cannot join this tenant's category (composite FK).
    perform catalog_private.set_product_categories('2a000001-0000-4000-8000-000000000002', '2a000006-0000-4000-8000-000000000001', array[tees], 'cat-6');
    raise exception 'K4 expected CT001';
  exception when sqlstate 'CT001' then null; end;
end $b$;

-- 6. Public projection --------------------------------------------------------------------------------
do $b$
declare product jsonb; categories jsonb;
begin
  select catalog_public.build_published_product(p) into product from public.products p
   where p.id = '2a000006-0000-4000-8000-000000000001';
  assert jsonb_array_length(product->'options') = 2, 'V1 product exposes both option dimensions';
  -- Only the priced variant is public, so only its values (M, Black) appear; White is hidden.
  assert (select count(*) = 2 from jsonb_array_elements(product->'options') o, jsonb_array_elements(o->'values') v),
    'V2 only values used by publicly listed variants are exposed';
  assert product->'options'->1->'values'->0->>'swatchHex' = '#1a1a1a', 'V3 swatch exposed';
  assert product->'variants'->0->'optionValues' = '[{"name":"Size","value":"M"},{"name":"Colour","value":"Black"}]'::jsonb,
    'V4 variant carries its option values in option order';
  assert product->'categories'->0->>'slug' = 'men-t-shirts', 'V5 categories exposed';

  select jsonb_agg(category) into categories from catalog_public.list_storefront_categories('2a000001-0000-4000-8000-000000000001');
  assert jsonb_array_length(categories) = 2, 'V6 both categories listed (each has a visible product)';
  assert (select (c->>'productCount')::int = 1 from jsonb_array_elements(categories) c where c->>'slug' = 'men'),
    'V7 parent count includes descendants';
  assert (select count(*) = 0 from catalog_public.list_storefront_categories('2a000001-0000-4000-8000-000000000002')),
    'V8 another tenant sees nothing';
end $b$;

-- Archiving the parent hides the whole branch publicly.
select id as men from public.categories where tenant_id = :t and slug = 'men' \gset
set role service_role;
select * from catalog_private.set_category_status(:t, :'men', 'archived', 'season over', 'cat-7');
reset role;
do $b$ begin
  assert (select count(*) = 0 from catalog_public.list_storefront_categories('2a000001-0000-4000-8000-000000000001')),
    'V9 archived parent hides its descendants from the storefront';
  assert (select jsonb_array_length(catalog_public.build_published_product(p)->'categories') = 0
            from public.products p where p.id = '2a000006-0000-4000-8000-000000000001'),
    'V10 product no longer lists categories under an archived parent';
end $b$;

-- 7. Clearing options returns the variant to the default signature --------------------------------------
set role service_role;
select * from catalog_private.set_variant_options(:t, :p, :v, '[]', 'opt-6');
reset role;
do $b$ begin
  assert (select option_signature = 'default' from public.product_variants where id = '2a000007-0000-4000-8000-000000000001'),
    'D1 cleared selection returns to default';
end $b$;

select 'ALL_CATALOG_OPTIONS_CATEGORIES_ASSERTIONS_PASSED' as result;
