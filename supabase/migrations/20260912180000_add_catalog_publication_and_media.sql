-- Phase 2J (1/4): Storefront publication boundary, product media references, and the catalog write
-- idempotency substrate. Schema-only; the sanctioned write paths and grants follow in 2/4 and 3/4.
--
-- Publication is a CHANNEL-SPECIFIC boundary that is deliberately NOT the same concept as the internal
-- products.status (draft/active/archived). Phase 2A defined status='active' as "internally eligible for
-- catalog workflows" (POS sellability, inventory) and explicitly NOT "published online". A product may
-- therefore be sold in-store without being online. Publishing is gated (in the 2/4 RPC) on an active
-- product that owns at least one active, priced, active variant, so a structurally unsellable product
-- can never be published.

alter table public.products
  add column storefront_status text not null default 'unpublished',
  add column storefront_published_at timestamptz;

alter table public.products
  add constraint products_storefront_status_valid
    check (storefront_status in ('unpublished', 'published')),
  add constraint products_storefront_publish_state_consistent
    check ((storefront_status = 'published') = (storefront_published_at is not null));

comment on column public.products.storefront_status is
  'Channel-specific Storefront publication state. Independent of the internal status lifecycle; published requires an internally active, priced, sellable product.';

create index products_tenant_storefront_status_idx
  on public.products (tenant_id, storefront_status);

-- Product media stores OBJECT-STORAGE REFERENCES, never binaries. Binaries live in Supabase Storage;
-- the API mints a signed upload URL for an authored path and the client records the reference here.
create table public.product_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  product_id uuid not null,
  variant_id uuid,
  storage_bucket text not null,
  storage_path text not null,
  normalized_storage_path text generated always as (lower(btrim(storage_path))) stored,
  alt_text text,
  position integer not null default 0,
  is_primary boolean not null default false,
  status text not null default 'active',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_media_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint product_media_product_tenant_fk
    foreign key (tenant_id, product_id) references public.products (tenant_id, id) on delete restrict,
  -- A variant-specific image must belong to the SAME product, enforced structurally (tenant-safe).
  constraint product_media_variant_product_tenant_fk
    foreign key (tenant_id, product_id, variant_id)
    references public.product_variants (tenant_id, product_id, id) on delete restrict,
  constraint product_media_bucket_not_empty check (btrim(storage_bucket) <> ''),
  constraint product_media_path_not_empty check (normalized_storage_path <> ''),
  constraint product_media_alt_text_not_empty check (alt_text is null or btrim(alt_text) <> ''),
  constraint product_media_position_nonnegative check (position >= 0),
  constraint product_media_status_valid check (status in ('active', 'archived')),
  constraint product_media_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint product_media_primary_must_be_active check (not is_primary or status = 'active'),
  constraint product_media_updated_after_created check (updated_at >= created_at),
  constraint product_media_tenant_id_unique unique (tenant_id, id),
  constraint product_media_tenant_path_unique unique (tenant_id, storage_bucket, normalized_storage_path)
);

comment on table public.product_media is
  'Tenant-owned product/variant image references into object storage. No binaries are stored in PostgreSQL.';

create unique index product_media_one_active_primary_idx
  on public.product_media (tenant_id, product_id)
  where is_primary and status = 'active';

create index product_media_product_order_idx
  on public.product_media (tenant_id, product_id, position, id);

-- Catalog write idempotency substrate. Every sanctioned catalog write records (tenant, key) with the
-- caller payload fingerprint and its result envelope, so a retried create/update/price/publish/media
-- command replays the original result instead of duplicating. Same key + different payload is a
-- deterministic conflict (mapped to ID409 by the write functions).
create table catalog_private.catalog_write_operations (
  tenant_id uuid not null,
  idempotency_key text not null,
  normalized_idempotency_key text generated always as (lower(btrim(idempotency_key))) stored,
  operation text not null,
  payload_fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint catalog_write_operations_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint catalog_write_operations_key_not_empty check (normalized_idempotency_key <> ''),
  constraint catalog_write_operations_operation_not_empty check (btrim(operation) <> ''),
  constraint catalog_write_operations_pk primary key (tenant_id, normalized_idempotency_key)
);

comment on table catalog_private.catalog_write_operations is
  'Idempotency ledger for sanctioned catalog writes. Private; never a client API surface.';

-- RLS + grants for product_media follow the Phase 2A catalog pattern exactly: deny-by-default,
-- authenticated tenant read, service_role SELECT (writes go through the sanctioned functions in 2/4).
alter table public.product_media enable row level security;

create policy authenticated_tenant_read on public.product_media
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

do $block$
begin
  execute 'revoke all privileges on table public.product_media from public';

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all privileges on table public.product_media from anon';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all privileges on table public.product_media from authenticated';
    execute 'grant select on table public.product_media to authenticated';
  end if;

  -- Catalog was provisioned in Phase 2A with service_role holding direct DML on catalog tables
  -- (catalog writes are "server-side application responsibilities"). product_media follows that same
  -- boundary; the sanctioned SECURITY INVOKER write functions (2/4) run as the calling service_role.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.product_media to service_role';
    execute 'grant select, insert, update, delete on table catalog_private.catalog_write_operations to service_role';
  end if;
end;
$block$;
