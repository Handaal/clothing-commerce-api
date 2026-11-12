-- Phase 1C-A: tenant device enrollment records and register assignment history.
-- Device authentication, enrollment tokens, runtime registration, and revocation enforcement are deferred.

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id text not null,
  normalized_installation_id text generated always as (lower(btrim(installation_id))) stored,
  device_type text not null,
  display_name text not null,
  status text not null default 'enrolled',
  client_version text,
  platform text,
  os_version text,
  activated_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint devices_installation_not_empty check (normalized_installation_id <> ''),
  constraint devices_type_not_empty check (btrim(device_type) <> ''),
  constraint devices_display_name_not_empty check (btrim(display_name) <> ''),
  constraint devices_client_version_not_empty check (
    client_version is null or btrim(client_version) <> ''
  ),
  constraint devices_platform_not_empty check (platform is null or btrim(platform) <> ''),
  constraint devices_os_version_not_empty check (os_version is null or btrim(os_version) <> ''),
  constraint devices_status_valid check (status in ('enrolled', 'active', 'revoked')),
  constraint devices_active_has_activation check (status <> 'active' or activated_at is not null),
  constraint devices_revocation_state_consistent check (
    (status = 'revoked') = (revoked_at is not null)
  ),
  constraint devices_last_seen_after_created check (last_seen_at is null or last_seen_at >= created_at),
  constraint devices_updated_after_created check (updated_at >= created_at),
  constraint devices_tenant_id_unique unique (tenant_id, id),
  constraint devices_installation_id_unique unique (normalized_installation_id)
);

comment on table public.devices is
  'Tenant enrollment identities for physical/software installations; not Registers and not credentials.';

create index devices_tenant_status_idx on public.devices (tenant_id, status);

create table public.register_device_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  register_id uuid not null,
  device_id uuid not null,
  assigned_by_membership_id uuid,
  unassigned_by_membership_id uuid,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz,
  assignment_reason text,
  unassignment_reason text,
  constraint register_device_assignments_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint register_device_assignments_register_tenant_fk
    foreign key (tenant_id, register_id) references public.registers (tenant_id, id) on delete restrict,
  constraint register_device_assignments_device_tenant_fk
    foreign key (tenant_id, device_id) references public.devices (tenant_id, id) on delete restrict,
  constraint register_device_assignments_assigned_by_tenant_fk
    foreign key (tenant_id, assigned_by_membership_id)
    references public.memberships (tenant_id, id)
    on delete restrict,
  constraint register_device_assignments_unassigned_by_tenant_fk
    foreign key (tenant_id, unassigned_by_membership_id)
    references public.memberships (tenant_id, id)
    on delete restrict,
  constraint register_device_assignments_time_order check (
    unassigned_at is null or unassigned_at >= assigned_at
  ),
  constraint register_device_assignments_assignment_reason_not_empty check (
    assignment_reason is null or btrim(assignment_reason) <> ''
  ),
  constraint register_device_assignments_unassignment_reason_not_empty check (
    unassignment_reason is null or btrim(unassignment_reason) <> ''
  ),
  constraint register_device_assignments_unassignment_metadata_consistent check (
    (unassigned_by_membership_id is null and unassignment_reason is null)
    or unassigned_at is not null
  ),
  constraint register_device_assignments_tenant_id_unique unique (tenant_id, id)
);

comment on table public.register_device_assignments is
  'Append-preserved Register/Device assignment intervals; one current assignment per side initially.';

create unique index register_device_assignments_current_register_unique_idx
  on public.register_device_assignments (tenant_id, register_id)
  where unassigned_at is null;

create unique index register_device_assignments_current_device_unique_idx
  on public.register_device_assignments (tenant_id, device_id)
  where unassigned_at is null;

create index register_device_assignments_register_history_idx
  on public.register_device_assignments (tenant_id, register_id, assigned_at desc);

create index register_device_assignments_device_history_idx
  on public.register_device_assignments (tenant_id, device_id, assigned_at desc);
