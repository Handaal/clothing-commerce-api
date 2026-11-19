-- DEV-ONLY: test size guides on the rich catalog's menswear categories (Phase 2), through the
-- sanctioned write function. Idempotent (deterministic keys). Measurements are illustrative test data.
--
--   docker exec -i supabase_db_clothing-commerce-api psql -U postgres < supabase/dev/seed-size-guides.sql
\set ON_ERROR_STOP on

do $seed$
declare
  t constant uuid := 'ff472a4c-72c5-4e1d-b3e0-8e62f2779234';
  tops constant jsonb := '{
    "title": "Tops size guide", "unit": "cm", "columns": ["Chest", "Length", "Shoulder"],
    "rows": [
      {"size": "S",  "values": ["96-100",  "70", "44"]},
      {"size": "M",  "values": ["100-104", "72", "46"]},
      {"size": "L",  "values": ["104-110", "74", "48"]},
      {"size": "XL", "values": ["110-116", "76", "50"]}
    ],
    "note": "Measured flat on the garment. Between sizes? Take the larger one for a relaxed fit."
  }';
  denim constant jsonb := '{
    "title": "Denim size guide", "unit": "cm", "columns": ["Waist", "Hip", "Inseam"],
    "rows": [
      {"size": "30", "values": ["76", "96",  "81"]},
      {"size": "32", "values": ["81", "101", "81"]},
      {"size": "34", "values": ["86", "106", "82"]},
      {"size": "36", "values": ["91", "111", "82"]}
    ],
    "note": "Sizes are waist in inches. Raw denim relaxes about one size with wear."
  }';
  category record;
begin
  for category in
    select c.id, c.slug from public.categories c
     where c.tenant_id = t and c.status = 'active' and c.slug in ('men', 'denim')
  loop
    perform catalog_private.set_category_size_guide(t, category.id,
      case when category.slug = 'denim' then denim else tops end,
      'dev-seed-size-guide-v1:' || category.id);
  end loop;
end
$seed$;

select 'DEV_SIZE_GUIDES_SEEDED' as result;
