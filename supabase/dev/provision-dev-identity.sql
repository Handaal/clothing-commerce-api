-- Development-only identity provisioning for Phase 2F-B Admin Mobile real-runtime acceptance.
--
-- This script is NOT a migration and NOT a production seed. It is applied ONLY by
-- scripts/provision-dev-identity.mjs against the LOCAL disposable Supabase Postgres container. It binds
-- a REAL, externally-created Clerk development subject to the Commerce authorization model so that a
-- genuine Clerk login can exercise GET /api/v1/me/tenants and GET /api/v1/me/context.
--
-- It NEVER auto-provisions during an API request, NEVER creates a platform/super-admin identity, and
-- introduces NO owner/manager bypass. `service_role`/superuser access is used strictly as DB transport;
-- authorization is still the tenant Role -> RolePermission -> Scope -> MembershipRoleAssignment graph the
-- API already evaluates.
--
-- Phase 2G: the development role now also grants the three sanctioned inventory-management WRITE
-- permissions (inventory.receive, inventory.adjust, inventory.transfer) so a real Clerk login can
-- exercise the Phase 2G write endpoints locally. It still grants NO opening-stock or generic-issue
-- permission, NO catalog/order/fulfillment write, and NO wildcard/admin permission. The role remains an
-- EXACT set (fail-closed): the script asserts the grant count and never widens beyond the declared keys.
-- Connected POS V1 adds a separate, non-protected `Dev POS Cashier` role with exactly catalog.read,
-- inventory.read/issue, orders.read/create/fulfill, and payments.capture. The existing management role
-- is not widened; both assignments use the deterministic tenant-wide development scope.
--
-- The Clerk subject is supplied by the caller through the psql variable :clerk_subject. It is copied once
-- into a transaction-local GUC via psql's safe quoting (:'clerk_subject') and read inside the DO block
-- with current_setting(); it is never concatenated into SQL text.

\set ON_ERROR_STOP on

begin;

-- Safe, single, psql-quoted transfer of the caller-supplied subject into a transaction-local setting.
-- SET LOCAL (not `select set_config(...)`) is used deliberately: it emits no result row, so the sensitive
-- subject never appears in psql output.
set local dev_provisioning.clerk_subject = :'clerk_subject';

create temporary table dev_provision_result (
  sort_key integer primary key,
  entity text not null,
  id uuid not null,
  created boolean not null
) on commit preserve rows;

do $$
declare
  v_subject text;
  v_status text;
  v_scope_mode text;
  v_unlinked_at timestamptz;
  v_perm_count integer;
  v_role_perm_count integer;
  v_pos_perm_count integer;
  v_pos_role_perm_count integer;
  v_other_assignments integer;
  v_tenant_id uuid;
  v_tenant_created boolean := false;
  v_identity_id uuid;
  v_identity_created boolean := false;
  v_binding_id uuid;
  v_binding_created boolean := false;
  v_membership_id uuid;
  v_membership_created boolean := false;
  v_role_id uuid;
  v_role_created boolean := false;
  v_scope_id uuid;
  v_scope_created boolean := false;
  v_assignment_id uuid;
  v_assignment_created boolean := false;
  v_pos_role_id uuid;
  v_pos_role_created boolean := false;
  v_pos_assignment_id uuid;
  v_pos_assignment_created boolean := false;
begin
  v_subject := btrim(current_setting('dev_provisioning.clerk_subject', true));
  if v_subject is null or v_subject = '' then
    raise exception 'DEV_PROVISIONING: a non-empty Clerk subject is required.';
  end if;

  -- 0. Require the canonical migration-seeded permissions this role grants BEFORE any write. A missing key
  --    means the local database is behind on migrations; this script must not repair migration drift.
  select count(*) into v_perm_count
  from public.permissions
  where key in (
      'catalog.read', 'inventory.read', 'orders.read',
      'inventory.receive', 'inventory.adjust', 'inventory.transfer',
      'attendance.read', 'attendance.manage'
    )
    and status = 'active';
  if v_perm_count <> 8 then
    raise exception
      'DEV_PROVISIONING: expected 8 active canonical permissions (catalog.read, inventory.read, orders.read, inventory.receive, inventory.adjust, inventory.transfer, attendance.read, attendance.manage) but found %. Run `pnpm supabase:reset` to apply migrations.',
      v_perm_count;
  end if;

  -- 1. Development tenant, reached by its stable slug. Reuse if already active; fail on any other status.
  select id, status into v_tenant_id, v_status
  from public.tenants
  where normalized_slug = 'dev-local';
  if found then
    if v_status <> 'active' then
      raise exception 'DEV_PROVISIONING: tenant dev-local exists with status=% (expected active).', v_status;
    end if;
  else
    insert into public.tenants (slug, display_name, status, onboarding_state, default_currency)
    values ('dev-local', 'Dev Local', 'active', 'completed', 'USD')
    returning id into v_tenant_id;
    v_tenant_created := true;
  end if;

  -- 2. Clerk provider binding -> UserIdentity. The (provider, provider_subject) unique constraint means
  --    there is at most one row. Reuse a live binding to its active identity; FAIL LOUDLY on a conflict.
  select id, user_identity_id, unlinked_at
  into v_binding_id, v_identity_id, v_unlinked_at
  from public.user_identity_provider_bindings
  where provider = 'clerk'
    and provider_subject = v_subject;
  if found then
    if v_unlinked_at is not null then
      raise exception
        'DEV_PROVISIONING: this Clerk subject is already bound but the binding is unlinked; refusing to silently rebind.';
    end if;
    select status into v_status from public.user_identities where id = v_identity_id;
    if not found then
      raise exception 'DEV_PROVISIONING: authorization state invalid: the binding references a missing UserIdentity.';
    end if;
    if v_status <> 'active' then
      raise exception 'DEV_PROVISIONING: the UserIdentity already bound to this subject is % (expected active).', v_status;
    end if;
  else
    insert into public.user_identities (status) values ('active') returning id into v_identity_id;
    v_identity_created := true;
    insert into public.user_identity_provider_bindings (user_identity_id, provider, provider_subject)
    values (v_identity_id, 'clerk', v_subject)
    returning id into v_binding_id;
    v_binding_created := true;
  end if;

  -- 3. Active Membership for (tenant, identity). Reuse only if already active; refuse to silently
  --    reactivate a suspended/deactivated membership (that would widen access non-deterministically).
  select id, status into v_membership_id, v_status
  from public.memberships
  where tenant_id = v_tenant_id
    and user_identity_id = v_identity_id;
  if found then
    if v_status <> 'active' then
      raise exception 'DEV_PROVISIONING: existing membership is % (expected active); refusing to silently reactivate.', v_status;
    end if;
  else
    insert into public.memberships (tenant_id, user_identity_id, status, activated_at)
    values (v_tenant_id, v_identity_id, 'active', now())
    returning id into v_membership_id;
    v_membership_created := true;
  end if;

  -- 4. Development role, reached by its tenant-unique normalized name.
  select id, status into v_role_id, v_status
  from public.roles
  where tenant_id = v_tenant_id
    and normalized_name = 'dev management reader';
  if found then
    if v_status <> 'active' then
      raise exception 'DEV_PROVISIONING: role "Dev Management Reader" exists with status=% (expected active).', v_status;
    end if;
  else
    insert into public.roles (tenant_id, name, status, is_protected)
    values (v_tenant_id, 'Dev Management Reader', 'active', false)
    returning id into v_role_id;
    v_role_created := true;
  end if;

  -- 5. Grant EXACTLY the eight management permissions (three reads + three inventory writes + attendance
  --    read + attendance manage). The idempotent insert reconciles an older state up to the full set; the
  --    count assertion then keeps the role an EXACT set. If it carries anything beyond these eight, fail
  --    rather than silently narrow/widen. A re-run inserts nothing and re-asserts.
  insert into public.role_permissions (tenant_id, role_id, permission_id)
  select v_tenant_id, v_role_id, p.id
  from public.permissions p
  where p.key in (
    'catalog.read', 'inventory.read', 'orders.read',
    'inventory.receive', 'inventory.adjust', 'inventory.transfer',
    'attendance.read', 'attendance.manage'
  )
  on conflict (tenant_id, role_id, permission_id) do nothing;

  select count(*) into v_role_perm_count
  from public.role_permissions
  where tenant_id = v_tenant_id
    and role_id = v_role_id;
  if v_role_perm_count <> 8 then
    raise exception
      'DEV_PROVISIONING: role "Dev Management Reader" must grant exactly the 8 management permissions but carries % grants; refusing to alter an unexpected grant set.',
      v_role_perm_count;
  end if;

  -- Connected POS V1 uses a separate cashier role; the management role above remains unchanged.
  select count(*) into v_pos_perm_count from public.permissions
  where key in (
    'catalog.read', 'inventory.read', 'orders.read', 'orders.create', 'orders.fulfill',
    'inventory.issue', 'payments.capture', 'attendance.record'
  ) and status = 'active';
  if v_pos_perm_count <> 8 then
    raise exception
      'DEV_PROVISIONING: expected 8 active POS cashier permissions but found %. Run `pnpm supabase:reset`.',
      v_pos_perm_count;
  end if;

  select id, status into v_pos_role_id, v_status from public.roles
  where tenant_id = v_tenant_id and normalized_name = 'dev pos cashier';
  if found then
    if v_status <> 'active' then
      raise exception 'DEV_PROVISIONING: role "Dev POS Cashier" is not active.';
    end if;
  else
    insert into public.roles (tenant_id, name, status, is_protected)
    values (v_tenant_id, 'Dev POS Cashier', 'active', false)
    returning id into v_pos_role_id;
    v_pos_role_created := true;
  end if;

  insert into public.role_permissions (tenant_id, role_id, permission_id)
  select v_tenant_id, v_pos_role_id, p.id from public.permissions p
  where p.key in (
    'catalog.read', 'inventory.read', 'orders.read', 'orders.create', 'orders.fulfill',
    'inventory.issue', 'payments.capture', 'attendance.record'
  ) on conflict (tenant_id, role_id, permission_id) do nothing;

  select count(*) into v_pos_role_perm_count from public.role_permissions
  where tenant_id = v_tenant_id and role_id = v_pos_role_id;
  if v_pos_role_perm_count <> 8 then
    raise exception
      'DEV_PROVISIONING: role "Dev POS Cashier" must grant exactly 8 permissions but carries %.',
      v_pos_role_perm_count;
  end if;

  -- 6. Tenant-wide AccessScope so all three read domains are exercisable. Tenant scopes carry no targets.
  select id, status, scope_mode into v_scope_id, v_status, v_scope_mode
  from public.access_scopes
  where tenant_id = v_tenant_id
    and normalized_name = 'dev tenant wide';
  if found then
    if v_status <> 'active' or v_scope_mode <> 'tenant' then
      raise exception 'DEV_PROVISIONING: scope "Dev Tenant Wide" exists with status=%, mode=% (expected active/tenant).', v_status, v_scope_mode;
    end if;
  else
    insert into public.access_scopes (tenant_id, name, scope_mode, status)
    values (v_tenant_id, 'Dev Tenant Wide', 'tenant', 'active')
    returning id into v_scope_id;
    v_scope_created := true;
  end if;

  -- 7. Current MembershipRoleAssignment (unassigned_at is null = live), reached by the partial-unique key.
  select id into v_assignment_id
  from public.membership_role_assignments
  where tenant_id = v_tenant_id
    and membership_id = v_membership_id
    and role_id = v_role_id
    and access_scope_id = v_scope_id
    and unassigned_at is null;
  if not found then
    insert into public.membership_role_assignments (tenant_id, membership_id, role_id, access_scope_id, assigned_at)
    values (v_tenant_id, v_membership_id, v_role_id, v_scope_id, now())
    returning id into v_assignment_id;
    v_assignment_created := true;
  end if;

  select id into v_pos_assignment_id from public.membership_role_assignments
  where tenant_id = v_tenant_id and membership_id = v_membership_id
    and role_id = v_pos_role_id and access_scope_id = v_scope_id and unassigned_at is null;
  if not found then
    insert into public.membership_role_assignments
      (tenant_id, membership_id, role_id, access_scope_id, assigned_at)
    values (v_tenant_id, v_membership_id, v_pos_role_id, v_scope_id, now())
    returning id into v_pos_assignment_id;
    v_pos_assignment_created := true;
  end if;

  -- 8. Effective-permission exactness: the membership's EFFECTIVE permissions come from ALL its live
  --    assignments, not just this role. Refuse to reuse a membership that already carries any other live
  --    assignment (which could grant extra or mutation permissions) rather than silently inheriting it.
  select count(*) into v_other_assignments
  from public.membership_role_assignments
  where tenant_id = v_tenant_id
    and membership_id = v_membership_id
    and unassigned_at is null
    and not (
      (role_id = v_role_id and access_scope_id = v_scope_id)
      or (role_id = v_pos_role_id and access_scope_id = v_scope_id)
    );
  if v_other_assignments > 0 then
    raise exception
      'DEV_PROVISIONING: membership already has % other live role assignment(s); refusing to reuse a membership with unexpected access.',
      v_other_assignments;
  end if;

  insert into dev_provision_result (sort_key, entity, id, created)
  values
    (1, 'tenant', v_tenant_id, v_tenant_created),
    (2, 'user_identity', v_identity_id, v_identity_created),
    (3, 'provider_binding', v_binding_id, v_binding_created),
    (4, 'membership', v_membership_id, v_membership_created),
    (5, 'role', v_role_id, v_role_created),
    (6, 'access_scope', v_scope_id, v_scope_created),
    (7, 'assignment', v_assignment_id, v_assignment_created),
    (8, 'pos_cashier_role', v_pos_role_id, v_pos_role_created),
    (9, 'pos_cashier_assignment', v_pos_assignment_id, v_pos_assignment_created);
end
$$;

commit;

-- Concise, subject-free summary.
\pset border 2
\pset title 'Development identity (created vs reused)'
select
  entity as "Entity",
  id as "Id",
  case when created then 'created' else 'reused' end as "State"
from dev_provision_result
order by sort_key;

\pset title 'Granted permissions'
select string_agg(p.key, ', ' order by p.key) as "Permissions"
from public.role_permissions rp
join public.permissions p on p.id = rp.permission_id
join dev_provision_result r on r.entity = 'role' and r.id = rp.role_id;
