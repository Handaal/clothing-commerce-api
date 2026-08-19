-- Phase 1C-B: deny-by-default RLS for all foundational persistence.
-- RLS enforces Tenant isolation and active Membership only. Permission and AccessScope
-- authorization remain Phase 1D application responsibilities.

alter table public.tenants enable row level security;
alter table public.brands enable row level security;
alter table public.branches enable row level security;
alter table public.warehouses enable row level security;
alter table public.branch_brands enable row level security;
alter table public.inventory_locations enable row level security;
alter table public.registers enable row level security;
alter table public.user_identities enable row level security;
alter table public.user_identity_provider_bindings enable row level security;
alter table public.memberships enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.access_scopes enable row level security;
alter table public.access_scope_targets enable row level security;
alter table public.membership_role_assignments enable row level security;
alter table public.devices enable row level security;
alter table public.register_device_assignments enable row level security;

create policy authenticated_tenant_read
on public.tenants
for select
to authenticated
using (
  id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.brands
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.branches
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.warehouses
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.branch_brands
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.inventory_locations
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.registers
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_self_read
on public.user_identities
for select
to authenticated
using (
  id = (select commerce_context.current_user_identity_id())
  and (select commerce_context.has_active_membership())
);

-- Provider bindings intentionally have no authenticated policy.

create policy authenticated_self_active_read
on public.memberships
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and user_identity_id = (select commerce_context.current_user_identity_id())
  and status = 'active'
);

create policy authenticated_tenant_read
on public.roles
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_catalog_read
on public.permissions
for select
to authenticated
using (
  (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.role_permissions
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.access_scopes
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.access_scope_targets
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_self_assignment_read
on public.membership_role_assignments
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and membership_id = (select commerce_context.current_membership_id())
);

create policy authenticated_tenant_read
on public.devices
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read
on public.register_device_assignments
for select
to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

-- Supabase supplies these roles; the plain PostgreSQL runner creates non-login fixtures with the
-- same names so explicit policy targets and grants remain testable outside the Supabase image.
do $block$
declare
  table_name text;
  foundational_tables constant text[] := array[
    'tenants',
    'brands',
    'branches',
    'warehouses',
    'branch_brands',
    'inventory_locations',
    'registers',
    'user_identities',
    'user_identity_provider_bindings',
    'memberships',
    'roles',
    'permissions',
    'role_permissions',
    'access_scopes',
    'access_scope_targets',
    'membership_role_assignments',
    'devices',
    'register_device_assignments'
  ];
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    foreach table_name in array foundational_tables loop
      execute pg_catalog.format('revoke all privileges on table public.%I from anon', table_name);
    end loop;
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    foreach table_name in array foundational_tables loop
      execute pg_catalog.format(
        'revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated',
        table_name
      );

      if table_name = 'user_identity_provider_bindings' then
        execute pg_catalog.format(
          'revoke select on table public.%I from authenticated',
          table_name
        );
      else
        execute pg_catalog.format(
          'grant select on table public.%I to authenticated',
          table_name
        );
      end if;
    end loop;
  end if;

  -- Supabase's server-only service role is the explicit operational bypass path.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    foreach table_name in array foundational_tables loop
      execute pg_catalog.format(
        'grant select, insert, update, delete on table public.%I to service_role',
        table_name
      );
    end loop;
  end if;
end;
$block$;

comment on schema commerce_context is
  'Private, identity-provider-neutral request context used by foundational tenant RLS policies.';
