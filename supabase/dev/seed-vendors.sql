-- DEV-ONLY: give the rich catalog fixture brands to shop by (SDK 0.50 vendors). Zee Store is a retailer
-- selling other labels, so each test piece gets a maker: international labels (Zara, Polo Ralph Lauren,
-- H&M, Armani Exchange) and two made-up local labels. Pairings are test data only; production starts
-- empty and Zee admins assign real brands. Idempotent: deterministic idempotency keys replay on re-run.
--
--   docker exec -i supabase_db_clothing-commerce-api psql -U postgres < supabase/dev/seed-vendors.sql
\set ON_ERROR_STOP on

do $seed$
declare
  t constant uuid := 'ff472a4c-72c5-4e1d-b3e0-8e62f2779234';
  vendors constant jsonb := '[
    ["zara", "Zara"],
    ["polo-ralph-lauren", "Polo Ralph Lauren"],
    ["h-and-m", "H&M"],
    ["armani-exchange", "Armani Exchange"],
    ["nile-thread", "Nile Thread"],
    ["cairo-denim-co", "Cairo Denim Co."]
  ]';
  assignments constant jsonb := '{
    "everyday-crew-tee": "h-and-m",
    "heavyweight-boxy-tee": "zara",
    "pima-vneck-tee": "h-and-m",
    "training-tech-tee": "h-and-m",
    "sample-capsule-hoodie": "zara",
    "oxford-button-down": "polo-ralph-lauren",
    "linen-camp-shirt": "zara",
    "dev-linen-shirt": "nile-thread",
    "white-shirt-5c8w": "armani-exchange",
    "flannel-overshirt": "nile-thread",
    "cable-knit-cardigan": "polo-ralph-lauren",
    "merino-crew-sweater": "polo-ralph-lauren",
    "raw-selvedge-jeans": "cairo-denim-co",
    "slim-stretch-jeans": "armani-exchange",
    "relaxed-tapered-jeans": "cairo-denim-co",
    "denim-trucker-jacket": "cairo-denim-co",
    "quilted-liner-jacket": "zara",
    "wool-topcoat": "armani-exchange",
    "black-leather-jacket-dh6d": "armani-exchange",
    "performance-joggers": "h-and-m",
    "ribbed-beanie": "nile-thread",
    "leather-card-holder": "polo-ralph-lauren",
    "canvas-weekender": "zara"
  }';
  entry jsonb;
  idx integer := 0;
  product record;
  v_id uuid;
begin
  for entry in select * from jsonb_array_elements(vendors) loop
    perform catalog_private.create_vendor(
      t, entry ->> 1, entry ->> 0, idx, 'dev-seed-vendor:' || (entry ->> 0)
    );
    idx := idx + 1;
  end loop;

  for product in
    select p.id, p.slug from public.products p
    where p.tenant_id = t and assignments ? p.slug
  loop
    select v.id into v_id from public.vendors v
    where v.tenant_id = t and v.normalized_slug = assignments ->> product.slug;
    perform catalog_private.set_product_vendor(
      t, product.id, v_id, 'dev-seed-product-vendor:' || product.id
    );
  end loop;
end;
$seed$;
