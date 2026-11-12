-- Disposable Phase 1D adapter fixtures. This file is applied only by
-- scripts/test-authorization-integration.mjs after a local Supabase reset.
-- It is not a migration or production seed.

insert into public.tenants (
  id, slug, display_name, status, onboarding_state, default_currency, suspended_at
)
values
  ('10000000-0000-4000-8000-000000000001', 'integration-a', 'Integration A', 'active', 'completed', 'USD', null),
  ('10000000-0000-4000-8000-000000000002', 'integration-b', 'Integration B', 'active', 'completed', 'USD', null),
  ('10000000-0000-4000-8000-000000000003', 'integration-suspended', 'Integration Suspended', 'suspended', 'completed', 'USD', now());

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'brand-a', 'Brand A'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'brand-b', 'Brand B');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'branch-a', 'Branch A', 'UTC'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'branch-b', 'Branch B', 'UTC');

insert into public.warehouses (id, tenant_id, code, display_name, timezone)
values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'warehouse-a', 'Warehouse A', 'UTC'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'warehouse-b', 'Warehouse B', 'UTC');

insert into public.inventory_locations (
  id, tenant_id, branch_id, code, display_name, location_type
)
values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'location-a', 'Location A', 'store'),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'location-b', 'Location B', 'store');

insert into public.user_identities (id, status, suspended_at)
values
  ('70000000-0000-4000-8000-000000000001', 'active', null),
  ('70000000-0000-4000-8000-000000000002', 'suspended', now()),
  ('70000000-0000-4000-8000-000000000003', 'active', null),
  ('70000000-0000-4000-8000-000000000004', 'active', null),
  ('70000000-0000-4000-8000-000000000005', 'active', null),
  ('70000000-0000-4000-8000-000000000006', 'active', null),
  ('70000000-0000-4000-8000-000000000007', 'active', null),
  ('70000000-0000-4000-8000-000000000008', 'active', null),
  ('70000000-0000-4000-8000-000000000009', 'active', null),
  ('70000000-0000-4000-8000-000000000010', 'active', null),
  ('70000000-0000-4000-8000-000000000011', 'active', null),
  ('70000000-0000-4000-8000-000000000012', 'active', null),
  ('70000000-0000-4000-8000-000000000013', 'active', null);

-- The next two constraints are removed only in this disposable database so the adapter's
-- cardinality checks can be tested against states that production constraints normally prevent.
alter table public.user_identity_provider_bindings
  drop constraint user_identity_provider_bindings_provider_subject_unique;
alter table public.memberships drop constraint memberships_tenant_identity_unique;

insert into public.user_identity_provider_bindings (
  id, user_identity_id, provider, provider_subject
)
values
  ('71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'clerk', 'integration-valid'),
  ('71000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', 'clerk', 'integration-inactive-identity'),
  ('71000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000003', 'clerk', 'integration-no-membership'),
  ('71000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000004', 'clerk', 'integration-inactive-membership'),
  ('71000000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000005', 'clerk', 'integration-suspended-tenant'),
  ('71000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000006', 'clerk', 'integration-duplicate-binding'),
  ('71000000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000007', 'clerk', 'integration-duplicate-binding'),
  ('71000000-0000-4000-8000-000000000008', '70000000-0000-4000-8000-000000000008', 'clerk', 'integration-duplicate-membership'),
  ('71000000-0000-4000-8000-000000000009', '70000000-0000-4000-8000-000000000009', 'clerk', 'integration-missing-role'),
  ('71000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000010', 'clerk', 'integration-tenant-target'),
  ('71000000-0000-4000-8000-000000000011', '70000000-0000-4000-8000-000000000011', 'clerk', 'integration-missing-permission'),
  ('71000000-0000-4000-8000-000000000012', '70000000-0000-4000-8000-000000000012', 'clerk', 'integration-malformed-target'),
  ('71000000-0000-4000-8000-000000000013', '70000000-0000-4000-8000-000000000013', 'clerk', 'integration-empty-scope'),
  ('71000000-0000-4000-8000-000000000014', '70000000-0000-4000-8000-000000000001', 'other-provider', 'integration-valid');

insert into public.memberships (
  id, tenant_id, user_identity_id, status, activated_at, suspended_at
)
values
  ('80000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), null),
  ('80000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000004', 'suspended', null, now()),
  ('80000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000005', 'active', now(), null),
  ('80000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000008', 'active', now(), null),
  ('80000000-0000-4000-8000-000000000018', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000008', 'active', now(), null),
  ('80000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000009', 'active', now(), null),
  ('80000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000010', 'active', now(), null),
  ('80000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000011', 'active', now(), null),
  ('80000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000012', 'active', now(), null),
  ('80000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000013', 'active', now(), null);

insert into public.permissions (id, key, status, deprecated_at)
values
  ('a0000000-0000-4000-8000-000000000001', 'test.read', 'active', null),
  ('a0000000-0000-4000-8000-000000000002', 'test.deprecated', 'deprecated', now());

insert into public.roles (id, tenant_id, name, status, is_protected, archived_at)
values
  ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Valid Role', 'active', true, null),
  ('90000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Archived Role', 'archived', false, now()),
  ('90000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', 'Tenant Target Role', 'active', false, null),
  ('90000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'Missing Permission Role', 'active', false, null),
  ('90000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', 'Malformed Target Role', 'active', false, null),
  ('90000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', 'Empty Scope Role', 'active', false, null);

insert into public.role_permissions (tenant_id, role_id, permission_id)
values
  ('10000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000010', 'a0000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000001');

insert into public.access_scopes (id, tenant_id, name, scope_mode, status, archived_at)
values
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Valid Explicit', 'explicit', 'active', null),
  ('b0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Ended Tenant', 'tenant', 'active', null),
  ('b0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Archived Scope', 'tenant', 'archived', now()),
  ('b0000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', 'Corrupt Tenant Target', 'tenant', 'active', null),
  ('b0000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'Missing Permission', 'tenant', 'active', null),
  ('b0000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', 'Malformed Target', 'explicit', 'active', null),
  ('b0000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', 'Empty Explicit', 'explicit', 'active', null),
  ('b0000000-0000-4000-8000-000000000019', '10000000-0000-4000-8000-000000000001', 'Missing Role', 'tenant', 'active', null);

insert into public.access_scope_targets (
  id, tenant_id, access_scope_id, branch_id
)
values (
  'b1000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001'
);

insert into public.membership_role_assignments (
  id, tenant_id, membership_id, role_id, access_scope_id, assigned_at, unassigned_at
)
values
  ('b2000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', now() - interval '2 days', null),
  ('b2000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', now() - interval '3 days', now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', now() + interval '1 day', null),
  ('b2000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', now() - interval '1 day', null),
  ('b2000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', now() - interval '1 day', null),
  ('b2000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000010', now() - interval '1 day', null),
  ('b2000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000012', '90000000-0000-4000-8000-000000000012', 'b0000000-0000-4000-8000-000000000012', now() - interval '1 day', null),
  ('b2000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000013', '90000000-0000-4000-8000-000000000013', 'b0000000-0000-4000-8000-000000000013', now() - interval '1 day', null);

insert into public.devices (
  id, tenant_id, installation_id, device_type, display_name, status, activated_at, revoked_at
)
values
  ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'integration-active-device', 'pos', 'Active Device', 'active', now(), null),
  ('c0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'integration-revoked-device', 'pos', 'Revoked Device', 'revoked', null, now());

-- Controlled corrupt rows exercise fail-closed hydration. Constraint triggers are re-enabled after
-- insertion; the invalid rows exist only until this disposable stack is stopped without backup.
alter table public.membership_role_assignments disable trigger all;
insert into public.membership_role_assignments (
  id, tenant_id, membership_id, role_id, access_scope_id, assigned_at
)
values (
  'b2000000-0000-4000-8000-000000000009',
  '10000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000009',
  '90000000-0000-4000-8000-000000000099',
  'b0000000-0000-4000-8000-000000000019',
  now() - interval '1 day'
);
alter table public.membership_role_assignments enable trigger all;

alter table public.access_scope_targets disable trigger all;
insert into public.access_scope_targets (
  id, tenant_id, access_scope_id, scope_mode, branch_id
)
values (
  'b1000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000010',
  'explicit',
  '30000000-0000-4000-8000-000000000001'
);
alter table public.access_scope_targets enable trigger all;

alter table public.role_permissions disable trigger all;
insert into public.role_permissions (tenant_id, role_id, permission_id)
values (
  '10000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000011',
  'a0000000-0000-4000-8000-000000000099'
);
alter table public.role_permissions enable trigger all;

insert into public.membership_role_assignments (
  id, tenant_id, membership_id, role_id, access_scope_id, assigned_at
)
values (
  'b2000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000011',
  '90000000-0000-4000-8000-000000000011',
  'b0000000-0000-4000-8000-000000000011',
  now() - interval '1 day'
);

alter table public.access_scope_targets
  drop constraint access_scope_targets_exactly_one_resource;
insert into public.access_scope_targets (
  id, tenant_id, access_scope_id, brand_id, branch_id
)
values (
  'b1000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000012',
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001'
);
