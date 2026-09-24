begin;

create extension if not exists pgtap with schema extensions;

select plan(87);

create or replace function pg_temp.statement_raises(statement text, expected_state text)
returns boolean
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
      return actual_state = expected_state;
  end;

  return false;
end;
$function$;

-- Policy structure and privilege boundaries.
select is(
  (
    select count(*)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relrowsecurity
      and relation.relname = any (
        array[
          'tenants', 'brands', 'branches', 'warehouses', 'branch_brands',
          'inventory_locations', 'registers', 'user_identities',
          'user_identity_provider_bindings', 'memberships', 'roles', 'permissions',
          'role_permissions', 'access_scopes', 'access_scope_targets',
          'membership_role_assignments', 'devices', 'register_device_assignments'
        ]
      )
  ),
  18::bigint,
  'RLS is enabled on all 18 foundational tables'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relforcerowsecurity
  ),
  0::bigint,
  'RLS is intentionally not forced for owners and bypass roles'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and tablename = any (
        array[
          'tenants', 'brands', 'branches', 'warehouses', 'branch_brands',
          'inventory_locations', 'registers', 'user_identities', 'memberships',
          'roles', 'permissions', 'role_permissions', 'access_scopes',
          'access_scope_targets', 'membership_role_assignments', 'devices',
          'register_device_assignments'
        ]
      )
  ),
  17::bigint,
  'all 17 approved SELECT policies explicitly target authenticated'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and cmd <> 'SELECT'
      and roles && array['anon', 'authenticated']::name[]
  ),
  0::bigint,
  'no client mutation policy exists (internal non-login writer policies are allowed)'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'commerce_context'
      and not procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
  ),
  5::bigint,
  'all five request-context helpers are SECURITY INVOKER with an empty fixed search_path'
);

select ok(
  not has_schema_privilege('public', 'commerce_context', 'USAGE'),
  'PUBLIC cannot use the private request-context schema'
);

select ok(
  not has_schema_privilege('anon', 'commerce_context', 'USAGE'),
  'anon cannot use the private request-context schema'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'commerce_context'
      and has_function_privilege('anon', procedure.oid, 'EXECUTE')
  ),
  0::bigint,
  'anon cannot execute any request-context helper'
);

select ok(
  has_schema_privilege('authenticated', 'commerce_context', 'USAGE'),
  'authenticated requests can use the request-context schema'
);

select is(
  (
    select count(*)
    from unnest(
      array[
        'tenants', 'brands', 'branches', 'warehouses', 'branch_brands',
        'inventory_locations', 'registers', 'user_identities',
        'user_identity_provider_bindings', 'memberships', 'roles', 'permissions',
        'role_permissions', 'access_scopes', 'access_scope_targets',
        'membership_role_assignments', 'devices', 'register_device_assignments'
      ]
    ) as table_name
    where has_table_privilege('anon', format('public.%I', table_name), 'SELECT')
       or has_table_privilege('anon', format('public.%I', table_name), 'INSERT')
       or has_table_privilege('anon', format('public.%I', table_name), 'UPDATE')
       or has_table_privilege('anon', format('public.%I', table_name), 'DELETE')
  ),
  0::bigint,
  'anon has no foundational table privileges'
);

select is(
  (
    select count(*)
    from unnest(
      array[
        'tenants', 'brands', 'branches', 'warehouses', 'branch_brands',
        'inventory_locations', 'registers', 'user_identities',
        'user_identity_provider_bindings', 'memberships', 'roles', 'permissions',
        'role_permissions', 'access_scopes', 'access_scope_targets',
        'membership_role_assignments', 'devices', 'register_device_assignments'
      ]
    ) as table_name
    where has_table_privilege('authenticated', format('public.%I', table_name), 'INSERT')
       or has_table_privilege('authenticated', format('public.%I', table_name), 'UPDATE')
       or has_table_privilege('authenticated', format('public.%I', table_name), 'DELETE')
  ),
  0::bigint,
  'authenticated has no foundational mutation privileges'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'public.user_identity_provider_bindings',
    'SELECT'
  ),
  'provider bindings have no authenticated SELECT grant'
);

select is(
  (
    select count(*)
    from unnest(
      array[
        'tenants', 'brands', 'branches', 'warehouses', 'branch_brands',
        'inventory_locations', 'registers', 'user_identities', 'memberships', 'roles',
        'permissions', 'role_permissions', 'access_scopes', 'access_scope_targets',
        'membership_role_assignments', 'devices', 'register_device_assignments'
      ]
    ) as table_name
    where has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT')
  ),
  17::bigint,
  'authenticated has SELECT only on the 17 approved tables'
);

select is(
  (
    select count(*)
    from unnest(
      array[
        'tenants', 'brands', 'branches', 'warehouses', 'branch_brands',
        'inventory_locations', 'registers', 'user_identities',
        'user_identity_provider_bindings', 'memberships', 'roles', 'permissions',
        'role_permissions', 'access_scopes', 'access_scope_targets',
        'membership_role_assignments', 'devices', 'register_device_assignments'
      ]
    ) as table_name
    where has_table_privilege('service_role', format('public.%I', table_name), 'SELECT')
      and has_table_privilege('service_role', format('public.%I', table_name), 'INSERT')
      and has_table_privilege('service_role', format('public.%I', table_name), 'UPDATE')
      and has_table_privilege('service_role', format('public.%I', table_name), 'DELETE')
  ),
  18::bigint,
  'service_role has intentional privileged DML across all 18 foundational tables'
);

-- Fixtures are created as the privileged test owner, outside authenticated policy evaluation.
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('10000000-0000-4000-8000-000000000001', 'rls-tenant-a', 'RLS Tenant A', 'active', 'completed', 'USD'),
  ('10000000-0000-4000-8000-000000000002', 'rls-tenant-b', 'RLS Tenant B', 'active', 'completed', 'EUR'),
  ('10000000-0000-4000-8000-000000000003', 'rls-tenant-c', 'RLS Tenant C', 'active', 'completed', 'GBP');

insert into public.user_identities (id, display_name, primary_email)
values
  ('70000000-0000-4000-8000-000000000001', 'Multi Tenant User', 'multi@example.test'),
  ('70000000-0000-4000-8000-000000000002', 'Other User', 'other@example.test'),
  ('70000000-0000-4000-8000-000000000003', 'Invited User', 'invited@example.test'),
  ('70000000-0000-4000-8000-000000000004', 'Suspended Member', 'suspended@example.test'),
  ('70000000-0000-4000-8000-000000000005', 'Deactivated Member', 'deactivated@example.test');

insert into public.user_identity_provider_bindings (
  id,
  user_identity_id,
  provider,
  provider_subject
)
values
  (
    '71000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001',
    'test-provider',
    'multi-subject'
  ),
  (
    '71000000-0000-4000-8000-000000000002',
    '70000000-0000-4000-8000-000000000002',
    'test-provider',
    'other-subject'
  );

insert into public.memberships (
  id,
  tenant_id,
  user_identity_id,
  status,
  invited_at,
  activated_at,
  suspended_at,
  deactivated_at
)
values
  (
    '80000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001',
    'active',
    '2026-08-01 00:00:00+00',
    '2026-08-02 00:00:00+00',
    null,
    null
  ),
  (
    '80000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '70000000-0000-4000-8000-000000000001',
    'active',
    '2026-08-01 00:00:00+00',
    '2026-08-02 00:00:00+00',
    null,
    null
  ),
  (
    '80000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    'active',
    '2026-08-01 00:00:00+00',
    '2026-08-02 00:00:00+00',
    null,
    null
  ),
  (
    '80000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000003',
    'invited',
    '2026-08-01 00:00:00+00',
    null,
    null,
    null
  ),
  (
    '80000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000004',
    'suspended',
    '2026-08-01 00:00:00+00',
    '2026-08-02 00:00:00+00',
    '2026-08-03 00:00:00+00',
    null
  ),
  (
    '80000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000005',
    'deactivated',
    '2026-08-01 00:00:00+00',
    '2026-08-02 00:00:00+00',
    null,
    '2026-08-03 00:00:00+00'
  );

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'B', 'Brand B');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Branch A', 'UTC'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'B', 'Branch B', 'UTC');

insert into public.warehouses (id, tenant_id, code, display_name, timezone)
values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Warehouse A', 'UTC'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'B', 'Warehouse B', 'UTC');

insert into public.branch_brands (tenant_id, branch_id, brand_id)
values
  (
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002'
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
    'A',
    'Location A',
    'sales_floor',
    true
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    'B',
    'Location B',
    'sales_floor',
    true
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
    'A',
    'Register A',
    'active',
    '50000000-0000-4000-8000-000000000001'
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    'B',
    'Register B',
    'active',
    '50000000-0000-4000-8000-000000000002'
  );

insert into public.roles (id, tenant_id, name)
values
  ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Role A'),
  ('90000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Role B');

insert into public.permissions (id, key, description)
values (
  'a0000000-0000-4000-8000-000000000001',
  'test.read',
  'Transaction-local RLS fixture.'
);

insert into public.role_permissions (tenant_id, role_id, permission_id)
values
  (
    '10000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '90000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000001'
  );

insert into public.access_scopes (id, tenant_id, name, scope_mode)
values
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Scope A', 'explicit'),
  ('b0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Scope B', 'explicit');

insert into public.access_scope_targets (id, tenant_id, access_scope_id, branch_id)
values
  (
    'b1000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001'
  ),
  (
    'b1000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002'
  );

insert into public.membership_role_assignments (
  id,
  tenant_id,
  membership_id,
  role_id,
  access_scope_id
)
values
  (
    'b2000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001'
  ),
  (
    'b2000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '80000000-0000-4000-8000-000000000002',
    '90000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000002'
  ),
  (
    'b2000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000003',
    '90000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001'
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
    'rls-installation-a',
    'pos_terminal',
    'Device A',
    'active',
    '2026-08-02 00:00:00+00'
  ),
  (
    'c0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'rls-installation-b',
    'pos_terminal',
    'Device B',
    'active',
    '2026-08-02 00:00:00+00'
  );

insert into public.register_device_assignments (
  id,
  tenant_id,
  register_id,
  device_id,
  assigned_by_membership_id
)
values
  (
    'd0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000001'
  ),
  (
    'd0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000002',
    '80000000-0000-4000-8000-000000000002'
  );

set local role authenticated;
set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000001"}';

select is(
  commerce_context.current_user_identity_id(),
  '70000000-0000-4000-8000-000000000001'::uuid,
  'UserIdentity context is read from the trusted claim'
);

select is(
  commerce_context.current_tenant_id(),
  '10000000-0000-4000-8000-000000000001'::uuid,
  'Tenant context is explicit'
);

select is(
  commerce_context.current_membership_id(),
  '80000000-0000-4000-8000-000000000001'::uuid,
  'active Membership is derived from exact identity and tenant'
);

select ok(commerce_context.has_active_membership(), 'active Membership authorizes tenant reads');
select is((select count(*) from public.tenants), 1::bigint, 'active member reads own Tenant');
select is(
  (select count(*) from public.tenants where id = '10000000-0000-4000-8000-000000000002'),
  0::bigint,
  'active member cannot read another Tenant by UUID'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000002"}';
select is(
  (select count(*) from public.tenants where id = '10000000-0000-4000-8000-000000000002'),
  1::bigint,
  'same user can switch to a second active Tenant membership'
);
select is(
  (select count(*) from public.tenants where id = '10000000-0000-4000-8000-000000000001'),
  0::bigint,
  'switching Tenant context does not retain first-Tenant visibility'
);

set local "request.jwt.claims" = '';
select is((select count(*) from public.tenants), 0::bigint, 'missing Tenant context fails closed');

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"not-a-uuid"}';
select is((select count(*) from public.tenants), 0::bigint, 'invalid Tenant UUID fails closed');

set local "request.jwt.claims" = 'not-json';
select is((select count(*) from public.tenants), 0::bigint, 'malformed JWT claims fail closed');

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":{"value":"10000000-0000-4000-8000-000000000001"}}';
select is(
  commerce_context.current_tenant_id(),
  null::uuid,
  'object-valued Tenant claim fails closed'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":["10000000-0000-4000-8000-000000000001"]}';
select is(
  commerce_context.current_tenant_id(),
  null::uuid,
  'array-valued Tenant claim fails closed'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":null}';
select is(
  commerce_context.current_tenant_id(),
  null::uuid,
  'null Tenant claim fails closed'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":42}';
select is(
  commerce_context.current_tenant_id(),
  null::uuid,
  'unexpected scalar Tenant claim type fails closed'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000003"}';
select is((select count(*) from public.tenants), 0::bigint, 'unknown Membership for valid Tenant fails closed');

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000003","tenant_id":"10000000-0000-4000-8000-000000000001"}';
select is((select count(*) from public.tenants), 0::bigint, 'invited Membership cannot read tenant data');
select is(
  (select count(*) from public.user_identities),
  0::bigint,
  'invited member cannot read their own UserIdentity'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000004","tenant_id":"10000000-0000-4000-8000-000000000001"}';
select is((select count(*) from public.tenants), 0::bigint, 'suspended Membership cannot read tenant data');
select is(
  (select count(*) from public.user_identities),
  0::bigint,
  'suspended member cannot read their own UserIdentity'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000005","tenant_id":"10000000-0000-4000-8000-000000000001"}';
select is((select count(*) from public.tenants), 0::bigint, 'deactivated Membership cannot read tenant data');
select is(
  (select count(*) from public.user_identities),
  0::bigint,
  'deactivated member cannot read their own UserIdentity'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000002","tenant_id":"10000000-0000-4000-8000-000000000001"}';
select is(
  (select count(*) from public.brands where id = '20000000-0000-4000-8000-000000000001'),
  1::bigint,
  'second active member can read Tenant A shared rows'
);
select is(
  (select count(*) from public.user_identities where id = '70000000-0000-4000-8000-000000000002'),
  1::bigint,
  'second active member can read their own UserIdentity'
);
select is(
  (select count(*) from public.user_identities where id = '70000000-0000-4000-8000-000000000001'),
  0::bigint,
  'second active member cannot read the first member UserIdentity'
);
select is(
  (select count(*) from public.memberships where id = '80000000-0000-4000-8000-000000000001'),
  0::bigint,
  'second active member cannot read the first member Membership'
);
select is(
  (
    select count(*)
    from public.membership_role_assignments
    where membership_id = '80000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'second active member cannot read the first member role assignment'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000001"}';

select is((select count(*) from public.brands), 1::bigint, 'Brand reads stay in Tenant A');
select is((select count(*) from public.branches), 1::bigint, 'Branch reads stay in Tenant A');
select is((select count(*) from public.warehouses), 1::bigint, 'Warehouse reads stay in Tenant A');
select is((select count(*) from public.branch_brands), 1::bigint, 'BranchBrand reads stay in Tenant A');
select is(
  (select count(*) from public.inventory_locations),
  1::bigint,
  'InventoryLocation reads stay in Tenant A'
);
select is((select count(*) from public.registers), 1::bigint, 'Register reads stay in Tenant A');
select is((select count(*) from public.memberships), 1::bigint, 'Membership read is self-only and active');
select is((select count(*) from public.roles), 1::bigint, 'Role reads stay in Tenant A');
select is((select count(*) from public.role_permissions), 1::bigint, 'RolePermission reads stay in Tenant A');
select is((select count(*) from public.access_scopes), 1::bigint, 'AccessScope reads stay in Tenant A');
select is(
  (select count(*) from public.access_scope_targets),
  1::bigint,
  'AccessScopeTarget reads stay in Tenant A'
);
select is(
  (select count(*) from public.membership_role_assignments),
  1::bigint,
  'MembershipRoleAssignment read is current-Membership only'
);
select is((select count(*) from public.devices), 1::bigint, 'Device reads stay in Tenant A');
select is(
  (select count(*) from public.register_device_assignments),
  1::bigint,
  'RegisterDeviceAssignment reads stay in Tenant A'
);

select is(
  (select count(*) from public.branches where id = '30000000-0000-4000-8000-000000000002'),
  0::bigint,
  'known foreign Branch UUID probing returns no row'
);
select is((select count(*) from public.user_identities), 1::bigint, 'UserIdentity read is self-only');
select is(
  (select count(*) from public.user_identities where id = '70000000-0000-4000-8000-000000000002'),
  0::bigint,
  'another global UserIdentity cannot be enumerated by UUID'
);
select ok(
  pg_temp.statement_raises(
    'select count(*) from public.user_identity_provider_bindings',
    '42501'
  ),
  'provider bindings are not enumerable by authenticated users'
);
-- The platform permission catalog is seeded by the Phase 2D migration (8 stable keys), the Phase 2E
-- migration (1 more, 'orders.fulfill'), the Phase 2F migration (1 more, 'catalog.read'), Phase 2H
-- (1 more, 'payments.capture'), Phase 2J (2 more, 'catalog.author' and 'catalog.publish'), Phase 2N
-- (2 more, 'suppliers.read' and 'suppliers.manage'), and Phase 2O (2 more, 'staff.read' and
-- 'staff.manage'), and Phase 2P (2 more, 'promotions.read' and 'promotions.manage'); this
-- transaction-local fixture adds 'test.read', for the exact 23-key visible catalog below.
select is(
  (select array_agg(key order by key) from public.permissions),
  array[
    'catalog.author',
    'catalog.publish',
    'catalog.read',
    'inventory.adjust',
    'inventory.issue',
    'inventory.read',
    'inventory.receive',
    'inventory.transfer',
    'orders.cancel',
    'orders.create',
    'orders.fulfill',
    'orders.read',
    'payments.capture',
    'payments.refund',
    'promotions.manage',
    'promotions.read',
    'returns.create',
    'returns.read',
    'staff.manage',
    'staff.read',
    'suppliers.manage',
    'suppliers.read',
    'test.read'
  ]::text[],
  'active member can read the exact Permission catalog including returns/refunds, suppliers, staff and promotions'
);

select is(
  (
    select count(*)
    from public.branch_brands
    where tenant_id = '10000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'foreign BranchBrand association is invisible'
);
select is(
  (
    select count(*)
    from public.role_permissions
    where tenant_id = '10000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'foreign RolePermission association is invisible'
);
select is(
  (
    select count(*)
    from public.access_scope_targets
    where tenant_id = '10000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'foreign AccessScopeTarget association is invisible'
);
select is(
  (
    select count(*)
    from public.membership_role_assignments
    where membership_id = '80000000-0000-4000-8000-000000000003'
  ),
  0::bigint,
  'another member assignment in the same Tenant is invisible'
);
select is(
  (
    select count(*)
    from public.register_device_assignments
    where tenant_id = '10000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'foreign RegisterDeviceAssignment history is invisible'
);

select ok(
  pg_temp.statement_raises(
    $$insert into public.user_identity_provider_bindings (
        user_identity_id,
        provider,
        provider_subject
      ) values (
        '70000000-0000-4000-8000-000000000001',
        'untrusted-provider',
        'untrusted-subject'
      )$$,
    '42501'
  ),
  'authenticated cannot insert a provider binding'
);
select ok(
  pg_temp.statement_raises(
    $$update public.user_identity_provider_bindings
      set provider_subject = 'changed-subject'
      where id = '71000000-0000-4000-8000-000000000001'$$,
    '42501'
  ),
  'authenticated cannot update a provider binding'
);
select ok(
  pg_temp.statement_raises(
    $$delete from public.user_identity_provider_bindings
      where id = '71000000-0000-4000-8000-000000000001'$$,
    '42501'
  ),
  'authenticated cannot delete a provider binding'
);

-- Temporarily grant DML inside this rolled-back test so absence of mutation policies is exercised.
reset role;
grant insert, update, delete on public.tenants to authenticated;
grant insert, update, delete on public.brands to authenticated;
grant insert, update, delete on public.branch_brands to authenticated;
grant insert, update, delete on public.registers to authenticated;
grant insert, update, delete on public.permissions to authenticated;
set local role authenticated;
set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000001"}';

select ok(
  pg_temp.statement_raises(
    $$insert into public.brands (tenant_id, code, display_name)
      values ('10000000-0000-4000-8000-000000000001', 'OWN-INSERT', 'Denied')$$,
    '42501'
  ),
  'authenticated insert into own Tenant is denied'
);
select ok(
  pg_temp.statement_raises(
    $$insert into public.brands (tenant_id, code, display_name)
      values ('10000000-0000-4000-8000-000000000002', 'FOREIGN-INSERT', 'Denied')$$,
    '42501'
  ),
  'authenticated insert into foreign Tenant is denied'
);
select ok(
  pg_temp.statement_raises(
    $$insert into public.branch_brands (tenant_id, branch_id, brand_id)
      values (
        '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002'
      )$$,
    '42501'
  ),
  'authenticated mismatched foreign-parent insert is denied before relationship construction'
);
with changed as (
  update public.brands
  set display_name = 'Changed'
  where id = '20000000-0000-4000-8000-000000000001'
  returning 1
)
select is(
  (select count(*) from changed),
  0::bigint,
  'authenticated own-Tenant update is denied'
);
with changed as (
  update public.brands
  set display_name = 'Changed'
  where id = '20000000-0000-4000-8000-000000000002'
  returning 1
)
select is(
  (select count(*) from changed),
  0::bigint,
  'authenticated cross-Tenant update is denied'
);
with changed as (
  update public.brands
  set tenant_id = '10000000-0000-4000-8000-000000000002'
  where id = '20000000-0000-4000-8000-000000000001'
  returning 1
)
select is(
  (select count(*) from changed),
  0::bigint,
  'authenticated Tenant reassignment is denied'
);
with changed as (
  update public.registers
  set default_inventory_location_id = '50000000-0000-4000-8000-000000000002'
  where id = '60000000-0000-4000-8000-000000000001'
  returning 1
)
select is(
  (select count(*) from changed),
  0::bigint,
  'authenticated foreign-parent substitution is denied'
);
with removed as (
  delete from public.brands
  where id = '20000000-0000-4000-8000-000000000001'
  returning 1
)
select is(
  (select count(*) from removed),
  0::bigint,
  'authenticated own-Tenant delete is denied'
);
with removed as (
  delete from public.brands
  where id = '20000000-0000-4000-8000-000000000002'
  returning 1
)
select is(
  (select count(*) from removed),
  0::bigint,
  'authenticated cross-Tenant delete is denied'
);
select ok(
  pg_temp.statement_raises(
    $$insert into public.permissions (key, description)
      values ('test.write', 'Denied catalog mutation')$$,
    '42501'
  ),
  'authenticated Permission catalog insert is denied'
);
with changed as (
  update public.permissions
  set description = 'Changed'
  where id = 'a0000000-0000-4000-8000-000000000001'
  returning 1
)
select is(
  (select count(*) from changed),
  0::bigint,
  'authenticated Permission catalog update is denied'
);
select ok(
  pg_temp.statement_raises(
    $$insert into public.tenants (slug, display_name, default_currency)
      values ('direct-tenant', 'Denied', 'USD')$$,
    '42501'
  ),
  'authenticated Tenant creation is denied'
);
select is(
  (select display_name from public.brands where id = '20000000-0000-4000-8000-000000000001'),
  'Brand A'::text,
  'denied mutations leave own-Tenant data unchanged'
);

reset role;
select ok(
  (select rolbypassrls from pg_catalog.pg_roles where rolname = 'service_role'),
  'Supabase service_role is explicitly a BYPASSRLS role'
);
set local role service_role;
select is((select count(*) from public.tenants), 3::bigint, 'service_role can bypass tenant RLS');
select is(
  (select count(*) from public.user_identity_provider_bindings),
  2::bigint,
  'service_role can read provider bindings that authenticated cannot access'
);

reset role;
set local role anon;
set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000001"}';
select ok(
  pg_temp.statement_raises('select count(*) from public.tenants', '42501'),
  'anon cannot turn claim-shaped text into table access'
);
select ok(
  pg_temp.statement_raises('select commerce_context.current_tenant_id()', '42501'),
  'anon cannot call the private request-context helper surface'
);

reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"invalid"}';
select ok(
  commerce_context.current_tenant_id() is null,
  'invalid claim parsing returns NULL without leaking an error'
);

reset role;
select * from finish();
rollback;
