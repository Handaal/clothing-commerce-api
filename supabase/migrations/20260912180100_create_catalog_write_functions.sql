-- Phase 2J (2/4): sanctioned catalog write functions.
--
-- Unlike the inventory ledger (which revoked service_role DML and forced a dedicated SECURITY DEFINER
-- writer role), Phase 2A deliberately provisioned catalog with service_role holding direct DML on the
-- catalog tables and declared catalog writes "server-side application responsibilities". These functions
-- are therefore SECURITY INVOKER: they run as the calling service_role (BYPASSRLS, holds catalog DML),
-- with an empty search_path and full schema qualification, and are the single sanctioned server write
-- path. They provide the two guarantees the application cannot get over PostgREST — multi-statement
-- atomicity (price archive+insert, publish gate+update) and idempotent retries — inside one transaction.
--
-- Internal-only custom SQLSTATEs mapped to stable CatalogError codes by the repository:
--   CT001 product not found            CT002 variant not found            CT005 media not found
--   CT010 slug conflict                CT011 style-code conflict          CT020 sku conflict
--   CT030 invalid lifecycle transition CT031 product not publishable      CT032 product is published
--   ID409 idempotency key reused with a different payload

-- ---------------------------------------------------------------------------------------------------
-- Idempotency helpers. claim_write returns the stored result envelope on replay (blocking on the unique
-- key means a concurrent first-writer's real result is observed, never the '{}' placeholder), or NULL
-- when the caller has freshly claimed the key and must perform the work then call complete_write.
-- ---------------------------------------------------------------------------------------------------
create function catalog_private.claim_write(
  p_tenant_id uuid,
  p_idempotency_key text,
  p_operation text,
  p_fingerprint text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_norm text := lower(btrim(p_idempotency_key));
  v_existing_fingerprint text;
  v_result jsonb;
begin
  if p_tenant_id is null then
    raise exception using errcode = '22004', message = 'tenant is required';
  end if;
  if v_norm = '' then
    raise exception using errcode = '22023', message = 'idempotency_key must not be blank';
  end if;

  begin
    insert into catalog_private.catalog_write_operations (
      tenant_id, idempotency_key, operation, payload_fingerprint, result
    )
    values (p_tenant_id, p_idempotency_key, p_operation, p_fingerprint, '{}'::jsonb);
    return null; -- freshly claimed; caller performs the work
  exception
    when unique_violation then
      select operation.payload_fingerprint, operation.result
      into v_existing_fingerprint, v_result
      from catalog_private.catalog_write_operations as operation
      where operation.tenant_id = p_tenant_id
        and operation.normalized_idempotency_key = v_norm;
      if v_existing_fingerprint is distinct from p_fingerprint then
        raise exception using
          errcode = 'ID409',
          message = 'idempotency key reused with a different payload';
      end if;
      return v_result;
  end;
end;
$function$;

create function catalog_private.complete_write(
  p_tenant_id uuid,
  p_idempotency_key text,
  p_result jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  update catalog_private.catalog_write_operations
  set result = p_result
  where tenant_id = p_tenant_id
    and normalized_idempotency_key = lower(btrim(p_idempotency_key));
end;
$function$;

-- Re-raise a unique_violation as the specific catalog conflict code by inspecting the constraint.
create function catalog_private.raise_catalog_unique_conflict(p_constraint text)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_constraint = 'products_tenant_slug_unique' then
    raise exception using errcode = 'CT010', message = 'product slug already exists';
  elsif p_constraint = 'products_tenant_style_code_unique_idx' then
    raise exception using errcode = 'CT011', message = 'product style code already exists';
  elsif p_constraint = 'product_variants_tenant_sku_unique' then
    raise exception using errcode = 'CT020', message = 'variant sku already exists';
  else
    raise exception using errcode = '23505', message = pg_catalog.format('unique conflict on %s', p_constraint);
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Product create / update / lifecycle
-- ---------------------------------------------------------------------------------------------------
create function catalog_private.create_product(
  p_tenant_id uuid,
  p_brand_id uuid,
  p_name text,
  p_slug text,
  p_style_code text,
  p_description text,
  p_actor_membership_id uuid,
  p_idempotency_key text
)
returns table (product_id uuid, status text, storefront_status text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_product_id uuid;
  v_constraint text;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'create_product' || E'\n' || p_brand_id::text || E'\n'
    || btrim(p_name) || E'\n' || lower(btrim(p_slug)) || E'\n'
    || coalesce(lower(btrim(p_style_code)), '') || E'\n' || coalesce(btrim(p_description), '')
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'create_product', v_fingerprint);
  if v_replay is not null then
    return query select
      (v_replay ->> 'product_id')::uuid,
      v_replay ->> 'status',
      v_replay ->> 'storefront_status';
    return;
  end if;

  begin
    insert into public.products (tenant_id, brand_id, name, slug, style_code, description)
    values (
      p_tenant_id, p_brand_id, btrim(p_name), lower(btrim(p_slug)),
      case when p_style_code is null or btrim(p_style_code) = '' then null else btrim(p_style_code) end,
      case when p_description is null or btrim(p_description) = '' then null else btrim(p_description) end
    )
    returning id into v_product_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform catalog_private.raise_catalog_unique_conflict(v_constraint);
    when foreign_key_violation then
      -- The (tenant_id, brand_id) composite FK proves the brand belongs to this tenant.
      raise exception using errcode = 'CT001', message = 'brand not found for tenant';
  end;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object(
      'product_id', v_product_id, 'status', 'draft', 'storefront_status', 'unpublished'
    )
  );
  return query select v_product_id, 'draft'::text, 'unpublished'::text;
end;
$function$;

create function catalog_private.update_product(
  p_tenant_id uuid,
  p_product_id uuid,
  p_name text,
  p_slug text,
  p_style_code text,
  p_description text,
  p_idempotency_key text
)
returns table (product_id uuid)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_constraint text;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'update_product' || E'\n' || p_product_id::text || E'\n'
    || btrim(p_name) || E'\n' || lower(btrim(p_slug)) || E'\n'
    || coalesce(lower(btrim(p_style_code)), '') || E'\n' || coalesce(btrim(p_description), '')
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'update_product', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'product_id')::uuid;
    return;
  end if;

  begin
    update public.products
    set name = btrim(p_name),
        slug = lower(btrim(p_slug)),
        style_code = case when p_style_code is null or btrim(p_style_code) = '' then null else btrim(p_style_code) end,
        description = case when p_description is null or btrim(p_description) = '' then null else btrim(p_description) end,
        updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id and id = p_product_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform catalog_private.raise_catalog_unique_conflict(v_constraint);
  end;

  if not found then
    raise exception using errcode = 'CT001', message = 'product not found';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key, pg_catalog.jsonb_build_object('product_id', p_product_id)
  );
  return query select p_product_id;
end;
$function$;

-- Internal (draft/active/archived) lifecycle. Publication is a separate boundary (below): a published
-- product cannot be deactivated (unpublish first), and archiving force-unpublishes atomically.
create function catalog_private.set_product_status(
  p_tenant_id uuid,
  p_product_id uuid,
  p_target_status text,
  p_archive_reason text,
  p_idempotency_key text
)
returns table (product_id uuid, status text, storefront_status text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_current text;
  v_storefront text;
  v_next_storefront text;
  v_next_published_at timestamptz;
begin
  if p_target_status not in ('active', 'draft', 'archived') then
    raise exception using errcode = '22023', message = 'invalid target status';
  end if;

  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'set_product_status' || E'\n' || p_product_id::text || E'\n'
    || p_target_status || E'\n' || coalesce(btrim(p_archive_reason), '')
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'set_product_status', v_fingerprint);
  if v_replay is not null then
    return query select
      (v_replay ->> 'product_id')::uuid, v_replay ->> 'status', v_replay ->> 'storefront_status';
    return;
  end if;

  select status, storefront_status into v_current, v_storefront
  from public.products
  where tenant_id = p_tenant_id and id = p_product_id
  for update;

  if not found then
    raise exception using errcode = 'CT001', message = 'product not found';
  end if;

  -- Archived is terminal: no reactivation via this command.
  if v_current = 'archived' and p_target_status <> 'archived' then
    raise exception using errcode = 'CT030', message = 'archived product cannot be reactivated';
  end if;

  if p_target_status = 'draft' and v_current = 'active' and v_storefront = 'published' then
    raise exception using errcode = 'CT032', message = 'unpublish the product before deactivating it';
  end if;

  if p_target_status = 'archived' then
    -- Archiving force-unpublishes in the same transaction so a cancelled product never stays public.
    v_next_storefront := 'unpublished';
    v_next_published_at := null;
    update public.products
    set status = 'archived',
        archived_at = pg_catalog.now(),
        archive_reason = case when p_archive_reason is null or btrim(p_archive_reason) = '' then null else btrim(p_archive_reason) end,
        storefront_status = v_next_storefront,
        storefront_published_at = v_next_published_at,
        updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id and id = p_product_id;
  else
    update public.products
    set status = p_target_status,
        archived_at = null,
        archive_reason = null,
        updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id and id = p_product_id;
    v_next_storefront := v_storefront;
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('product_id', p_product_id, 'status', p_target_status, 'storefront_status', v_next_storefront)
  );
  return query select p_product_id, p_target_status, v_next_storefront;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Variant create (default option signature) + base price write
-- ---------------------------------------------------------------------------------------------------
create function catalog_private.create_variant(
  p_tenant_id uuid,
  p_product_id uuid,
  p_sku text,
  p_display_name text,
  p_idempotency_key text
)
returns table (variant_id uuid, status text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_variant_id uuid;
  v_constraint text;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'create_variant' || E'\n' || p_product_id::text || E'\n'
    || lower(btrim(p_sku)) || E'\n' || coalesce(btrim(p_display_name), '')
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'create_variant', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'variant_id')::uuid, v_replay ->> 'status';
    return;
  end if;

  if not exists (
    select 1 from public.products
    where tenant_id = p_tenant_id and id = p_product_id and status <> 'archived'
  ) then
    raise exception using errcode = 'CT001', message = 'product not found or archived';
  end if;

  -- A new variant is created internally 'active' (sellable via POS/inventory); Storefront visibility
  -- additionally requires product publication and an active price (derived, not a second flag).
  begin
    insert into public.product_variants (tenant_id, product_id, sku, display_name, status)
    values (
      p_tenant_id, p_product_id, btrim(p_sku),
      case when p_display_name is null or btrim(p_display_name) = '' then null else btrim(p_display_name) end,
      'active'
    )
    returning id into v_variant_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform catalog_private.raise_catalog_unique_conflict(v_constraint);
  end;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('variant_id', v_variant_id, 'status', 'active')
  );
  return query select v_variant_id, 'active'::text;
end;
$function$;

create function catalog_private.set_variant_price(
  p_tenant_id uuid,
  p_variant_id uuid,
  p_currency text,
  p_amount_minor bigint,
  p_idempotency_key text
)
returns table (price_id uuid, currency text, amount_minor bigint)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_price_id uuid;
begin
  if p_amount_minor is null or p_amount_minor < 0 then
    raise exception using errcode = '22023', message = 'price amount must be zero or greater';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'currency must be a 3-letter ISO code';
  end if;

  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'set_variant_price' || E'\n' || p_variant_id::text || E'\n'
    || p_currency || E'\n' || p_amount_minor::text
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'set_variant_price', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'price_id')::uuid, v_replay ->> 'currency', (v_replay ->> 'amount_minor')::bigint;
    return;
  end if;

  -- Lock the variant so the archive-old + insert-new is atomic against a concurrent price write.
  perform 1 from public.product_variants
  where tenant_id = p_tenant_id and id = p_variant_id and status <> 'archived'
  for update;
  if not found then
    raise exception using errcode = 'CT002', message = 'variant not found or archived';
  end if;

  -- Replacing a price archives the old active row and inserts a new active row, retaining history.
  update public.variant_prices
  set status = 'archived', archived_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where tenant_id = p_tenant_id and variant_id = p_variant_id and currency = p_currency and status = 'active';

  insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor)
  values (p_tenant_id, p_variant_id, p_currency, p_amount_minor)
  returning id into v_price_id;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('price_id', v_price_id, 'currency', p_currency, 'amount_minor', p_amount_minor)
  );
  return query select v_price_id, p_currency, p_amount_minor;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Storefront publication boundary
-- ---------------------------------------------------------------------------------------------------
create function catalog_private.publish_product(
  p_tenant_id uuid,
  p_product_id uuid,
  p_idempotency_key text
)
returns table (product_id uuid, storefront_status text, storefront_published_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_status text;
  v_storefront text;
  v_published_at timestamptz;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'publish_product' || E'\n' || p_product_id::text
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'publish_product', v_fingerprint);
  if v_replay is not null then
    return query select
      (v_replay ->> 'product_id')::uuid,
      v_replay ->> 'storefront_status',
      (v_replay ->> 'storefront_published_at')::timestamptz;
    return;
  end if;

  select status, storefront_status, storefront_published_at
  into v_status, v_storefront, v_published_at
  from public.products
  where tenant_id = p_tenant_id and id = p_product_id
  for update;

  if not found then
    raise exception using errcode = 'CT001', message = 'product not found';
  end if;

  if v_status <> 'active' then
    raise exception using errcode = 'CT031', message = 'only an active product can be published';
  end if;

  -- Publication gate: at least one active variant with an active price. Makes publishing a
  -- structurally unsellable product impossible.
  if not exists (
    select 1
    from public.product_variants as variant
    join public.variant_prices as price
      on price.tenant_id = variant.tenant_id
      and price.variant_id = variant.id
      and price.status = 'active'
    where variant.tenant_id = p_tenant_id
      and variant.product_id = p_product_id
      and variant.status = 'active'
  ) then
    raise exception using errcode = 'CT031', message = 'product has no active, priced variant to publish';
  end if;

  -- Preserve the first-publication timestamp across re-publishes.
  if v_storefront <> 'published' then
    v_published_at := pg_catalog.now();
    update public.products
    set storefront_status = 'published', storefront_published_at = v_published_at, updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id and id = p_product_id;
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object(
      'product_id', p_product_id, 'storefront_status', 'published',
      'storefront_published_at', v_published_at
    )
  );
  return query select p_product_id, 'published'::text, v_published_at;
end;
$function$;

create function catalog_private.unpublish_product(
  p_tenant_id uuid,
  p_product_id uuid,
  p_idempotency_key text
)
returns table (product_id uuid, storefront_status text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'unpublish_product' || E'\n' || p_product_id::text
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'unpublish_product', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'product_id')::uuid, v_replay ->> 'storefront_status';
    return;
  end if;

  update public.products
  set storefront_status = 'unpublished', storefront_published_at = null, updated_at = pg_catalog.now()
  where tenant_id = p_tenant_id and id = p_product_id;

  if not found then
    raise exception using errcode = 'CT001', message = 'product not found';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('product_id', p_product_id, 'storefront_status', 'unpublished')
  );
  return query select p_product_id, 'unpublished'::text;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Product media references (object-storage pointers, never binaries)
-- ---------------------------------------------------------------------------------------------------
create function catalog_private.add_product_media(
  p_tenant_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_alt_text text,
  p_position integer,
  p_is_primary boolean,
  p_idempotency_key text
)
returns table (media_id uuid, is_primary boolean)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_media_id uuid;
  v_primary boolean := coalesce(p_is_primary, false);
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'add_product_media' || E'\n' || p_product_id::text || E'\n'
    || coalesce(p_variant_id::text, '') || E'\n' || btrim(p_storage_bucket) || E'\n'
    || lower(btrim(p_storage_path)) || E'\n' || coalesce(btrim(p_alt_text), '') || E'\n'
    || coalesce(p_position, 0)::text || E'\n' || v_primary::text
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'add_product_media', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'media_id')::uuid, (v_replay ->> 'is_primary')::boolean;
    return;
  end if;

  if not exists (
    select 1 from public.products where tenant_id = p_tenant_id and id = p_product_id
  ) then
    raise exception using errcode = 'CT001', message = 'product not found';
  end if;

  -- A new primary demotes any existing active primary first, so the partial unique index never trips.
  if v_primary then
    update public.product_media
    set is_primary = false, updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id and product_id = p_product_id and is_primary and status = 'active';
  end if;

  insert into public.product_media (
    tenant_id, product_id, variant_id, storage_bucket, storage_path, alt_text, position, is_primary
  )
  values (
    p_tenant_id, p_product_id, p_variant_id, btrim(p_storage_bucket), btrim(p_storage_path),
    case when p_alt_text is null or btrim(p_alt_text) = '' then null else btrim(p_alt_text) end,
    coalesce(p_position, 0), v_primary
  )
  returning id into v_media_id;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('media_id', v_media_id, 'is_primary', v_primary)
  );
  return query select v_media_id, v_primary;
end;
$function$;

create function catalog_private.archive_product_media(
  p_tenant_id uuid,
  p_media_id uuid,
  p_idempotency_key text
)
returns table (media_id uuid)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'archive_product_media' || E'\n' || p_media_id::text
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'archive_product_media', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'media_id')::uuid;
    return;
  end if;

  update public.product_media
  set status = 'archived', archived_at = pg_catalog.now(), is_primary = false, updated_at = pg_catalog.now()
  where tenant_id = p_tenant_id and id = p_media_id;

  if not found then
    raise exception using errcode = 'CT005', message = 'product media not found';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key, pg_catalog.jsonb_build_object('media_id', p_media_id)
  );
  return query select p_media_id;
end;
$function$;
