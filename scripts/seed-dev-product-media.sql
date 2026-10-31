with t as (select id as tenant_id from public.tenants where normalized_slug='dev-local')
insert into public.product_media
  (id, tenant_id, product_id, variant_id, storage_bucket, storage_path, alt_text, position, is_primary, status)
values
  (gen_random_uuid(), (select tenant_id from t), '90000000-0000-4000-8000-000000000001', null, 'product-media', 'dev-linen-shirt/01.png', 'Dev Linen Shirt in natural linen, front view', 0, true,  'active'),
  (gen_random_uuid(), (select tenant_id from t), '90000000-0000-4000-8000-000000000001', null, 'product-media', 'dev-linen-shirt/02.png', 'Dev Linen Shirt fabric fold detail', 1, false, 'active'),
  (gen_random_uuid(), (select tenant_id from t), '90000000-0000-4000-8000-000000000001', null, 'product-media', 'dev-linen-shirt/03.png', 'Dev Linen Shirt drape study', 2, false, 'active'),
  (gen_random_uuid(), (select tenant_id from t), '90000000-0000-4000-8000-000000000002', null, 'product-media', 'dev-canvas-tote/01.png', 'Dev Canvas Tote, front view', 0, true,  'active'),
  (gen_random_uuid(), (select tenant_id from t), '90000000-0000-4000-8000-000000000002', null, 'product-media', 'dev-canvas-tote/02.png', 'Dev Canvas Tote detail', 1, false, 'active')
on conflict do nothing;
