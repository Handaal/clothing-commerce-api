-- Phase 1C-A: platform identity and tenant-owned authorization persistence.
-- This migration persists relationships only; it implements no permission evaluation or RLS.

create table public.user_identities (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'active',
  display_name text,
  primary_email text,
  suspended_at timestamptz,
  deactivated_at timestamptz,
  deactivation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_identities_display_name_not_empty check (
    display_name is null or btrim(display_name) <> ''
  ),
  constraint user_identities_email_not_empty check (
    primary_email is null or btrim(primary_email) <> ''
  ),
  constraint user_identities_status_valid check (status in ('active', 'suspended', 'deactivated')),
  constraint user_identities_suspension_state_consistent check (
    (status = 'suspended') = (suspended_at is not null)
  ),
  constraint user_identities_deactivation_state_consistent check (
    (status = 'deactivated') = (deactivated_at is not null)
  ),
  constraint user_identities_updated_after_created check (updated_at >= created_at)
);

comment on table public.user_identities is
  'Platform-global, provider-neutral people identities; tenant participation is through memberships.';

create table public.user_identity_provider_bindings (
  id uuid primary key default gen_random_uuid(),
  user_identity_id uuid not null,
  provider text not null,
  provider_subject text not null,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint user_identity_provider_bindings_identity_fk
    foreign key (user_identity_id) references public.user_identities (id) on delete restrict,
  constraint user_identity_provider_bindings_provider_not_empty check (btrim(provider) <> ''),
  constraint user_identity_provider_bindings_subject_not_empty check (btrim(provider_subject) <> ''),
  constraint user_identity_provider_bindings_unlinked_after_linked check (
    unlinked_at is null or unlinked_at >= linked_at
  ),
  constraint user_identity_provider_bindings_provider_subject_unique
    unique (provider, provider_subject)
);

comment on table public.user_identity_provider_bindings is
  'Provider-neutral external subject links; no Clerk-specific workflow or credentials are stored.';

create index user_identity_provider_bindings_identity_idx
  on public.user_identity_provider_bindings (user_identity_id);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_identity_id uuid not null,
  status text not null default 'invited',
  invited_at timestamptz not null default now(),
  activated_at timestamptz,
  suspended_at timestamptz,
  deactivated_at timestamptz,
  deactivation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint memberships_user_identity_fk
    foreign key (user_identity_id) references public.user_identities (id) on delete restrict,
  constraint memberships_status_valid check (
    status in ('invited', 'active', 'suspended', 'deactivated')
  ),
  constraint memberships_active_has_activation check (status <> 'active' or activated_at is not null),
  constraint memberships_suspension_state_consistent check (
    (status = 'suspended') = (suspended_at is not null)
  ),
  constraint memberships_deactivation_state_consistent check (
    (status = 'deactivated') = (deactivated_at is not null)
  ),
  constraint memberships_activation_after_invitation check (
    activated_at is null or activated_at >= invited_at
  ),
  constraint memberships_suspension_after_invitation check (
    suspended_at is null or suspended_at >= invited_at
  ),
  constraint memberships_deactivation_after_invitation check (
    deactivated_at is null or deactivated_at >= invited_at
  ),
  constraint memberships_updated_after_created check (updated_at >= created_at),
  constraint memberships_tenant_id_unique unique (tenant_id, id),
  constraint memberships_tenant_identity_unique unique (tenant_id, user_identity_id)
);

comment on table public.memberships is
  'One preserved logical relationship between a global UserIdentity and a Tenant.';

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  normalized_name text generated always as (lower(btrim(name))) stored,
  description text,
  status text not null default 'active',
  is_protected boolean not null default false,
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint roles_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint roles_name_not_empty check (normalized_name <> ''),
  constraint roles_description_not_empty check (description is null or btrim(description) <> ''),
  constraint roles_status_valid check (status in ('active', 'archived')),
  constraint roles_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint roles_updated_after_created check (updated_at >= created_at),
  constraint roles_tenant_id_unique unique (tenant_id, id),
  constraint roles_tenant_name_unique unique (tenant_id, normalized_name)
);

comment on table public.roles is
  'Tenant-owned permission aggregations. No default or business role catalog is seeded.';

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  description text,
  status text not null default 'active',
  deprecated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint permissions_key_format check (
    key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
  ),
  constraint permissions_description_not_empty check (
    description is null or btrim(description) <> ''
  ),
  constraint permissions_status_valid check (status in ('active', 'deprecated')),
  constraint permissions_deprecation_state_consistent check (
    (status = 'deprecated') = (deprecated_at is not null)
  ),
  constraint permissions_updated_after_created check (updated_at >= created_at),
  constraint permissions_key_unique unique (key)
);

comment on table public.permissions is
  'Platform-global immutable resource.action capability catalog; no speculative permissions are seeded.';

create table public.role_permissions (
  tenant_id uuid not null,
  role_id uuid not null,
  permission_id uuid not null,
  created_at timestamptz not null default now(),
  constraint role_permissions_pk primary key (tenant_id, role_id, permission_id),
  constraint role_permissions_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint role_permissions_role_tenant_fk
    foreign key (tenant_id, role_id) references public.roles (tenant_id, id) on delete restrict,
  constraint role_permissions_permission_fk
    foreign key (permission_id) references public.permissions (id) on delete restrict
);

comment on table public.role_permissions is 'Tenant-safe grants from tenant Roles to global Permissions.';

create index role_permissions_permission_lookup_idx
  on public.role_permissions (tenant_id, permission_id, role_id);

create table public.access_scopes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  normalized_name text generated always as (lower(btrim(name))) stored,
  description text,
  scope_mode text not null,
  status text not null default 'active',
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint access_scopes_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint access_scopes_name_not_empty check (normalized_name <> ''),
  constraint access_scopes_description_not_empty check (
    description is null or btrim(description) <> ''
  ),
  constraint access_scopes_mode_valid check (scope_mode in ('tenant', 'explicit')),
  constraint access_scopes_status_valid check (status in ('active', 'archived')),
  constraint access_scopes_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint access_scopes_updated_after_created check (updated_at >= created_at),
  constraint access_scopes_tenant_id_unique unique (tenant_id, id),
  constraint access_scopes_tenant_id_mode_unique unique (tenant_id, id, scope_mode),
  constraint access_scopes_tenant_name_unique unique (tenant_id, normalized_name)
);

comment on table public.access_scopes is
  'Tenant-wide or explicit allowlist boundaries describing where assigned permissions apply.';

create table public.access_scope_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  access_scope_id uuid not null,
  scope_mode text not null default 'explicit',
  brand_id uuid,
  branch_id uuid,
  warehouse_id uuid,
  inventory_location_id uuid,
  created_at timestamptz not null default now(),
  constraint access_scope_targets_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint access_scope_targets_explicit_scope_fk
    foreign key (tenant_id, access_scope_id, scope_mode)
    references public.access_scopes (tenant_id, id, scope_mode)
    on delete restrict,
  constraint access_scope_targets_brand_tenant_fk
    foreign key (tenant_id, brand_id) references public.brands (tenant_id, id) on delete restrict,
  constraint access_scope_targets_branch_tenant_fk
    foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete restrict,
  constraint access_scope_targets_warehouse_tenant_fk
    foreign key (tenant_id, warehouse_id)
    references public.warehouses (tenant_id, id)
    on delete restrict,
  constraint access_scope_targets_inventory_location_tenant_fk
    foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations (tenant_id, id)
    on delete restrict,
  constraint access_scope_targets_mode_explicit check (scope_mode = 'explicit'),
  constraint access_scope_targets_exactly_one_resource check (
    ((brand_id is not null)::integer +
      (branch_id is not null)::integer +
      (warehouse_id is not null)::integer +
      (inventory_location_id is not null)::integer) = 1
  ),
  constraint access_scope_targets_tenant_id_unique unique (tenant_id, id)
);

comment on table public.access_scope_targets is
  'Explicit, database-enforced Brand/Branch/Warehouse/InventoryLocation targets; tenant scopes have none.';

create unique index access_scope_targets_brand_unique_idx
  on public.access_scope_targets (tenant_id, access_scope_id, brand_id)
  where brand_id is not null;

create unique index access_scope_targets_branch_unique_idx
  on public.access_scope_targets (tenant_id, access_scope_id, branch_id)
  where branch_id is not null;

create unique index access_scope_targets_warehouse_unique_idx
  on public.access_scope_targets (tenant_id, access_scope_id, warehouse_id)
  where warehouse_id is not null;

create unique index access_scope_targets_inventory_location_unique_idx
  on public.access_scope_targets (tenant_id, access_scope_id, inventory_location_id)
  where inventory_location_id is not null;

create index access_scope_targets_brand_lookup_idx
  on public.access_scope_targets (tenant_id, brand_id, access_scope_id)
  where brand_id is not null;

create index access_scope_targets_branch_lookup_idx
  on public.access_scope_targets (tenant_id, branch_id, access_scope_id)
  where branch_id is not null;

create index access_scope_targets_warehouse_lookup_idx
  on public.access_scope_targets (tenant_id, warehouse_id, access_scope_id)
  where warehouse_id is not null;

create index access_scope_targets_inventory_location_lookup_idx
  on public.access_scope_targets (tenant_id, inventory_location_id, access_scope_id)
  where inventory_location_id is not null;

create table public.membership_role_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  membership_id uuid not null,
  role_id uuid not null,
  access_scope_id uuid not null,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz,
  assignment_reason text,
  unassignment_reason text,
  constraint membership_role_assignments_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint membership_role_assignments_membership_tenant_fk
    foreign key (tenant_id, membership_id)
    references public.memberships (tenant_id, id)
    on delete restrict,
  constraint membership_role_assignments_role_tenant_fk
    foreign key (tenant_id, role_id) references public.roles (tenant_id, id) on delete restrict,
  constraint membership_role_assignments_scope_tenant_fk
    foreign key (tenant_id, access_scope_id)
    references public.access_scopes (tenant_id, id)
    on delete restrict,
  constraint membership_role_assignments_time_order check (
    unassigned_at is null or unassigned_at >= assigned_at
  ),
  constraint membership_role_assignments_reason_not_empty check (
    assignment_reason is null or btrim(assignment_reason) <> ''
  ),
  constraint membership_role_unassignment_reason_not_empty check (
    unassignment_reason is null or btrim(unassignment_reason) <> ''
  ),
  constraint membership_role_unassignment_metadata_consistent check (
    unassignment_reason is null or unassigned_at is not null
  ),
  constraint membership_role_assignments_tenant_id_unique unique (tenant_id, id)
);

comment on table public.membership_role_assignments is
  'History-preserving assignment of a tenant Membership to a tenant Role and AccessScope.';

create unique index membership_role_assignments_current_unique_idx
  on public.membership_role_assignments (tenant_id, membership_id, role_id, access_scope_id)
  where unassigned_at is null;

create index membership_role_assignments_membership_history_idx
  on public.membership_role_assignments (tenant_id, membership_id, assigned_at desc);

create index membership_role_assignments_role_current_idx
  on public.membership_role_assignments (tenant_id, role_id, membership_id)
  where unassigned_at is null;

create index membership_role_assignments_scope_current_idx
  on public.membership_role_assignments (tenant_id, access_scope_id, membership_id)
  where unassigned_at is null;
