-- Storefront program: shop by brand (vendors, SDK 0.50).
-- Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql + phase_2l_online.setup.sql
-- (tenant ...1-...0001, published product ...6-...0001 "POS Tee"; another tenant ...1-...0002).
\set ON_ERROR_STOP on
\set t '\'2a000001-0000-4000-8000-000000000001\''
\set p '\'2a000006-0000-4000-8000-000000000001\''

-- 1. Privileges --------------------------------------------------------------------------------------
do $b$ begin
  assert has_function_privilege('service_role', 'catalog_private.create_vendor(uuid,text,text,integer,text)', 'execute')
     and has_function_privilege('service_role', 'catalog_private.set_product_vendor(uuid,uuid,uuid,text)', 'execute'),
    'P1 server can call the sanctioned vendor writes';
  assert not has_function_privilege('anon', 'catalog_private.create_vendor(uuid,text,text,integer,text)', 'execute')
     and not has_function_privilege('authenticated', 'catalog_private.set_product_vendor(uuid,uuid,uuid,text)', 'execute'),
    'P2 shoppers cannot call vendor writes';
  assert has_function_privilege('anon', 'catalog_public.list_storefront_vendors(uuid)', 'execute'),
    'P3 the public vendor list is callable by the storefront';
  assert not has_table_privilege('anon', 'public.vendors', 'select'),
    'P4 shoppers cannot read the vendors table directly';
end $b$;

-- 2. Create, replay, conflict ---------------------------------------------------------------------------
set role service_role;
select * from catalog_private.create_vendor(:t, 'Zara', 'zara', null, 'ven-1');
select * from catalog_private.create_vendor(:t, 'Zara', 'zara', null, 'ven-1');
select * from catalog_private.create_vendor(:t, 'Polo Ralph Lauren', 'polo', null, 'ven-2');
reset role;
do $b$ begin
  assert (select count(*) = 2 from public.vendors where tenant_id = '2a000001-0000-4000-8000-000000000001'),
    'W1 replay does not duplicate';
  assert (select position = 1 from public.vendors where normalized_slug = 'polo'), 'W2 appended last';
  begin
    perform catalog_private.create_vendor('2a000001-0000-4000-8000-000000000001', 'Zara 2', 'ZARA', null, 'ven-3');
    raise exception 'W3 expected CT010';
  exception when sqlstate 'CT010' then null; end;
  begin
    perform catalog_private.create_vendor('2a000001-0000-4000-8000-000000000001', 'Other', 'other', null, 'ven-1');
    raise exception 'W4 expected ID409';
  exception when sqlstate 'ID409' then null; end;
end $b$;

-- 3. Assign to a product; public projection --------------------------------------------------------------
select id as zara from public.vendors where tenant_id = :t and normalized_slug = 'zara' \gset
set role service_role;
select * from catalog_private.set_product_vendor(:t, :p, :'zara', 'pv-1');
reset role;
do $b$
declare listed jsonb;
begin
  assert (select catalog_public.build_published_product(p)->'vendor'->>'slug' = 'zara'
            from public.products p where p.id = '2a000006-0000-4000-8000-000000000001'),
    'V1 published product carries its vendor';
  select jsonb_agg(vendor) into listed from catalog_public.list_storefront_vendors('2a000001-0000-4000-8000-000000000001');
  assert jsonb_array_length(listed) = 1 and listed->0->>'slug' = 'zara' and (listed->0->>'productCount')::int = 1,
    'V2 only vendors with visible products are listed, with counts';
  assert (select count(*) = 0 from catalog_public.list_storefront_vendors('2a000001-0000-4000-8000-000000000002')),
    'V3 another tenant sees nothing';
  begin
    perform catalog_private.set_product_vendor('2a000001-0000-4000-8000-000000000002',
      '2a000006-0000-4000-8000-000000000001', null, 'pv-x');
    raise exception 'V4 expected CT001';
  exception when sqlstate 'CT001' then null; end;
  begin
    perform catalog_private.set_product_vendor('2a000001-0000-4000-8000-000000000001',
      '2a000006-0000-4000-8000-000000000001', gen_random_uuid(), 'pv-2');
    raise exception 'V5 expected CT060';
  exception when sqlstate 'CT060' then null; end;
end $b$;

-- 4. Archiving hides the vendor publicly but keeps the product listed ------------------------------------
set role service_role;
select * from catalog_private.set_vendor_status(:t, :'zara', 'archived', 'ven-4');
reset role;
do $b$ begin
  assert (select count(*) = 0 from catalog_public.list_storefront_vendors('2a000001-0000-4000-8000-000000000001')),
    'A1 archived vendor is not listed';
  assert (select catalog_public.build_published_product(p)->'vendor' = 'null'::jsonb
            from public.products p where p.id = '2a000006-0000-4000-8000-000000000001'),
    'A2 product shows no vendor while it is archived';
end $b$;

-- 5. Clearing --------------------------------------------------------------------------------------------
set role service_role;
select * from catalog_private.set_product_vendor(:t, :p, null, 'pv-3');
reset role;
do $b$ begin
  assert (select vendor_id is null from public.products where id = '2a000006-0000-4000-8000-000000000001'),
    'C1 vendor cleared';
end $b$;

select 'ALL_CATALOG_VENDORS_ASSERTIONS_PASSED' as result;
