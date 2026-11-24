-- Website images and photo editing (SDK 0.53).
--
-- 1. Collections get an optional custom COVER image and categories an optional IMAGE, both uploaded by
--    admins to the catalog media bucket under "<tenant>/catalog/". Without one, the website keeps using
--    the first product photo (collections) or a product photo (category tiles), as before.
-- 2. Product photos become editable after upload: description (alt text), the main photo, and order.
--    reorder_product_media also makes the first photo the main one, so "first = main" everywhere.
-- Writes go through security-definer functions called by the API (service_role transport, already
-- authorized by catalog.author); the public projections are replaced in place (same signatures/grants).

-- ---------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------
alter table public.collections
  add column cover_image_bucket text,
  add column cover_image_path text,
  add column cover_image_alt text,
  add constraint collections_cover_image_pair check ((cover_image_bucket is null) = (cover_image_path is null)),
  add constraint collections_cover_image_scoped check (cover_image_path is null
    or (cover_image_path like tenant_id::text || '/catalog/%' and cover_image_path !~ '\.\.'
        and length(cover_image_path) <= 500)),
  add constraint collections_cover_image_alt_len check (cover_image_alt is null
    or (btrim(cover_image_alt) <> '' and length(cover_image_alt) <= 300));

alter table public.categories
  add column image_bucket text,
  add column image_path text,
  add column image_alt text,
  add constraint categories_image_pair check ((image_bucket is null) = (image_path is null)),
  add constraint categories_image_scoped check (image_path is null
    or (image_path like tenant_id::text || '/catalog/%' and image_path !~ '\.\.'
        and length(image_path) <= 500)),
  add constraint categories_image_alt_len check (image_alt is null
    or (btrim(image_alt) <> '' and length(image_alt) <= 300));

-- ---------------------------------------------------------------------------------------------------
-- 2. Image writes
-- ---------------------------------------------------------------------------------------------------
create function catalog_private.set_collection_image(
  p_tenant_id uuid, p_collection_id uuid, p_bucket text, p_path text, p_alt text
)
returns table (collection_id uuid, has_image boolean)
language plpgsql security definer set search_path = '' as $function$
begin
  update public.collections c
  set cover_image_bucket = case when p_path is null then null else btrim(p_bucket) end,
      cover_image_path = case when p_path is null then null else btrim(p_path) end,
      cover_image_alt = case when p_path is null or p_alt is null or btrim(p_alt) = '' then null else btrim(p_alt) end,
      updated_at = pg_catalog.now()
  where c.tenant_id = p_tenant_id and c.id = p_collection_id;
  if not found then
    raise exception using errcode = 'CT040', message = 'collection not found';
  end if;
  return query select p_collection_id, p_path is not null;
end;
$function$;

create function catalog_private.set_category_image(
  p_tenant_id uuid, p_category_id uuid, p_bucket text, p_path text, p_alt text
)
returns table (category_id uuid, has_image boolean)
language plpgsql security definer set search_path = '' as $function$
begin
  update public.categories c
  set image_bucket = case when p_path is null then null else btrim(p_bucket) end,
      image_path = case when p_path is null then null else btrim(p_path) end,
      image_alt = case when p_path is null or p_alt is null or btrim(p_alt) = '' then null else btrim(p_alt) end,
      updated_at = pg_catalog.now()
  where c.tenant_id = p_tenant_id and c.id = p_category_id;
  if not found then
    raise exception using errcode = 'CT050', message = 'category not found';
  end if;
  return query select p_category_id, p_path is not null;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 3. Product photo editing
-- ---------------------------------------------------------------------------------------------------
-- Alt text (p_set_alt = true applies p_alt_text, null/blank clears it) and/or make it the main photo.
create function catalog_private.update_product_media(
  p_tenant_id uuid, p_media_id uuid, p_set_alt boolean, p_alt_text text, p_make_primary boolean
)
returns table (media_id uuid, is_primary boolean, alt_text text)
language plpgsql security definer set search_path = '' as $function$
#variable_conflict use_column
declare
  v_product uuid;
begin
  select m.product_id into v_product
  from public.product_media m
  where m.tenant_id = p_tenant_id and m.id = p_media_id and m.status = 'active';
  if v_product is null then
    raise exception using errcode = 'CT005', message = 'product media not found';
  end if;
  if coalesce(p_set_alt, false) then
    if p_alt_text is not null and length(btrim(p_alt_text)) > 300 then
      raise exception using errcode = '22023', message = 'alt text too long';
    end if;
    update public.product_media m
    set alt_text = case when p_alt_text is null or btrim(p_alt_text) = '' then null else btrim(p_alt_text) end,
        updated_at = pg_catalog.now()
    where m.tenant_id = p_tenant_id and m.id = p_media_id;
  end if;
  if coalesce(p_make_primary, false) then
    update public.product_media m
    set is_primary = false, updated_at = pg_catalog.now()
    where m.tenant_id = p_tenant_id and m.product_id = v_product and m.is_primary and m.status = 'active'
      and m.id <> p_media_id;
    update public.product_media m
    set is_primary = true, updated_at = pg_catalog.now()
    where m.tenant_id = p_tenant_id and m.id = p_media_id;
  end if;
  return query
    select m.id, m.is_primary, m.alt_text from public.product_media m
    where m.tenant_id = p_tenant_id and m.id = p_media_id;
end;
$function$;

-- The complete order of a product's ACTIVE photos; the first becomes the main photo.
create function catalog_private.reorder_product_media(
  p_tenant_id uuid, p_product_id uuid, p_media_ids uuid[]
)
returns table (product_id uuid, media_count integer)
language plpgsql security definer set search_path = '' as $function$
#variable_conflict use_column
declare
  v_active uuid[];
begin
  if not exists (select 1 from public.products p where p.tenant_id = p_tenant_id and p.id = p_product_id) then
    raise exception using errcode = 'CT001', message = 'product not found';
  end if;
  select coalesce(pg_catalog.array_agg(m.id order by m.id), '{}') into v_active
  from public.product_media m
  where m.tenant_id = p_tenant_id and m.product_id = p_product_id and m.status = 'active';
  if p_media_ids is null
    or cardinality(p_media_ids) <> (select count(distinct x) from unnest(p_media_ids) x)
    or (select coalesce(pg_catalog.array_agg(x order by x), '{}') from unnest(p_media_ids) x) <> v_active then
    raise exception using errcode = '22023', message = 'the order must list every active photo exactly once';
  end if;
  update public.product_media m
  set is_primary = false, updated_at = pg_catalog.now()
  where m.tenant_id = p_tenant_id and m.product_id = p_product_id and m.is_primary and m.status = 'active';
  update public.product_media m
  set position = o.ord - 1, is_primary = (o.ord = 1), updated_at = pg_catalog.now()
  from unnest(p_media_ids) with ordinality as o(id, ord)
  where m.tenant_id = p_tenant_id and m.id = o.id;
  return query select p_product_id, cardinality(p_media_ids);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 4. Public projections (replaced in place; signatures and grants unchanged)
-- ---------------------------------------------------------------------------------------------------
create or replace function catalog_public.build_collection_summary(p_collection public.collections)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_collection.id,
    'slug', p_collection.slug,
    'name', p_collection.name,
    'description', p_collection.description,
    'productCount', (
      select pg_catalog.count(*)
      from public.product_collections as membership
      join public.products as product
        on product.tenant_id = membership.tenant_id and product.id = membership.product_id
      where membership.tenant_id = p_collection.tenant_id
        and membership.collection_id = p_collection.id
        and catalog_public.is_publicly_visible(product)
    ),
    'cover', coalesce(
      case when p_collection.cover_image_path is not null then pg_catalog.jsonb_build_object(
        'bucket', p_collection.cover_image_bucket,
        'path', p_collection.cover_image_path,
        'altText', p_collection.cover_image_alt) end,
      (
        select pg_catalog.jsonb_build_object(
          'bucket', media.storage_bucket,
          'path', media.storage_path,
          'altText', media.alt_text
        )
        from public.product_collections as membership
        join public.products as product
          on product.tenant_id = membership.tenant_id and product.id = membership.product_id
        join public.product_media as media
          on media.tenant_id = product.tenant_id and media.product_id = product.id and media.status = 'active'
        where membership.tenant_id = p_collection.tenant_id
          and membership.collection_id = p_collection.id
          and catalog_public.is_publicly_visible(product)
        order by membership.position, media.is_primary desc, media.position, media.id
        limit 1
      )
    )
  );
$function$;

create or replace function catalog_public.build_published_collection(p_collection public.collections)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_collection.id,
    'slug', p_collection.slug,
    'name', p_collection.name,
    'description', p_collection.description,
    'cover', case when p_collection.cover_image_path is not null then pg_catalog.jsonb_build_object(
      'bucket', p_collection.cover_image_bucket,
      'path', p_collection.cover_image_path,
      'altText', p_collection.cover_image_alt) end,
    'products', catalog_public.collection_products(p_collection)
  );
$function$;

create or replace function catalog_public.list_storefront_categories(p_tenant_id uuid)
returns table (category jsonb)
language sql
stable
security definer
set search_path = ''
as $function$
  with recursive tree as (
    select category.id as root_id, category.id as node_id
    from public.categories as category
    where category.tenant_id = p_tenant_id and category.status = 'active'
    union all
    select tree.root_id, child.id
    from tree
    join public.categories as child
      on child.tenant_id = p_tenant_id and child.parent_category_id = tree.node_id and child.status = 'active'
  ),
  counts as (
    select tree.root_id, pg_catalog.count(distinct product.id) as product_count
    from tree
    join public.product_categories as membership
      on membership.tenant_id = p_tenant_id and membership.category_id = tree.node_id
    join public.products as product
      on product.tenant_id = membership.tenant_id and product.id = membership.product_id
    where catalog_public.is_publicly_visible(product)
    group by tree.root_id
  )
  select pg_catalog.jsonb_build_object(
    'id', category.id,
    'parentId', category.parent_category_id,
    'slug', category.slug,
    'name', category.name,
    'description', category.description,
    'position', category.position,
    'productCount', counts.product_count,
    'image', case when category.image_path is not null then pg_catalog.jsonb_build_object(
      'bucket', category.image_bucket, 'path', category.image_path, 'altText', category.image_alt) end
  )
  from public.categories as category
  join counts on counts.root_id = category.id
  where category.tenant_id = p_tenant_id
    and catalog_public.is_category_active_path(p_tenant_id, category.id)
  order by category.parent_category_id nulls first, category.position, category.name;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------
revoke all on function catalog_private.set_collection_image(uuid, uuid, text, text, text) from public;
revoke all on function catalog_private.set_category_image(uuid, uuid, text, text, text) from public;
revoke all on function catalog_private.update_product_media(uuid, uuid, boolean, text, boolean) from public;
revoke all on function catalog_private.reorder_product_media(uuid, uuid, uuid[]) from public;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function catalog_private.set_collection_image(uuid, uuid, text, text, text) to service_role';
    execute 'grant execute on function catalog_private.set_category_image(uuid, uuid, text, text, text) to service_role';
    execute 'grant execute on function catalog_private.update_product_media(uuid, uuid, boolean, text, boolean) to service_role';
    execute 'grant execute on function catalog_private.reorder_product_media(uuid, uuid, uuid[]) to service_role';
  end if;
end;
$block$;
