-- Collections management + public Storefront read boundary.
--
-- The merchandising tables public.collections and public.product_collections already exist (Phase 2A).
-- This migration adds the sanctioned WRITE functions (catalog_private, service_role only) and the
-- DB-enforced published-only READ functions (catalog_public, callable by the Storefront) so admins can
-- create collections, group products into them, and publish them to the Storefront.
--
-- Collections are tenant-wide (no brand scope), so the application authorizes the existing
-- catalog.author permission tenant-wide. Writes reuse the shared idempotency helpers
-- (catalog_private.claim_write / complete_write). Public visibility is a conservative DB projection:
-- a collection surfaces only when it is 'active' AND owns at least one publicly visible product.

-- ---------------------------------------------------------------------------------------------------
-- Write: create / update / status / membership
-- ---------------------------------------------------------------------------------------------------

create function catalog_private.create_collection(
  p_tenant_id uuid,
  p_name text,
  p_slug text,
  p_description text,
  p_actor_membership_id uuid,
  p_idempotency_key text
)
returns table (collection_id uuid, status text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_collection_id uuid;
  v_constraint text;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'create_collection' || E'\n'
    || btrim(p_name) || E'\n' || lower(btrim(p_slug)) || E'\n'
    || coalesce(btrim(p_description), '')
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'create_collection', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'collection_id')::uuid, v_replay ->> 'status';
    return;
  end if;

  begin
    insert into public.collections (tenant_id, name, slug, description)
    values (
      p_tenant_id, btrim(p_name), lower(btrim(p_slug)),
      case when p_description is null or btrim(p_description) = '' then null else btrim(p_description) end
    )
    returning id into v_collection_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'collections_tenant_slug_unique' then
        raise exception using errcode = 'CT010', message = 'collection slug already exists';
      end if;
      raise exception using errcode = '23505', message = pg_catalog.format('unique conflict on %s', v_constraint);
  end;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('collection_id', v_collection_id, 'status', 'draft')
  );
  return query select v_collection_id, 'draft'::text;
end;
$function$;

create function catalog_private.update_collection(
  p_tenant_id uuid,
  p_collection_id uuid,
  p_name text,
  p_slug text,
  p_description text,
  p_idempotency_key text
)
returns table (collection_id uuid)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_constraint text;
  v_rows integer;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'update_collection' || E'\n' || p_collection_id::text || E'\n'
    || btrim(p_name) || E'\n' || lower(btrim(p_slug)) || E'\n' || coalesce(btrim(p_description), '')
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'update_collection', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'collection_id')::uuid;
    return;
  end if;

  begin
    update public.collections
    set
      name = btrim(p_name),
      slug = lower(btrim(p_slug)),
      description = case when p_description is null or btrim(p_description) = '' then null else btrim(p_description) end,
      updated_at = now()
    where tenant_id = p_tenant_id and id = p_collection_id;
    get diagnostics v_rows = row_count;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'collections_tenant_slug_unique' then
        raise exception using errcode = 'CT010', message = 'collection slug already exists';
      end if;
      raise exception using errcode = '23505', message = pg_catalog.format('unique conflict on %s', v_constraint);
  end;

  if v_rows = 0 then
    raise exception using errcode = 'CT040', message = 'collection not found for tenant';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('collection_id', p_collection_id)
  );
  return query select p_collection_id;
end;
$function$;

create function catalog_private.set_collection_status(
  p_tenant_id uuid,
  p_collection_id uuid,
  p_target_status text,
  p_archive_reason text,
  p_idempotency_key text
)
returns table (collection_id uuid, status text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_rows integer;
begin
  if p_target_status not in ('draft', 'active', 'archived') then
    raise exception using errcode = '22023', message = 'invalid collection status';
  end if;

  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'set_collection_status' || E'\n' || p_collection_id::text || E'\n'
    || p_target_status || E'\n' || coalesce(btrim(p_archive_reason), '')
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'set_collection_status', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'collection_id')::uuid, v_replay ->> 'status';
    return;
  end if;

  update public.collections
  set
    status = p_target_status,
    archived_at = case when p_target_status = 'archived' then now() else null end,
    archive_reason = case when p_target_status = 'archived'
      then case when p_archive_reason is null or btrim(p_archive_reason) = '' then null else btrim(p_archive_reason) end
      else null end,
    updated_at = now()
  where tenant_id = p_tenant_id and id = p_collection_id;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise exception using errcode = 'CT040', message = 'collection not found for tenant';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('collection_id', p_collection_id, 'status', p_target_status)
  );
  return query select p_collection_id, p_target_status;
end;
$function$;

-- Replace the full ordered membership of a collection in one atomic command. The incoming array is the
-- authoritative, position-ordered product list; anything not present is removed. Unknown or cross-tenant
-- products are rejected structurally by the composite FK and surfaced as CT001.
create function catalog_private.set_collection_products(
  p_tenant_id uuid,
  p_collection_id uuid,
  p_product_ids uuid[],
  p_idempotency_key text
)
returns table (collection_id uuid, product_count integer)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_exists boolean;
  v_ids uuid[] := coalesce(p_product_ids, array[]::uuid[]);
  v_count integer;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'set_collection_products' || E'\n' || p_collection_id::text || E'\n'
    || array_to_string(v_ids, ',')
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'set_collection_products', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'collection_id')::uuid, (v_replay ->> 'product_count')::integer;
    return;
  end if;

  select exists (
    select 1 from public.collections
    where tenant_id = p_tenant_id and id = p_collection_id
  ) into v_exists;
  if not v_exists then
    raise exception using errcode = 'CT040', message = 'collection not found for tenant';
  end if;

  delete from public.product_collections
  where tenant_id = p_tenant_id and collection_id = p_collection_id;

  begin
    insert into public.product_collections (tenant_id, product_id, collection_id, position)
    select p_tenant_id, ordered.product_id, p_collection_id, ordered.position
    from (
      select
        distinct_ids.product_id,
        (row_number() over (order by distinct_ids.ordinality)) - 1 as position
      from (
        select id as product_id, min(ordinality) as ordinality
        from unnest(v_ids) with ordinality as t(id, ordinality)
        group by id
      ) as distinct_ids
    ) as ordered;
  exception
    when foreign_key_violation then
      raise exception using errcode = 'CT001', message = 'product not found for tenant';
  end;

  select count(*) into v_count
  from public.product_collections
  where tenant_id = p_tenant_id and collection_id = p_collection_id;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('collection_id', p_collection_id, 'product_count', v_count)
  );
  return query select p_collection_id, v_count;
end;
$function$;

revoke all on function catalog_private.create_collection(uuid, text, text, text, uuid, text) from public;
revoke all on function catalog_private.update_collection(uuid, uuid, text, text, text, text) from public;
revoke all on function catalog_private.set_collection_status(uuid, uuid, text, text, text) from public;
revoke all on function catalog_private.set_collection_products(uuid, uuid, uuid[], text) from public;

-- ---------------------------------------------------------------------------------------------------
-- Public read boundary (published-only)
-- ---------------------------------------------------------------------------------------------------

-- A collection is publicly visible when it is active and owns at least one publicly visible product.
create function catalog_public.is_collection_publicly_visible(p_collection public.collections)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_collection.status = 'active'
    and exists (
      select 1
      from public.product_collections as membership
      join public.products as product
        on product.tenant_id = membership.tenant_id and product.id = membership.product_id
      where membership.tenant_id = p_collection.tenant_id
        and membership.collection_id = p_collection.id
        and catalog_public.is_publicly_visible(product)
    );
$function$;

-- The ordered, publicly visible products of a collection as an array of the public product projection.
create function catalog_public.collection_products(p_collection public.collections)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_agg(
      catalog_public.build_published_product(product)
      order by membership.position, product.storefront_published_at desc nulls last, product.id
    ),
    '[]'::jsonb
  )
  from public.product_collections as membership
  join public.products as product
    on product.tenant_id = membership.tenant_id and product.id = membership.product_id
  where membership.tenant_id = p_collection.tenant_id
    and membership.collection_id = p_collection.id
    and catalog_public.is_publicly_visible(product);
$function$;

-- Summary projection (list view): identity + description + product count + a cover drawn from the first
-- publicly visible product's primary active media. Never includes draft/archived collections.
create function catalog_public.build_collection_summary(p_collection public.collections)
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
    'cover', (
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
  );
$function$;

-- Detail projection (collection page): summary identity plus the full ordered product array.
create function catalog_public.build_published_collection(p_collection public.collections)
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
    'products', catalog_public.collection_products(p_collection)
  );
$function$;

create function catalog_public.list_published_collections(
  p_tenant_id uuid,
  p_limit integer default 50
)
returns table (collection jsonb)
language sql
stable
security definer
set search_path = ''
as $function$
  select catalog_public.build_collection_summary(collection_row)
  from public.collections as collection_row
  where collection_row.tenant_id = p_tenant_id
    and catalog_public.is_collection_publicly_visible(collection_row)
  order by collection_row.updated_at desc, collection_row.id
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$function$;

create function catalog_public.get_published_collection(
  p_tenant_id uuid,
  p_slug text
)
returns table (collection jsonb)
language sql
stable
security definer
set search_path = ''
as $function$
  select catalog_public.build_published_collection(collection_row)
  from public.collections as collection_row
  where collection_row.tenant_id = p_tenant_id
    and collection_row.normalized_slug = lower(btrim(p_slug))
    and catalog_public.is_collection_publicly_visible(collection_row)
  limit 1;
$function$;

-- Grants mirror the product read boundary: service_role for the server repositories; anon/authenticated
-- may execute only the two published-only read functions directly.
do $block$
begin
  execute 'revoke all on all functions in schema catalog_private from public';
  execute 'revoke all on all functions in schema catalog_public from public';

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function catalog_private.create_collection(uuid, text, text, text, uuid, text) to service_role';
    execute 'grant execute on function catalog_private.update_collection(uuid, uuid, text, text, text, text) to service_role';
    execute 'grant execute on function catalog_private.set_collection_status(uuid, uuid, text, text, text) to service_role';
    execute 'grant execute on function catalog_private.set_collection_products(uuid, uuid, uuid[], text) to service_role';
    execute 'grant execute on function catalog_public.list_published_collections(uuid, integer) to service_role';
    execute 'grant execute on function catalog_public.get_published_collection(uuid, text) to service_role';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'grant execute on function catalog_public.list_published_collections(uuid, integer) to anon';
    execute 'grant execute on function catalog_public.get_published_collection(uuid, text) to anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function catalog_public.list_published_collections(uuid, integer) to authenticated';
    execute 'grant execute on function catalog_public.get_published_collection(uuid, text) to authenticated';
  end if;
end;
$block$;
