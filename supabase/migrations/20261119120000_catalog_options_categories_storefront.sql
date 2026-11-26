-- Phase 1A (Storefront program): structured product options and categories.
--
-- The option tables (product_options / product_option_values / variant_option_values) and the category
-- taxonomy (categories / product_categories) exist since Phase 2A, but there was no sanctioned write path
-- and the public projection did not expose them. This migration adds:
--   1. an optional colour swatch per option value (for colour chips on the Storefront);
--   2. sanctioned write functions (catalog_private, service_role only, idempotent) to set a variant's
--      option values, create a variant together with its options, edit option values, and manage
--      categories and a product's category membership;
--   3. a richer public product projection (options, per-variant option values, categories) and a
--      published-only category list for Storefront navigation and filtering.
--
-- New internal SQLSTATEs (mapped by the repositories):
--   CT021 variant option combination already used by another variant of the product
--   CT022 option value not found for the product
--   CT050 category not found          CT051 category hierarchy would contain a cycle

alter table public.product_option_values
  add column swatch_hex text,
  add constraint product_option_values_swatch_hex_valid
    check (swatch_hex is null or swatch_hex ~ '^#[0-9a-f]{6}$');

comment on column public.product_option_values.swatch_hex is
  'Optional lowercase #rrggbb colour used to render a swatch for this value on the Storefront.';

-- ---------------------------------------------------------------------------------------------------
-- Options: internal helper (no idempotency; callers own the transaction and the idempotency claim)
-- ---------------------------------------------------------------------------------------------------

-- p_options is the complete, ordered selection for the variant: [{"name": "Size", "value": "M"}, ...].
-- Options and values are matched case-insensitively and created on first use (product-local); archived
-- ones are reactivated. An empty array returns the variant to the 'default' (no options) signature.
create function catalog_private.apply_variant_options(
  p_tenant_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_options jsonb
)
returns text
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_entry jsonb;
  v_name text;
  v_value text;
  v_option_id uuid;
  v_value_id uuid;
  v_position integer;
  v_signature text;
  v_constraint text;
begin
  if p_options is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) > 3 then
    raise exception using errcode = '22023', message = 'options must be an array of at most 3 entries';
  end if;
  if (
    select count(*) <> count(distinct lower(btrim(value ->> 'name')))
    from jsonb_array_elements(p_options)
  ) then
    raise exception using errcode = '22023', message = 'option names must be distinct';
  end if;

  if not exists (
    select 1 from public.product_variants
    where tenant_id = p_tenant_id and product_id = p_product_id and id = p_variant_id
  ) then
    raise exception using errcode = 'CT002', message = 'variant not found for product';
  end if;

  -- Serialize option/value creation per product so concurrent variant writes cannot race the
  -- product-local unique names.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('catalog-options:' || p_tenant_id::text || ':' || p_product_id::text, 0)
  );

  delete from public.variant_option_values
  where tenant_id = p_tenant_id and product_id = p_product_id and variant_id = p_variant_id;

  for v_entry in select value from jsonb_array_elements(p_options) loop
    v_name := btrim(coalesce(v_entry ->> 'name', ''));
    v_value := btrim(coalesce(v_entry ->> 'value', ''));
    if v_name = '' or v_value = '' or length(v_name) > 60 or length(v_value) > 60 then
      raise exception using errcode = '22023', message = 'option name and value must be 1-60 characters';
    end if;

    select id into v_option_id from public.product_options
    where tenant_id = p_tenant_id and product_id = p_product_id and normalized_name = lower(v_name);
    if v_option_id is null then
      select coalesce(max(position) + 1, 0) into v_position from public.product_options
      where tenant_id = p_tenant_id and product_id = p_product_id;
      insert into public.product_options (tenant_id, product_id, name, position)
      values (p_tenant_id, p_product_id, v_name, v_position)
      returning id into v_option_id;
    else
      update public.product_options
      set status = 'active', archived_at = null, updated_at = pg_catalog.now()
      where tenant_id = p_tenant_id and id = v_option_id and status = 'archived';
    end if;

    select id into v_value_id from public.product_option_values
    where tenant_id = p_tenant_id and option_id = v_option_id and normalized_value = lower(v_value);
    if v_value_id is null then
      select coalesce(max(position) + 1, 0) into v_position from public.product_option_values
      where tenant_id = p_tenant_id and option_id = v_option_id;
      insert into public.product_option_values (tenant_id, product_id, option_id, display_value, position)
      values (p_tenant_id, p_product_id, v_option_id, v_value, v_position)
      returning id into v_value_id;
    else
      update public.product_option_values
      set status = 'active', archived_at = null, updated_at = pg_catalog.now()
      where tenant_id = p_tenant_id and id = v_value_id and status = 'archived';
    end if;

    insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
    values (p_tenant_id, p_product_id, p_variant_id, v_option_id, v_value_id);

    v_option_id := null;
    v_value_id := null;
  end loop;

  v_signature := catalog_private.expected_variant_option_signature(p_tenant_id, p_product_id, p_variant_id);
  begin
    update public.product_variants
    set option_signature = v_signature, updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id and product_id = p_product_id and id = p_variant_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'product_variants_product_option_signature_unique' then
        raise exception using errcode = 'CT021', message = 'another variant already uses these options';
      end if;
      raise;
  end;
  return v_signature;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Options: sanctioned writes
-- ---------------------------------------------------------------------------------------------------

create function catalog_private.set_variant_options(
  p_tenant_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_options jsonb,
  p_idempotency_key text
)
returns table (variant_id uuid, option_signature text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_signature text;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'set_variant_options' || E'\n' || p_product_id::text || E'\n'
    || p_variant_id::text || E'\n' || coalesce(p_options::text, '')
  );
  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'set_variant_options', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'variant_id')::uuid, v_replay ->> 'option_signature';
    return;
  end if;

  v_signature := catalog_private.apply_variant_options(p_tenant_id, p_product_id, p_variant_id, p_options);

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('variant_id', p_variant_id, 'option_signature', v_signature)
  );
  return query select p_variant_id, v_signature;
end;
$function$;

-- Create a variant and set its options atomically, so a new variant never lands on the shared
-- 'default' signature when the product already has option-bearing variants.
create function catalog_private.create_variant_with_options(
  p_tenant_id uuid,
  p_product_id uuid,
  p_sku text,
  p_display_name text,
  p_options jsonb,
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
  v_placeholder text := 'pending:' || pg_catalog.gen_random_uuid()::text;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'create_variant_with_options' || E'\n' || p_product_id::text || E'\n'
    || lower(btrim(p_sku)) || E'\n' || coalesce(btrim(p_display_name), '') || E'\n'
    || coalesce(p_options::text, '')
  );
  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'create_variant_with_options', v_fingerprint);
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

  -- Insert with a unique placeholder signature (the canonical-signature constraint trigger is deferred to
  -- commit), then apply the options, which sets the canonical signature.
  begin
    insert into public.product_variants (tenant_id, product_id, sku, display_name, status, option_signature)
    values (
      p_tenant_id, p_product_id, btrim(p_sku),
      case when p_display_name is null or btrim(p_display_name) = '' then null else btrim(p_display_name) end,
      'active', v_placeholder
    )
    returning id into v_variant_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform catalog_private.raise_catalog_unique_conflict(v_constraint);
  end;

  perform catalog_private.apply_variant_options(
    p_tenant_id, p_product_id, v_variant_id, coalesce(p_options, '[]'::jsonb)
  );

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('variant_id', v_variant_id, 'status', 'active')
  );
  return query select v_variant_id, 'active'::text;
end;
$function$;

-- Edit presentation of existing option values: swatch colour (null clears) and display order.
-- p_values: [{"valueId": uuid, "swatchHex": "#112233" | null, "position": 0}, ...]
create function catalog_private.update_option_values(
  p_tenant_id uuid,
  p_product_id uuid,
  p_values jsonb,
  p_idempotency_key text
)
returns table (product_id uuid, updated_count integer)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_entry jsonb;
  v_hex text;
  v_rows integer;
  v_count integer := 0;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) > 200 then
    raise exception using errcode = '22023', message = 'values must be an array of at most 200 entries';
  end if;
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'update_option_values' || E'\n' || p_product_id::text || E'\n'
    || p_values::text
  );
  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'update_option_values', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'product_id')::uuid, (v_replay ->> 'updated_count')::integer;
    return;
  end if;

  for v_entry in select value from jsonb_array_elements(p_values) loop
    v_hex := nullif(lower(btrim(coalesce(v_entry ->> 'swatchHex', ''))), '');
    update public.product_option_values
    set
      swatch_hex = v_hex,
      position = coalesce((v_entry ->> 'position')::integer, position),
      updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id
      and product_id = p_product_id
      and id = (v_entry ->> 'valueId')::uuid;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception using errcode = 'CT022', message = 'option value not found for product';
    end if;
    v_count := v_count + 1;
  end loop;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('product_id', p_product_id, 'updated_count', v_count)
  );
  return query select p_product_id, v_count;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Categories: sanctioned writes (tenant-wide, like collections)
-- ---------------------------------------------------------------------------------------------------

create function catalog_private.raise_category_write_error(p_constraint text)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_constraint = 'categories_tenant_slug_unique' then
    raise exception using errcode = 'CT010', message = 'category slug already exists';
  elsif p_constraint in ('categories_acyclic', 'categories_not_own_parent') then
    raise exception using errcode = 'CT051', message = 'category hierarchy cannot contain a cycle';
  elsif p_constraint = 'categories_parent_tenant_fk' then
    raise exception using errcode = 'CT050', message = 'parent category not found for tenant';
  end if;
  raise exception using errcode = '22023', message = pg_catalog.format('invalid category (%s)', p_constraint);
end;
$function$;

create function catalog_private.create_category(
  p_tenant_id uuid,
  p_parent_category_id uuid,
  p_name text,
  p_slug text,
  p_description text,
  p_position integer,
  p_idempotency_key text
)
returns table (category_id uuid, status text)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_category_id uuid;
  v_constraint text;
begin
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'create_category' || E'\n' || coalesce(p_parent_category_id::text, '')
    || E'\n' || btrim(p_name) || E'\n' || lower(btrim(p_slug)) || E'\n' || coalesce(btrim(p_description), '')
    || E'\n' || coalesce(p_position::text, '')
  );
  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'create_category', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'category_id')::uuid, v_replay ->> 'status';
    return;
  end if;

  begin
    insert into public.categories (tenant_id, parent_category_id, name, slug, description, position)
    values (
      p_tenant_id, p_parent_category_id, btrim(p_name), lower(btrim(p_slug)),
      case when p_description is null or btrim(p_description) = '' then null else btrim(p_description) end,
      coalesce(p_position, (
        select coalesce(max(position) + 1, 0) from public.categories
        where tenant_id = p_tenant_id and parent_category_id is not distinct from p_parent_category_id
      ))
    )
    returning id into v_category_id;
  exception
    when unique_violation or foreign_key_violation or check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform catalog_private.raise_category_write_error(v_constraint);
  end;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('category_id', v_category_id, 'status', 'active')
  );
  return query select v_category_id, 'active'::text;
end;
$function$;

create function catalog_private.update_category(
  p_tenant_id uuid,
  p_category_id uuid,
  p_parent_category_id uuid,
  p_name text,
  p_slug text,
  p_description text,
  p_position integer,
  p_idempotency_key text
)
returns table (category_id uuid)
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
    p_tenant_id::text || E'\n' || 'update_category' || E'\n' || p_category_id::text || E'\n'
    || coalesce(p_parent_category_id::text, '') || E'\n' || btrim(p_name) || E'\n' || lower(btrim(p_slug))
    || E'\n' || coalesce(btrim(p_description), '') || E'\n' || coalesce(p_position::text, '')
  );
  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'update_category', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'category_id')::uuid;
    return;
  end if;

  begin
    update public.categories
    set
      parent_category_id = p_parent_category_id,
      name = btrim(p_name),
      slug = lower(btrim(p_slug)),
      description = case when p_description is null or btrim(p_description) = '' then null else btrim(p_description) end,
      position = coalesce(p_position, position),
      updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id and id = p_category_id;
    get diagnostics v_rows = row_count;
  exception
    when unique_violation or foreign_key_violation or check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform catalog_private.raise_category_write_error(v_constraint);
  end;
  if v_rows = 0 then
    raise exception using errcode = 'CT050', message = 'category not found for tenant';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key, pg_catalog.jsonb_build_object('category_id', p_category_id)
  );
  return query select p_category_id;
end;
$function$;

create function catalog_private.set_category_status(
  p_tenant_id uuid,
  p_category_id uuid,
  p_target_status text,
  p_archive_reason text,
  p_idempotency_key text
)
returns table (category_id uuid, status text)
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
  if p_target_status not in ('active', 'archived') then
    raise exception using errcode = '22023', message = 'invalid category status';
  end if;
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'set_category_status' || E'\n' || p_category_id::text || E'\n'
    || p_target_status || E'\n' || coalesce(btrim(p_archive_reason), '')
  );
  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'set_category_status', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'category_id')::uuid, v_replay ->> 'status';
    return;
  end if;

  update public.categories
  set
    status = p_target_status,
    archived_at = case when p_target_status = 'archived' then pg_catalog.now() else null end,
    archive_reason = case when p_target_status = 'archived'
      then nullif(btrim(coalesce(p_archive_reason, '')), '') else null end,
    updated_at = pg_catalog.now()
  where tenant_id = p_tenant_id and id = p_category_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception using errcode = 'CT050', message = 'category not found for tenant';
  end if;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('category_id', p_category_id, 'status', p_target_status)
  );
  return query select p_category_id, p_target_status;
end;
$function$;

-- Replace a product's full category membership. Unknown/cross-tenant ids are rejected by the FK.
create function catalog_private.set_product_categories(
  p_tenant_id uuid,
  p_product_id uuid,
  p_category_ids uuid[],
  p_idempotency_key text
)
returns table (product_id uuid, category_count integer)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
  v_ids uuid[] := coalesce(p_category_ids, array[]::uuid[]);
  v_count integer;
  v_constraint text;
begin
  if cardinality(v_ids) > 50 then
    raise exception using errcode = '22023', message = 'too many categories';
  end if;
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'set_product_categories' || E'\n' || p_product_id::text || E'\n'
    || array_to_string(v_ids, ',')
  );
  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'set_product_categories', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'product_id')::uuid, (v_replay ->> 'category_count')::integer;
    return;
  end if;

  if not exists (select 1 from public.products where tenant_id = p_tenant_id and id = p_product_id) then
    raise exception using errcode = 'CT001', message = 'product not found for tenant';
  end if;

  delete from public.product_categories where tenant_id = p_tenant_id and product_id = p_product_id;
  begin
    insert into public.product_categories (tenant_id, product_id, category_id)
    select distinct p_tenant_id, p_product_id, id from unnest(v_ids) as t(id);
  exception
    when foreign_key_violation then
      get stacked diagnostics v_constraint = constraint_name;
      raise exception using errcode = 'CT050', message = 'category not found for tenant';
  end;

  select count(*) into v_count from public.product_categories
  where tenant_id = p_tenant_id and product_id = p_product_id;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('product_id', p_product_id, 'category_count', v_count)
  );
  return query select p_product_id, v_count;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Public read boundary
-- ---------------------------------------------------------------------------------------------------

-- A category is publicly usable when it and every ancestor are active.
create function catalog_public.is_category_active_path(p_tenant_id uuid, p_category_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with recursive path as (
    select category.id, category.parent_category_id, category.status
    from public.categories as category
    where category.tenant_id = p_tenant_id and category.id = p_category_id
    union all
    select parent.id, parent.parent_category_id, parent.status
    from public.categories as parent
    join path on parent.id = path.parent_category_id
    where parent.tenant_id = p_tenant_id
  )
  select exists (select 1 from path) and not exists (select 1 from path where status <> 'active');
$function$;

-- Same projection as 20261114150000 plus options, per-variant option values and categories.
create or replace function catalog_public.build_published_product(p_product public.products)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_product.id,
    'brandId', p_product.brand_id,
    'slug', p_product.slug,
    'name', p_product.name,
    'description', p_product.description,
    'publishedAt', p_product.storefront_published_at,
    'media', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', media.id,
          'variantId', media.variant_id,
          'bucket', media.storage_bucket,
          'path', media.storage_path,
          'altText', media.alt_text,
          'position', media.position,
          'isPrimary', media.is_primary
        )
        order by media.is_primary desc, media.position, media.id
      )
      from public.product_media as media
      where media.tenant_id = p_product.tenant_id
        and media.product_id = p_product.id
        and media.status = 'active'
    ), '[]'::jsonb),
    'variants', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', variant.id,
          'sku', variant.sku,
          'displayName', variant.display_name,
          'optionSignature', variant.option_signature,
          'optionValues', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object('name', opt.name, 'value', val.display_value)
              order by opt.position, opt.id
            )
            from public.variant_option_values as selection
            join public.product_options as opt
              on opt.tenant_id = selection.tenant_id and opt.id = selection.option_id
            join public.product_option_values as val
              on val.tenant_id = selection.tenant_id and val.id = selection.option_value_id
            where selection.tenant_id = variant.tenant_id and selection.variant_id = variant.id
          ), '[]'::jsonb),
          'prices', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'currency', priced.currency,
                'amountMinor', priced.effective,
                'compareAtAmountMinor', case when priced.effective < priced.amount_minor then priced.amount_minor else null end
              )
              order by priced.currency
            )
            from (
              select price.currency, price.amount_minor,
                catalog_private.effective_unit_price(p_product.tenant_id, p_product.id, price.currency, price.amount_minor) as effective
              from public.variant_prices as price
              where price.tenant_id = variant.tenant_id
                and price.variant_id = variant.id
                and price.status = 'active'
            ) as priced
          ), '[]'::jsonb),
          'availableQuantity', coalesce((
            select pg_catalog.sum(inventory_private.channel_online_sellable(
              balance.tenant_id, balance.inventory_location_id, balance.variant_id, balance.on_hand_quantity))
            from public.inventory_balances as balance
            where balance.tenant_id = variant.tenant_id
              and balance.variant_id = variant.id
              and (not exists(select 1 from public.storefront_checkout_settings s where s.tenant_id=p_product.tenant_id and s.brand_id=p_product.brand_id)
                or balance.inventory_location_id=(select s.inventory_location_id from public.storefront_checkout_settings s where s.tenant_id=p_product.tenant_id and s.brand_id=p_product.brand_id))
          ), 0)
        )
        order by variant.created_at, variant.id
      )
      from public.product_variants as variant
      where variant.tenant_id = p_product.tenant_id
        and variant.product_id = p_product.id
        and variant.status = 'active'
        and exists (
          select 1 from public.variant_prices as price
          where price.tenant_id = variant.tenant_id
            and price.variant_id = variant.id
            and price.status = 'active'
        )
    ), '[]'::jsonb),
    -- Option dimensions in display order, with only the values a publicly listed variant uses.
    'options', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'name', opt.name,
          'values', (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object('value', val.display_value, 'swatchHex', val.swatch_hex)
              order by val.position, val.display_value
            )
            from public.product_option_values as val
            where val.tenant_id = opt.tenant_id
              and val.option_id = opt.id
              and val.status = 'active'
              and exists (
                select 1
                from public.variant_option_values as selection
                join public.product_variants as variant
                  on variant.tenant_id = selection.tenant_id and variant.id = selection.variant_id
                where selection.tenant_id = val.tenant_id
                  and selection.option_value_id = val.id
                  and variant.status = 'active'
                  and exists (
                    select 1 from public.variant_prices as price
                    where price.tenant_id = variant.tenant_id and price.variant_id = variant.id
                      and price.status = 'active'
                  )
              )
          )
        )
        order by opt.position, opt.id
      )
      from public.product_options as opt
      where opt.tenant_id = p_product.tenant_id
        and opt.product_id = p_product.id
        and opt.status = 'active'
        -- Only dimensions that at least one publicly listed (active, priced) variant uses.
        and exists (
          select 1
          from public.variant_option_values as selection
          join public.product_variants as variant
            on variant.tenant_id = selection.tenant_id and variant.id = selection.variant_id
          where selection.tenant_id = opt.tenant_id
            and selection.option_id = opt.id
            and variant.status = 'active'
            and exists (
              select 1 from public.variant_prices as price
              where price.tenant_id = variant.tenant_id and price.variant_id = variant.id
                and price.status = 'active'
            )
        )
    ), '[]'::jsonb),
    'categories', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('id', category.id, 'slug', category.slug, 'name', category.name)
        order by category.position, category.name
      )
      from public.product_categories as membership
      join public.categories as category
        on category.tenant_id = membership.tenant_id and category.id = membership.category_id
      where membership.tenant_id = p_product.tenant_id
        and membership.product_id = p_product.id
        and catalog_public.is_category_active_path(category.tenant_id, category.id)
    ), '[]'::jsonb),
    'offers', catalog_private.product_offers(p_product)
  );
$function$;

-- Published-only category list for Storefront navigation. Each row is an active category (with an
-- all-active ancestry) and the number of publicly visible products in it or any descendant; categories
-- with no visible products are omitted so navigation never leads to an empty page.
create function catalog_public.list_storefront_categories(p_tenant_id uuid)
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
    'productCount', counts.product_count
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
revoke all on function catalog_private.apply_variant_options(uuid, uuid, uuid, jsonb) from public;
revoke all on function catalog_private.set_variant_options(uuid, uuid, uuid, jsonb, text) from public;
revoke all on function catalog_private.create_variant_with_options(uuid, uuid, text, text, jsonb, text) from public;
revoke all on function catalog_private.update_option_values(uuid, uuid, jsonb, text) from public;
revoke all on function catalog_private.raise_category_write_error(text) from public;
revoke all on function catalog_private.create_category(uuid, uuid, text, text, text, integer, text) from public;
revoke all on function catalog_private.update_category(uuid, uuid, uuid, text, text, text, integer, text) from public;
revoke all on function catalog_private.set_category_status(uuid, uuid, text, text, text) from public;
revoke all on function catalog_private.set_product_categories(uuid, uuid, uuid[], text) from public;
revoke all on function catalog_public.is_category_active_path(uuid, uuid) from public;
revoke all on function catalog_public.list_storefront_categories(uuid) from public;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    -- Internal helpers run as the invoking service_role inside the sanctioned writes.
    execute 'grant execute on function catalog_private.apply_variant_options(uuid, uuid, uuid, jsonb) to service_role';
    execute 'grant execute on function catalog_private.raise_category_write_error(text) to service_role';
    execute 'grant execute on function catalog_public.is_category_active_path(uuid, uuid) to service_role';
    execute 'grant execute on function catalog_private.set_variant_options(uuid, uuid, uuid, jsonb, text) to service_role';
    execute 'grant execute on function catalog_private.create_variant_with_options(uuid, uuid, text, text, jsonb, text) to service_role';
    execute 'grant execute on function catalog_private.update_option_values(uuid, uuid, jsonb, text) to service_role';
    execute 'grant execute on function catalog_private.create_category(uuid, uuid, text, text, text, integer, text) to service_role';
    execute 'grant execute on function catalog_private.update_category(uuid, uuid, uuid, text, text, text, integer, text) to service_role';
    execute 'grant execute on function catalog_private.set_category_status(uuid, uuid, text, text, text) to service_role';
    execute 'grant execute on function catalog_private.set_product_categories(uuid, uuid, uuid[], text) to service_role';
    execute 'grant execute on function catalog_public.list_storefront_categories(uuid) to service_role';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'grant execute on function catalog_public.list_storefront_categories(uuid) to anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function catalog_public.list_storefront_categories(uuid) to authenticated';
  end if;
end;
$block$;
