-- DEV-ONLY: give the rich catalog fixture (seed-rich-catalog.sql) colours with swatches and an audience
-- category tree (Men / Women / Accessories), through the sanctioned Phase 1A write functions. Idempotent:
-- every write uses a deterministic idempotency key, so re-running replays instead of duplicating.
-- Not part of the product; production starts with an empty catalogue.
--
--   docker exec -i supabase_db_clothing-commerce-api psql -U postgres < supabase/dev/seed-rich-options-categories.sql
\set ON_ERROR_STOP on

do $seed$
declare
  t constant uuid := 'ff472a4c-72c5-4e1d-b3e0-8e62f2779234';
  colours constant jsonb := '{
    "performance-joggers": ["Mint", "#a8e6d9"],
    "canvas-weekender": ["Sand", "#c8a165"],
    "quilted-liner-jacket": ["Chocolate", "#5a3a28"],
    "cable-knit-cardigan": ["Heather Grey", "#9a9a96"],
    "oxford-button-down": ["Sky Blue", "#a9c7e8"],
    "slim-stretch-jeans": ["Light Wash", "#8fb3d9"],
    "pima-vneck-tee": ["White", "#f5f5f0"],
    "raw-selvedge-jeans": ["Indigo", "#2b3a67"],
    "ribbed-beanie": ["Charcoal", "#3a3a3a"],
    "denim-trucker-jacket": ["Mid Wash", "#4a6fa5"],
    "training-tech-tee": ["Black", "#1a1a1a"],
    "relaxed-tapered-jeans": ["Light Wash", "#8fb3d9"],
    "merino-crew-sweater": ["Navy", "#1f2a44"],
    "tiered-linen-dress": ["Natural", "#e8dcc8"],
    "leather-card-holder": ["Tan", "#a0632f"],
    "everyday-crew-tee": ["White", "#f5f5f0"],
    "wrap-midi-dress": ["Floral Cream", "#efe6d2"],
    "linen-camp-shirt": ["Stone", "#c9c2b3"],
    "seamless-leggings": ["Black", "#1a1a1a"],
    "heavyweight-boxy-tee": ["White", "#f5f5f0"],
    "flannel-overshirt": ["Grey Plaid", "#8a8a8a"],
    "wool-topcoat": ["Camel", "#b58a5a"]
  }';
  product record;
  variant record;
  selection jsonb;
  colour_value uuid;
  men uuid;
  women uuid;
  child record;
begin
  -- Colours: keep each variant's existing Size and add Colour (Size first, Colour second).
  for product in
    select p.id, p.slug from public.products p where p.tenant_id = t and colours ? p.slug
  loop
    for variant in
      select v.id from public.product_variants v
      where v.tenant_id = t and v.product_id = product.id and v.status = 'active'
    loop
      select coalesce(jsonb_agg(jsonb_build_object('name', o.name, 'value', val.display_value) order by o.position), '[]')
        into selection
        from public.variant_option_values s
        join public.product_options o on o.id = s.option_id
        join public.product_option_values val on val.id = s.option_value_id
       where s.tenant_id = t and s.variant_id = variant.id and o.normalized_name <> 'colour';
      selection := selection || jsonb_build_array(jsonb_build_object('name', 'Colour', 'value', colours -> product.slug ->> 0));
      perform catalog_private.set_variant_options(t, product.id, variant.id, selection, 'dev-seed-colour:' || variant.id);
    end loop;

    select val.id into colour_value
      from public.product_option_values val
      join public.product_options o on o.id = val.option_id
     where o.tenant_id = t and o.product_id = product.id and o.normalized_name = 'colour'
       and val.normalized_value = lower(colours -> product.slug ->> 0);
    perform catalog_private.update_option_values(t, product.id,
      jsonb_build_array(jsonb_build_object('valueId', colour_value, 'swatchHex', colours -> product.slug ->> 1)),
      'dev-seed-swatch:' || product.id);
  end loop;

  -- Audience tree: Men / Women at the top, the existing type categories underneath; Accessories stays top-level.
  perform catalog_private.create_category(t, null, 'Men', 'men', null, 0, 'dev-seed-cat:men');
  perform catalog_private.create_category(t, null, 'Women', 'women', null, 1, 'dev-seed-cat:women');
  select id into men from public.categories where tenant_id = t and slug = 'men';
  select id into women from public.categories where tenant_id = t and slug = 'women';

  for child in
    select c.id, c.name, c.slug, c.description,
      case when c.slug in ('dresses', 'activewear') then women
           when c.slug = 'accessories' then null
           else men end as parent,
      case c.slug when 't-shirts' then 0 when 'shirts' then 1 when 'denim' then 2 when 'knitwear' then 3
                  when 'outerwear' then 4 when 'dresses' then 0 when 'activewear' then 1 else 2 end as pos
      from public.categories c
     where c.tenant_id = t and c.slug in ('t-shirts','shirts','denim','knitwear','outerwear','dresses','activewear','accessories')
  loop
    perform catalog_private.update_category(t, child.id, child.parent, child.name, child.slug, child.description,
      child.pos, 'dev-seed-cat-parent:' || child.id);
  end loop;
end
$seed$;

select 'DEV_OPTIONS_CATEGORIES_SEEDED' as result;
