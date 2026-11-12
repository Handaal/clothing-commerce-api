-- DEV-ONLY: a handful of additional ONLINE orders over the rich catalog so Orders read slices look real.
-- Idempotent via stable idempotency keys; orders are written ONLY through orders_private.create_order.
\set ON_ERROR_STOP on
begin;
do $$
declare
  v_tenant_id uuid;
  v_brand_id uuid;
  rec record;
  n int := 0;
  lines jsonb;
begin
  select id into v_tenant_id from public.tenants where normalized_slug = 'dev-local';

  -- Build a few orders, each from 1-2 published variants resolved by SKU.
  for rec in
    select * from (values
      ('dev-rich:order:1', 'RT-CREW-01-M',  2, 'RT-BOXY-02-L',  1),
      ('dev-rich:order:2', 'DN-SLM-01-32',  1, 'DN-RLX-02-34',  1),
      ('dev-rich:order:3', 'AC-JOG-01-M',   1, 'AC-TEE-02-M',   2),
      ('dev-rich:order:4', 'DR-WRP-01-S',   1, 'DR-TIR-02-M',   1),
      ('dev-rich:order:5', 'KN-MER-01-L',   1, 'AX-BNY-03-ONESIZE', 1),
      ('dev-rich:order:6', 'DN-SEL-03-32',  1, 'OW-TRK-01-L',   1)
    ) as t(key, sku1, qty1, sku2, qty2)
  loop
    lines := '[]'::jsonb;

    -- brand for the order comes from line 1's product
    select b.id into v_brand_id
    from public.product_variants v
    join public.products pr on pr.id = v.product_id
    join public.brands b on b.id = pr.brand_id
    where v.tenant_id = v_tenant_id and v.normalized_sku = lower(rec.sku1)
    limit 1;

    select lines || jsonb_build_array(jsonb_build_object(
      'variant_id', v.id, 'product_id', v.product_id, 'quantity', rec.qty1,
      'unit_price_minor', p.amount_minor, 'product_name', pr.name,
      'variant_name', v.display_name, 'sku', v.sku, 'option_summary', 'Size: ' || v.display_name
    ))
    into lines
    from public.product_variants v
    join public.products pr on pr.id = v.product_id
    join public.variant_prices p on p.variant_id = v.id and p.status='active' and p.currency='EGP'
    where v.tenant_id = v_tenant_id and v.normalized_sku = lower(rec.sku1)
    limit 1;

    if rec.sku2 is not null then
      select lines || jsonb_build_array(jsonb_build_object(
        'variant_id', v.id, 'product_id', v.product_id, 'quantity', rec.qty2,
        'unit_price_minor', p.amount_minor, 'product_name', pr.name,
        'variant_name', v.display_name, 'sku', v.sku, 'option_summary', 'Size: ' || v.display_name
      ))
      into lines
      from public.product_variants v
      join public.products pr on pr.id = v.product_id
      join public.variant_prices p on p.variant_id = v.id and p.status='active' and p.currency='EGP'
      where v.tenant_id = v_tenant_id and v.normalized_sku = lower(rec.sku2)
      limit 1;
    end if;

    perform orders_private.create_order(
      v_tenant_id, 'online', 'EGP', v_brand_id, null, null, null,
      rec.key, now() - (n || ' hours')::interval, 'Rich catalog demo order.', lines
    );
    n := n + 1;
  end loop;
end
$$;
commit;
\echo 'Rich orders seeded.'
