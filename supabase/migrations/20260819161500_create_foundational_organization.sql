-- Phase 1C-A: foundational tenant and organizational persistence.
-- Migrations are authoritative. RLS is intentionally deferred to Phase 1C-B.

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  normalized_slug text generated always as (lower(btrim(slug))) stored,
  display_name text not null,
  legal_name text,
  status text not null default 'provisioning',
  onboarding_state text not null default 'not_started',
  default_locale text not null default 'en',
  default_timezone text not null default 'UTC',
  default_currency text not null,
  country_code text,
  contact_email text,
  contact_phone text,
  suspended_at timestamptz,
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenants_normalized_slug_not_empty check (normalized_slug <> ''),
  constraint tenants_display_name_not_empty check (btrim(display_name) <> ''),
  constraint tenants_legal_name_not_empty check (legal_name is null or btrim(legal_name) <> ''),
  constraint tenants_status_valid check (status in ('provisioning', 'active', 'suspended', 'archived')),
  constraint tenants_onboarding_state_valid check (
    onboarding_state in ('not_started', 'in_progress', 'completed')
  ),
  constraint tenants_locale_not_empty check (btrim(default_locale) <> ''),
  constraint tenants_timezone_not_empty check (btrim(default_timezone) <> ''),
  constraint tenants_currency_valid check (default_currency ~ '^[A-Z]{3}$'),
  constraint tenants_country_valid check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint tenants_suspension_state_consistent check (
    (status = 'suspended') = (suspended_at is not null)
  ),
  constraint tenants_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint tenants_updated_after_created check (updated_at >= created_at),
  constraint tenants_normalized_slug_unique unique (normalized_slug)
);

comment on table public.tenants is
  'SaaS customer and tenant-isolation ownership root. RLS is added in Phase 1C-B.';

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,
  normalized_code text generated always as (lower(btrim(code))) stored,
  display_name text not null,
  legal_name text,
  status text not null default 'active',
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brands_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint brands_code_not_empty check (normalized_code <> ''),
  constraint brands_display_name_not_empty check (btrim(display_name) <> ''),
  constraint brands_legal_name_not_empty check (legal_name is null or btrim(legal_name) <> ''),
  constraint brands_status_valid check (status in ('active', 'inactive', 'archived')),
  constraint brands_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint brands_updated_after_created check (updated_at >= created_at),
  constraint brands_tenant_id_unique unique (tenant_id, id),
  constraint brands_tenant_code_unique unique (tenant_id, normalized_code)
);

comment on table public.brands is 'Tenant-owned trading and merchandising identities.';

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,
  normalized_code text generated always as (lower(btrim(code))) stored,
  display_name text not null,
  timezone text not null,
  status text not null default 'active',
  address_line_1 text,
  address_line_2 text,
  city text,
  region text,
  postal_code text,
  country_code text,
  contact_email text,
  contact_phone text,
  is_fulfillment_enabled boolean not null default false,
  is_click_and_collect_enabled boolean not null default false,
  default_inventory_location_id uuid,
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint branches_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint branches_code_not_empty check (normalized_code <> ''),
  constraint branches_display_name_not_empty check (btrim(display_name) <> ''),
  constraint branches_timezone_not_empty check (btrim(timezone) <> ''),
  constraint branches_country_valid check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint branches_status_valid check (status in ('active', 'inactive', 'archived')),
  constraint branches_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint branches_updated_after_created check (updated_at >= created_at),
  constraint branches_tenant_id_unique unique (tenant_id, id),
  constraint branches_tenant_code_unique unique (tenant_id, normalized_code)
);

comment on table public.branches is 'Tenant-owned retail or business locations; never warehouses.';

create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,
  normalized_code text generated always as (lower(btrim(code))) stored,
  display_name text not null,
  timezone text not null,
  status text not null default 'active',
  address_line_1 text,
  address_line_2 text,
  city text,
  region text,
  postal_code text,
  country_code text,
  contact_email text,
  contact_phone text,
  is_fulfillment_enabled boolean not null default false,
  is_receiving_enabled boolean not null default false,
  is_transfer_origin_enabled boolean not null default false,
  is_transfer_destination_enabled boolean not null default false,
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warehouses_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint warehouses_code_not_empty check (normalized_code <> ''),
  constraint warehouses_display_name_not_empty check (btrim(display_name) <> ''),
  constraint warehouses_timezone_not_empty check (btrim(timezone) <> ''),
  constraint warehouses_country_valid check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint warehouses_status_valid check (status in ('active', 'inactive', 'archived')),
  constraint warehouses_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint warehouses_updated_after_created check (updated_at >= created_at),
  constraint warehouses_tenant_id_unique unique (tenant_id, id),
  constraint warehouses_tenant_code_unique unique (tenant_id, normalized_code)
);

comment on table public.warehouses is 'Tenant-owned stock-holding and logistics facilities.';

create table public.branch_brands (
  tenant_id uuid not null,
  branch_id uuid not null,
  brand_id uuid not null,
  created_at timestamptz not null default now(),
  constraint branch_brands_pk primary key (tenant_id, branch_id, brand_id),
  constraint branch_brands_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint branch_brands_branch_tenant_fk
    foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete restrict,
  constraint branch_brands_brand_tenant_fk
    foreign key (tenant_id, brand_id) references public.brands (tenant_id, id) on delete restrict
);

comment on table public.branch_brands is
  'Tenant-safe branch-to-brand operating eligibility; it never owns inventory.';

create index branch_brands_brand_lookup_idx
  on public.branch_brands (tenant_id, brand_id, branch_id);

create table public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid,
  warehouse_id uuid,
  code text not null,
  normalized_code text generated always as (lower(btrim(code))) stored,
  display_name text not null,
  location_type text not null,
  status text not null default 'active',
  is_sellable boolean not null default false,
  is_fulfillment_enabled boolean not null default false,
  is_receiving_enabled boolean not null default false,
  is_transfer_origin_enabled boolean not null default false,
  is_transfer_destination_enabled boolean not null default false,
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_locations_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint inventory_locations_branch_tenant_fk
    foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete restrict,
  constraint inventory_locations_warehouse_tenant_fk
    foreign key (tenant_id, warehouse_id)
    references public.warehouses (tenant_id, id)
    on delete restrict,
  constraint inventory_locations_exactly_one_parent check (
    (branch_id is not null) <> (warehouse_id is not null)
  ),
  constraint inventory_locations_code_not_empty check (normalized_code <> ''),
  constraint inventory_locations_display_name_not_empty check (btrim(display_name) <> ''),
  constraint inventory_locations_type_not_empty check (btrim(location_type) <> ''),
  constraint inventory_locations_status_valid check (status in ('active', 'inactive', 'archived')),
  constraint inventory_locations_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint inventory_locations_updated_after_created check (updated_at >= created_at),
  constraint inventory_locations_tenant_id_unique unique (tenant_id, id),
  constraint inventory_locations_tenant_branch_id_unique unique (tenant_id, branch_id, id),
  constraint inventory_locations_tenant_warehouse_id_unique unique (tenant_id, warehouse_id, id),
  constraint inventory_locations_tenant_code_unique unique (tenant_id, normalized_code)
);

comment on table public.inventory_locations is
  'Flat physical stock-holding locations. Quantities and movement ledgers are out of scope.';

create index inventory_locations_branch_status_idx
  on public.inventory_locations (tenant_id, branch_id, status)
  where branch_id is not null;

create index inventory_locations_warehouse_status_idx
  on public.inventory_locations (tenant_id, warehouse_id, status)
  where warehouse_id is not null;

alter table public.branches
  add constraint branches_default_location_same_branch_fk
  foreign key (tenant_id, id, default_inventory_location_id)
  references public.inventory_locations (tenant_id, branch_id, id)
  on delete restrict;

create table public.registers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid not null,
  code text not null,
  normalized_code text generated always as (lower(btrim(code))) stored,
  display_name text not null,
  status text not null default 'inactive',
  default_inventory_location_id uuid,
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint registers_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint registers_branch_tenant_fk
    foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete restrict,
  constraint registers_default_location_same_branch_fk
    foreign key (tenant_id, branch_id, default_inventory_location_id)
    references public.inventory_locations (tenant_id, branch_id, id)
    on delete restrict,
  constraint registers_code_not_empty check (normalized_code <> ''),
  constraint registers_display_name_not_empty check (btrim(display_name) <> ''),
  constraint registers_status_valid check (status in ('active', 'inactive', 'archived')),
  constraint registers_active_location_required check (
    status <> 'active' or default_inventory_location_id is not null
  ),
  constraint registers_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint registers_updated_after_created check (updated_at >= created_at),
  constraint registers_tenant_id_unique unique (tenant_id, id),
  constraint registers_branch_code_unique unique (tenant_id, branch_id, normalized_code)
);

comment on table public.registers is
  'Tenant-owned checkout contexts. Multiple registers may share one branch inventory location.';

create index registers_branch_status_idx on public.registers (tenant_id, branch_id, status);
