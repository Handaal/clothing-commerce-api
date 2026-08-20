-- Phase 2A: tenant-owned products, variants, identifiers, and extensible options.

create schema if not exists catalog_private;
revoke all on schema catalog_private from public;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  brand_id uuid not null,
  name text not null,
  slug text not null,
  normalized_slug text generated always as (lower(btrim(slug))) stored,
  style_code text,
  normalized_style_code text generated always as (lower(btrim(style_code))) stored,
  description text,
  status text not null default 'draft',
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint products_brand_tenant_fk
    foreign key (tenant_id, brand_id) references public.brands (tenant_id, id) on delete restrict,
  constraint products_name_not_empty check (btrim(name) <> ''),
  constraint products_slug_not_empty check (normalized_slug <> ''),
  constraint products_slug_valid check (normalized_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint products_style_code_not_empty check (
    normalized_style_code is null or normalized_style_code <> ''
  ),
  constraint products_description_not_empty check (description is null or btrim(description) <> ''),
  constraint products_status_valid check (status in ('draft', 'active', 'archived')),
  constraint products_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint products_updated_after_created check (updated_at >= created_at),
  constraint products_tenant_id_unique unique (tenant_id, id),
  constraint products_tenant_slug_unique unique (tenant_id, normalized_slug)
);

comment on table public.products is
  'Tenant- and brand-owned catalog styles. Active means internally eligible, not published.';

create unique index products_tenant_style_code_unique_idx
  on public.products (tenant_id, normalized_style_code)
  where normalized_style_code is not null;

create index products_tenant_brand_status_idx
  on public.products (tenant_id, brand_id, status);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  product_id uuid not null,
  sku text not null,
  normalized_sku text generated always as (lower(btrim(sku))) stored,
  display_name text,
  option_signature text not null default 'default',
  status text not null default 'draft',
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_variants_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint product_variants_product_tenant_fk
    foreign key (tenant_id, product_id) references public.products (tenant_id, id) on delete restrict,
  constraint product_variants_sku_not_empty check (normalized_sku <> ''),
  constraint product_variants_display_name_not_empty check (
    display_name is null or btrim(display_name) <> ''
  ),
  constraint product_variants_option_signature_not_empty check (btrim(option_signature) <> ''),
  constraint product_variants_status_valid check (status in ('draft', 'active', 'archived')),
  constraint product_variants_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint product_variants_updated_after_created check (updated_at >= created_at),
  constraint product_variants_tenant_id_unique unique (tenant_id, id),
  constraint product_variants_tenant_product_id_unique unique (tenant_id, product_id, id),
  constraint product_variants_tenant_sku_unique unique (tenant_id, normalized_sku),
  constraint product_variants_product_option_signature_unique
    unique (tenant_id, product_id, option_signature)
);

comment on table public.product_variants is
  'Sellable catalog identities beneath a product; sellability also requires later publication, price, and inventory rules.';
comment on column public.product_variants.option_signature is
  'Canonical comma-separated option-value UUIDs ordered by option UUID, or default when no values are selected.';

create index product_variants_product_status_idx
  on public.product_variants (tenant_id, product_id, status);

create table public.variant_barcodes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  variant_id uuid not null,
  value text not null,
  normalized_value text generated always as (lower(btrim(value))) stored,
  barcode_type text not null default 'other',
  is_primary boolean not null default false,
  status text not null default 'active',
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint variant_barcodes_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint variant_barcodes_variant_tenant_fk
    foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id)
    on delete restrict,
  constraint variant_barcodes_value_not_empty check (normalized_value <> ''),
  constraint variant_barcodes_type_valid check (
    barcode_type in ('ean13', 'upc_a', 'code128', 'other')
  ),
  constraint variant_barcodes_status_valid check (status in ('active', 'retired')),
  constraint variant_barcodes_retirement_state_consistent check (
    (status = 'retired') = (retired_at is not null)
  ),
  constraint variant_barcodes_primary_must_be_active check (not is_primary or status = 'active'),
  constraint variant_barcodes_updated_after_created check (updated_at >= created_at),
  constraint variant_barcodes_tenant_id_unique unique (tenant_id, id),
  constraint variant_barcodes_tenant_value_unique unique (tenant_id, normalized_value)
);

comment on table public.variant_barcodes is
  'Tenant-wide, lifecycle-non-reusable variant scan identifiers; a variant may have several.';

create unique index variant_barcodes_one_active_primary_idx
  on public.variant_barcodes (tenant_id, variant_id)
  where is_primary and status = 'active';

create index variant_barcodes_variant_lookup_idx
  on public.variant_barcodes (tenant_id, variant_id, status);

create table public.product_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  product_id uuid not null,
  name text not null,
  normalized_name text generated always as (lower(btrim(name))) stored,
  position integer not null default 0,
  status text not null default 'active',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_options_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint product_options_product_tenant_fk
    foreign key (tenant_id, product_id) references public.products (tenant_id, id) on delete restrict,
  constraint product_options_name_not_empty check (normalized_name <> ''),
  constraint product_options_position_nonnegative check (position >= 0),
  constraint product_options_status_valid check (status in ('active', 'archived')),
  constraint product_options_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint product_options_updated_after_created check (updated_at >= created_at),
  constraint product_options_tenant_id_unique unique (tenant_id, id),
  constraint product_options_tenant_product_id_unique unique (tenant_id, product_id, id),
  constraint product_options_product_name_unique unique (tenant_id, product_id, normalized_name)
);

comment on table public.product_options is
  'Product-defined option dimensions such as Size or Color; no dimensions are hardcoded.';

create table public.product_option_values (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  product_id uuid not null,
  option_id uuid not null,
  display_value text not null,
  normalized_value text generated always as (lower(btrim(display_value))) stored,
  position integer not null default 0,
  status text not null default 'active',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_option_values_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint product_option_values_option_product_tenant_fk
    foreign key (tenant_id, product_id, option_id)
    references public.product_options (tenant_id, product_id, id)
    on delete restrict,
  constraint product_option_values_value_not_empty check (normalized_value <> ''),
  constraint product_option_values_position_nonnegative check (position >= 0),
  constraint product_option_values_status_valid check (status in ('active', 'archived')),
  constraint product_option_values_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint product_option_values_updated_after_created check (updated_at >= created_at),
  constraint product_option_values_tenant_id_unique unique (tenant_id, id),
  constraint product_option_values_tenant_product_option_id_unique
    unique (tenant_id, product_id, option_id, id),
  constraint product_option_values_option_value_unique
    unique (tenant_id, option_id, normalized_value)
);

comment on table public.product_option_values is
  'Allowed values for a product option; values remain product-local and tenant-safe.';

create table public.variant_option_values (
  tenant_id uuid not null,
  product_id uuid not null,
  variant_id uuid not null,
  option_id uuid not null,
  option_value_id uuid not null,
  created_at timestamptz not null default now(),
  constraint variant_option_values_pk primary key (tenant_id, variant_id, option_id),
  constraint variant_option_values_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint variant_option_values_variant_product_tenant_fk
    foreign key (tenant_id, product_id, variant_id)
    references public.product_variants (tenant_id, product_id, id)
    on delete restrict,
  constraint variant_option_values_option_product_tenant_fk
    foreign key (tenant_id, product_id, option_id)
    references public.product_options (tenant_id, product_id, id)
    on delete restrict,
  constraint variant_option_values_value_option_product_tenant_fk
    foreign key (tenant_id, product_id, option_id, option_value_id)
    references public.product_option_values (tenant_id, product_id, option_id, id)
    on delete restrict
);

comment on table public.variant_option_values is
  'One selected value per product option for a variant, with cross-product and cross-tenant links rejected structurally.';

create index variant_option_values_value_lookup_idx
  on public.variant_option_values (tenant_id, option_value_id, variant_id);

create function catalog_private.expected_variant_option_signature(
  requested_tenant_id uuid,
  requested_product_id uuid,
  requested_variant_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    string_agg(selection.option_value_id::text, ',' order by selection.option_id),
    'default'
  )
  from public.variant_option_values as selection
  where selection.tenant_id = requested_tenant_id
    and selection.product_id = requested_product_id
    and selection.variant_id = requested_variant_id;
$function$;

create function catalog_private.enforce_variant_option_signature()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  affected_tenant_id uuid;
  affected_product_id uuid;
  affected_variant_id uuid;
  actual_signature text;
  expected_signature text;
begin
  if tg_table_name = 'product_variants' then
    affected_tenant_id := new.tenant_id;
    affected_product_id := new.product_id;
    affected_variant_id := new.id;
  else
    affected_tenant_id := coalesce(new.tenant_id, old.tenant_id);
    affected_product_id := coalesce(new.product_id, old.product_id);
    affected_variant_id := coalesce(new.variant_id, old.variant_id);
  end if;

  select variant.option_signature
  into actual_signature
  from public.product_variants as variant
  where variant.tenant_id = affected_tenant_id
    and variant.product_id = affected_product_id
    and variant.id = affected_variant_id;

  if not found then
    return null;
  end if;

  expected_signature := catalog_private.expected_variant_option_signature(
    affected_tenant_id,
    affected_product_id,
    affected_variant_id
  );

  if actual_signature <> expected_signature then
    raise exception using
      errcode = '23514',
      constraint = 'product_variants_option_signature_canonical',
      message = pg_catalog.format(
        'variant option_signature must be %L for its selected option values',
        expected_signature
      );
  end if;

  if tg_table_name = 'variant_option_values' and tg_op = 'UPDATE' then
    if (old.tenant_id, old.product_id, old.variant_id)
      is distinct from (new.tenant_id, new.product_id, new.variant_id)
    then
      select variant.option_signature
      into actual_signature
      from public.product_variants as variant
      where variant.tenant_id = old.tenant_id
        and variant.product_id = old.product_id
        and variant.id = old.variant_id;

      if found then
        expected_signature := catalog_private.expected_variant_option_signature(
          old.tenant_id,
          old.product_id,
          old.variant_id
        );

        if actual_signature <> expected_signature then
          raise exception using
            errcode = '23514',
            constraint = 'product_variants_option_signature_canonical',
            message = pg_catalog.format(
              'source variant option_signature must be %L after moving selected option values',
              expected_signature
            );
        end if;
      end if;
    end if;
  end if;

  return null;
end;
$function$;

create constraint trigger product_variants_option_signature_canonical
after insert or update on public.product_variants
deferrable initially deferred
for each row execute function catalog_private.enforce_variant_option_signature();

create constraint trigger variant_option_values_signature_canonical
after insert or update or delete on public.variant_option_values
deferrable initially deferred
for each row execute function catalog_private.enforce_variant_option_signature();

revoke all on function catalog_private.expected_variant_option_signature(uuid, uuid, uuid) from public;
revoke all on function catalog_private.enforce_variant_option_signature() from public;
