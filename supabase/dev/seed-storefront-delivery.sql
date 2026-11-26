-- DEV-ONLY: enable COD checkout and Egypt delivery areas for every dev brand that has published products, so
-- the Storefront checkout (which needs STOREFRONT_BRAND_ID) can be exercised locally. Fees are arbitrary test
-- values; real fees are set by the brand's admins. Idempotent (deterministic settings keys).
--
--   docker exec -i supabase_db_clothing-commerce-api psql -U postgres < supabase/dev/seed-storefront-delivery.sql
\set ON_ERROR_STOP on

do $seed$
declare
  t constant uuid := 'ff472a4c-72c5-4e1d-b3e0-8e62f2779234';
  loc constant uuid := '10ca7100-0000-4000-8000-000000000001';
  actor uuid;
  brand record;
  -- ISO 3166-2:EG governorates. Fee in piastres: Greater Cairo 50 EGP, most areas 60, remote areas 85.
  zones constant jsonb := '[
    {"code":"EG-C","name":"Cairo","feeMinor":5000},
    {"code":"EG-GZ","name":"Giza","feeMinor":5000},
    {"code":"EG-ALX","name":"Alexandria","feeMinor":6000},
    {"code":"EG-KB","name":"Qalyubia","feeMinor":6000},
    {"code":"EG-BH","name":"Beheira","feeMinor":6000},
    {"code":"EG-BNS","name":"Beni Suef","feeMinor":6000},
    {"code":"EG-DK","name":"Dakahlia","feeMinor":6000},
    {"code":"EG-DT","name":"Damietta","feeMinor":6000},
    {"code":"EG-FYM","name":"Faiyum","feeMinor":6000},
    {"code":"EG-GH","name":"Gharbia","feeMinor":6000},
    {"code":"EG-IS","name":"Ismailia","feeMinor":6000},
    {"code":"EG-KFS","name":"Kafr El Sheikh","feeMinor":6000},
    {"code":"EG-MNF","name":"Monufia","feeMinor":6000},
    {"code":"EG-MN","name":"Minya","feeMinor":6000},
    {"code":"EG-PTS","name":"Port Said","feeMinor":6000},
    {"code":"EG-SHR","name":"Sharqia","feeMinor":6000},
    {"code":"EG-SUZ","name":"Suez","feeMinor":6000},
    {"code":"EG-AST","name":"Asyut","feeMinor":7000},
    {"code":"EG-SHG","name":"Sohag","feeMinor":7000},
    {"code":"EG-KN","name":"Qena","feeMinor":7000},
    {"code":"EG-LX","name":"Luxor","feeMinor":8500},
    {"code":"EG-ASN","name":"Aswan","feeMinor":8500},
    {"code":"EG-BA","name":"Red Sea","feeMinor":8500},
    {"code":"EG-MT","name":"Matrouh","feeMinor":8500},
    {"code":"EG-WAD","name":"New Valley","feeMinor":8500},
    {"code":"EG-JS","name":"South Sinai","feeMinor":8500},
    {"code":"EG-SIN","name":"North Sinai","feeMinor":8500}
  ]';
begin
  select id into actor from public.memberships where tenant_id = t order by created_at limit 1;

  for brand in
    select distinct p.brand_id as id from public.products p
    where p.tenant_id = t and p.storefront_published_at is not null
  loop
    insert into public.storefront_checkout_settings (tenant_id, brand_id, inventory_location_id, currency, cod_enabled)
    values (t, brand.id, loc, 'EGP', true)
    on conflict (tenant_id, brand_id) do nothing;

    perform settings_private.write_storefront_delivery(t, brand.id, actor, 'dev-seed-delivery:' || brand.id,
      jsonb_build_object('freeDeliveryThresholdMinor', 200000, 'zones', zones));
  end loop;
end
$seed$;

select 'DEV_STOREFRONT_DELIVERY_SEEDED' as result;
