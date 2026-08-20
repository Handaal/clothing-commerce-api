-- Phase 2A: tenant-safe categories, collections, and product associations.

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  parent_category_id uuid,
  name text not null,
  slug text not null,
  normalized_slug text generated always as (lower(btrim(slug))) stored,
  description text,
  position integer not null default 0,
  status text not null default 'active',
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint categories_parent_tenant_fk
    foreign key (tenant_id, parent_category_id)
    references public.categories (tenant_id, id)
    on delete restrict,
  constraint categories_not_own_parent check (parent_category_id is distinct from id),
  constraint categories_name_not_empty check (btrim(name) <> ''),
  constraint categories_slug_not_empty check (normalized_slug <> ''),
  constraint categories_slug_valid check (normalized_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint categories_description_not_empty check (description is null or btrim(description) <> ''),
  constraint categories_position_nonnegative check (position >= 0),
  constraint categories_status_valid check (status in ('active', 'archived')),
  constraint categories_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint categories_updated_after_created check (updated_at >= created_at),
  constraint categories_tenant_id_unique unique (tenant_id, id),
  constraint categories_tenant_slug_unique unique (tenant_id, normalized_slug)
);

comment on table public.categories is
  'Tenant-owned single-parent taxonomy. Cycles and cross-tenant ancestry are rejected.';

create index categories_parent_position_idx
  on public.categories (tenant_id, parent_category_id, position, id);

create function catalog_private.prevent_category_cycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  -- Serialize category hierarchy mutations within a single tenant so two concurrent
  -- reparents cannot each pass cycle detection against a stale snapshot and then both
  -- commit a cycle (for example X -> Y and Y -> X). The lock is transaction scoped and
  -- released automatically at COMMIT/ROLLBACK. Acquiring it as its own statement means the
  -- subsequent recursive check runs on a fresh READ COMMITTED snapshot that already
  -- observes any competing hierarchy change committed while we waited. Distinct tenants
  -- hash to distinct keys, so unrelated tenants keep mutating categories in parallel; a
  -- rare hash collision only serializes two tenants and never weakens integrity.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.tenant_id::text, 0));

  if new.parent_category_id is null then
    return new;
  end if;

  if exists (
    with recursive ancestors as (
      select category.id, category.parent_category_id
      from public.categories as category
      where category.tenant_id = new.tenant_id
        and category.id = new.parent_category_id

      union all

      select category.id, category.parent_category_id
      from public.categories as category
      join ancestors on category.id = ancestors.parent_category_id
      where category.tenant_id = new.tenant_id
    )
    select 1 from ancestors where ancestors.id = new.id
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'categories_acyclic',
      message = 'category hierarchy cannot contain a cycle';
  end if;

  return new;
end;
$function$;

create trigger categories_prevent_cycle
before insert or update of tenant_id, parent_category_id on public.categories
for each row execute function catalog_private.prevent_category_cycle();

revoke all on function catalog_private.prevent_category_cycle() from public;

create table public.product_categories (
  tenant_id uuid not null,
  product_id uuid not null,
  category_id uuid not null,
  created_at timestamptz not null default now(),
  constraint product_categories_pk primary key (tenant_id, product_id, category_id),
  constraint product_categories_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint product_categories_product_tenant_fk
    foreign key (tenant_id, product_id) references public.products (tenant_id, id) on delete restrict,
  constraint product_categories_category_tenant_fk
    foreign key (tenant_id, category_id) references public.categories (tenant_id, id) on delete restrict
);

comment on table public.product_categories is
  'Manual many-to-many product taxonomy assignments. Category ancestry is not materialized here.';

create index product_categories_category_lookup_idx
  on public.product_categories (tenant_id, category_id, product_id);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  slug text not null,
  normalized_slug text generated always as (lower(btrim(slug))) stored,
  description text,
  status text not null default 'draft',
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collections_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint collections_name_not_empty check (btrim(name) <> ''),
  constraint collections_slug_not_empty check (normalized_slug <> ''),
  constraint collections_slug_valid check (normalized_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint collections_description_not_empty check (description is null or btrim(description) <> ''),
  constraint collections_status_valid check (status in ('draft', 'active', 'archived')),
  constraint collections_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint collections_updated_after_created check (updated_at >= created_at),
  constraint collections_tenant_id_unique unique (tenant_id, id),
  constraint collections_tenant_slug_unique unique (tenant_id, normalized_slug)
);

comment on table public.collections is
  'Tenant-owned flat merchandising groupings. Rule-driven collections are deferred.';

create index collections_tenant_status_idx on public.collections (tenant_id, status);

create table public.product_collections (
  tenant_id uuid not null,
  product_id uuid not null,
  collection_id uuid not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint product_collections_pk primary key (tenant_id, product_id, collection_id),
  constraint product_collections_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint product_collections_product_tenant_fk
    foreign key (tenant_id, product_id) references public.products (tenant_id, id) on delete restrict,
  constraint product_collections_collection_tenant_fk
    foreign key (tenant_id, collection_id) references public.collections (tenant_id, id) on delete restrict,
  constraint product_collections_position_nonnegative check (position >= 0)
);

comment on table public.product_collections is
  'Ordered manual product membership in flat merchandising collections.';

create index product_collections_collection_position_idx
  on public.product_collections (tenant_id, collection_id, position, product_id);
