\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(condition boolean, label text)
returns void
language plpgsql
as $function$
begin
  if condition is distinct from true then
    raise exception 'assertion failed: %', label;
  end if;
end;
$function$;

create or replace function pg_temp.assert_raises(statement text, expected_state text, label text)
returns void
language plpgsql
as $function$
declare
  actual_state text;
begin
  begin
    execute statement;
  exception
    when others then
      get stacked diagnostics actual_state = returned_sqlstate;
      if actual_state = expected_state then
        return;
      end if;

      raise exception 'assertion failed: %, expected SQLSTATE %, received %',
        label,
        expected_state,
        actual_state;
  end;

  raise exception 'assertion failed: %, expected SQLSTATE %, but statement succeeded',
    label,
    expected_state;
end;
$function$;

select pg_temp.assert_true(
  (
    select count(*) = 18
    from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename = any (
        array[
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
        ]
      )
  ),
  'all 18 foundational tables exist'
);

select pg_temp.assert_true(
  (
    select count(*) = 18
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relrowsecurity
  )
  and (
    select count(*) = 17
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and cmd = 'SELECT'
  )
  and not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and cmd <> 'SELECT'
  )
  and not exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relforcerowsecurity
  ),
  'all foundational tables use RLS and only approved SELECT policies exist'
);

select pg_temp.assert_true(
  to_regclass('public.products') is null
  and to_regclass('public.variants') is null
  and to_regclass('public.inventory_balances') is null
  and to_regclass('public.inventory_movements') is null
  and to_regclass('public.orders') is null
  and to_regclass('public.payments') is null
  and to_regclass('public.customers') is null,
  'business-domain tables are absent'
);

insert into public.tenants (
  id,
  slug,
  display_name,
  status,
  onboarding_state,
  default_currency,
  country_code
)
values
  ('10000000-0000-4000-8000-000000000001', 'tenant-one', 'Tenant One', 'active', 'completed', 'USD', 'US'),
  ('10000000-0000-4000-8000-000000000002', 'tenant-two', 'Tenant Two', 'active', 'completed', 'EUR', 'DE');

select pg_temp.assert_raises(
  $test$
    insert into public.tenants (slug, display_name, default_currency)
    values (' TENANT-ONE ', 'Duplicate Tenant', 'USD')
  $test$,
  '23505',
  'duplicate normalized tenant slug is rejected'
);

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRAND', 'Brand One'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'BRAND', 'Brand Two');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'MAIN', 'Main Branch', 'America/New_York'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'MAIN', 'Main Branch', 'Europe/Berlin'),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'OUTLET', 'Outlet Branch', 'America/New_York');

select pg_temp.assert_raises(
  $test$
    insert into public.branches (tenant_id, code, display_name, timezone)
    values ('10000000-0000-4000-8000-000000000001', ' main ', 'Duplicate Main', 'UTC')
  $test$,
  '23505',
  'duplicate tenant-scoped branch code is rejected'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.branches
    where normalized_code = 'main'
  ),
  'same branch code is accepted in different tenants'
);

insert into public.warehouses (id, tenant_id, code, display_name, timezone)
values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'WH', 'Warehouse One', 'America/New_York'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'WH', 'Warehouse Two', 'Europe/Berlin');

insert into public.branch_brands (tenant_id, branch_id, brand_id)
values (
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001'
);

select pg_temp.assert_raises(
  $test$
    insert into public.branch_brands (tenant_id, branch_id, brand_id)
    values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002'
    )
  $test$,
  '23503',
  'cross-tenant branch-brand association is rejected'
);

insert into public.inventory_locations (
  id,
  tenant_id,
  branch_id,
  code,
  display_name,
  location_type,
  is_sellable
)
values
  (
    '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'SALES',
    'Sales Floor',
    'sales_floor',
    true
  ),
  (
    '50000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    'SALES',
    'Sales Floor',
    'sales_floor',
    true
  );

insert into public.inventory_locations (
  id,
  tenant_id,
  warehouse_id,
  code,
  display_name,
  location_type,
  is_receiving_enabled
)
values (
  '50000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'RECEIVING',
  'Receiving',
  'receiving',
  true
);

update public.branches
set default_inventory_location_id = '50000000-0000-4000-8000-000000000001'
where id = '30000000-0000-4000-8000-000000000001';

select pg_temp.assert_raises(
  $test$
    update public.branches
    set default_inventory_location_id = '50000000-0000-4000-8000-000000000001'
    where id = '30000000-0000-4000-8000-000000000003'
  $test$,
  '23503',
  'branch default inventory location must belong to that branch'
);

select pg_temp.assert_raises(
  $test$
    insert into public.inventory_locations (
      tenant_id,
      branch_id,
      warehouse_id,
      code,
      display_name,
      location_type
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'BOTH',
      'Invalid Both',
      'invalid'
    )
  $test$,
  '23514',
  'inventory location with both parents is rejected'
);

select pg_temp.assert_raises(
  $test$
    insert into public.inventory_locations (tenant_id, code, display_name, location_type)
    values (
      '10000000-0000-4000-8000-000000000001',
      'NONE',
      'Invalid Neither',
      'invalid'
    )
  $test$,
  '23514',
  'inventory location with neither parent is rejected'
);

select pg_temp.assert_raises(
  $test$
    insert into public.inventory_locations (
      tenant_id,
      branch_id,
      code,
      display_name,
      location_type
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      'CROSS',
      'Cross Tenant',
      'invalid'
    )
  $test$,
  '23503',
  'cross-tenant inventory location parent is rejected'
);

insert into public.registers (
  id,
  tenant_id,
  branch_id,
  code,
  display_name,
  status,
  default_inventory_location_id
)
values
  (
    '60000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'REG-1',
    'Register One',
    'active',
    '50000000-0000-4000-8000-000000000001'
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'REG-2',
    'Register Two',
    'active',
    '50000000-0000-4000-8000-000000000001'
  );

select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.registers
    where default_inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'multiple registers may share one inventory location'
);

select pg_temp.assert_raises(
  $test$
    insert into public.registers (
      tenant_id,
      branch_id,
      code,
      display_name,
      status,
      default_inventory_location_id
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      'REG-CROSS',
      'Cross Tenant Register',
      'active',
      '50000000-0000-4000-8000-000000000003'
    )
  $test$,
  '23503',
  'cross-tenant register default location is rejected'
);

select pg_temp.assert_raises(
  $test$
    insert into public.registers (
      tenant_id,
      branch_id,
      code,
      display_name,
      status,
      default_inventory_location_id
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000003',
      'REG-WRONG-BRANCH',
      'Wrong Branch Register',
      'active',
      '50000000-0000-4000-8000-000000000001'
    )
  $test$,
  '23503',
  'same-tenant cross-branch register default location is rejected'
);

insert into public.user_identities (id, display_name, primary_email)
values (
  '70000000-0000-4000-8000-000000000001',
  'Shared User',
  'shared@example.test'
);

insert into public.user_identity_provider_bindings (
  user_identity_id,
  provider,
  provider_subject
)
values (
  '70000000-0000-4000-8000-000000000001',
  'test-provider',
  'subject-1'
);

insert into public.memberships (
  id,
  tenant_id,
  user_identity_id,
  status,
  activated_at
)
values
  (
    '80000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001',
    'active',
    now()
  ),
  (
    '80000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '70000000-0000-4000-8000-000000000001',
    'active',
    now()
  );

select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.memberships
    where user_identity_id = '70000000-0000-4000-8000-000000000001'
  ),
  'same UserIdentity may belong to two tenants'
);

select pg_temp.assert_raises(
  $test$
    insert into public.memberships (tenant_id, user_identity_id)
    values (
      '10000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000001'
    )
  $test$,
  '23505',
  'duplicate membership in one tenant is rejected'
);

insert into public.roles (id, tenant_id, name)
values
  ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Test Role'),
  ('90000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Test Role');

insert into public.permissions (id, key, description)
values (
  'a0000000-0000-4000-8000-000000000001',
  'test.read',
  'Test-local fixture only; migrations seed no catalog data.'
);

select pg_temp.assert_raises(
  $test$
    insert into public.permissions (key) values ('test.read')
  $test$,
  '23505',
  'permission key uniqueness is enforced'
);

insert into public.role_permissions (tenant_id, role_id, permission_id)
values (
  '10000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001'
);

insert into public.access_scopes (id, tenant_id, name, scope_mode)
values
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Explicit Scope', 'explicit'),
  ('b0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Explicit Scope', 'explicit'),
  ('b0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Tenant Scope', 'tenant');

insert into public.access_scope_targets (
  tenant_id,
  access_scope_id,
  branch_id
)
values (
  '10000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001'
);

select pg_temp.assert_raises(
  $test$
    insert into public.access_scope_targets (tenant_id, access_scope_id, branch_id)
    values (
      '10000000-0000-4000-8000-000000000001',
      'b0000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002'
    )
  $test$,
  '23503',
  'cross-tenant access-scope target is rejected'
);

select pg_temp.assert_raises(
  $test$
    insert into public.access_scope_targets (tenant_id, access_scope_id, brand_id)
    values (
      '10000000-0000-4000-8000-000000000001',
      'b0000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000001'
    )
  $test$,
  '23503',
  'tenant-wide scope cannot carry explicit targets'
);

select pg_temp.assert_raises(
  $test$
    insert into public.access_scope_targets (
      tenant_id,
      access_scope_id,
      brand_id,
      branch_id
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      'b0000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001'
    )
  $test$,
  '23514',
  'access-scope target must select exactly one resource kind'
);

insert into public.membership_role_assignments (
  tenant_id,
  membership_id,
  role_id,
  access_scope_id
)
values (
  '10000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001'
);

select pg_temp.assert_raises(
  $test$
    insert into public.membership_role_assignments (
      tenant_id,
      membership_id,
      role_id,
      access_scope_id
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000002',
      'b0000000-0000-4000-8000-000000000001'
    )
  $test$,
  '23503',
  'cross-tenant membership-role assignment is rejected'
);

insert into public.devices (
  id,
  tenant_id,
  installation_id,
  device_type,
  display_name,
  status,
  activated_at
)
values
  (
    'c0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'installation-one',
    'pos_terminal',
    'Terminal One',
    'active',
    now()
  ),
  (
    'c0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'installation-two',
    'pos_terminal',
    'Terminal Two',
    'active',
    now()
  ),
  (
    'c0000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'installation-three',
    'pos_terminal',
    'Terminal Three',
    'active',
    now()
  );

insert into public.register_device_assignments (
  id,
  tenant_id,
  register_id,
  device_id,
  assigned_by_membership_id,
  assignment_reason
)
values (
  'd0000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000001',
  'Initial test assignment'
);

select pg_temp.assert_raises(
  $test$
    insert into public.register_device_assignments (tenant_id, register_id, device_id)
    values (
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000002',
      'c0000000-0000-4000-8000-000000000002'
    )
  $test$,
  '23503',
  'cross-tenant device-register assignment is rejected'
);

select pg_temp.assert_raises(
  $test$
    insert into public.register_device_assignments (tenant_id, register_id, device_id)
    values (
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000002',
      'c0000000-0000-4000-8000-000000000001'
    )
  $test$,
  '23505',
  'one device cannot have two current register assignments'
);

select pg_temp.assert_raises(
  $test$
    insert into public.register_device_assignments (tenant_id, register_id, device_id)
    values (
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-000000000003'
    )
  $test$,
  '23505',
  'one register cannot have two current device assignments'
);

update public.register_device_assignments
set
  unassigned_at = now(),
  unassigned_by_membership_id = '80000000-0000-4000-8000-000000000001',
  unassignment_reason = 'Move to another register'
where id = 'd0000000-0000-4000-8000-000000000001';

insert into public.register_device_assignments (
  id,
  tenant_id,
  register_id,
  device_id,
  assigned_by_membership_id,
  assignment_reason
)
values (
  'd0000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000001',
  'Reassignment history test'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
      and count(*) filter (where unassigned_at is null) = 1
    from public.register_device_assignments
    where device_id = 'c0000000-0000-4000-8000-000000000001'
  ),
  'device assignment history retains one past and one current interval'
);

select pg_temp.assert_raises(
  $test$
    insert into public.register_device_assignments (
      tenant_id,
      register_id,
      device_id,
      assigned_at,
      unassigned_at
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-000000000003',
      '2026-08-19 12:00:00+00',
      '2026-08-19 11:00:00+00'
    )
  $test$,
  '23514',
  'assignment interval cannot end before it starts'
);

select pg_temp.assert_raises(
  $test$
    delete from public.tenants
    where id = '10000000-0000-4000-8000-000000000001'
  $test$,
  '23503',
  'tenant hard delete is restricted while dependent history exists'
);

rollback;

\echo 'Phase 1C-A persistence invariants passed.'
