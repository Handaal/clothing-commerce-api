-- Disposable Phase 2J catalog-management integration fixtures. Applied only by
-- scripts/test-catalog-management-integration.mjs after a local Supabase reset. Not a migration or seed.
--
-- Graph summary (tenant T1; foreign tenant T2 for cross-tenant denial):
--   T1 brand B1; T2 brand B2.
--   Identities (all members of T1 unless noted):
--     authorPublish -> role with catalog.author + catalog.publish, scoped to brand B1.
--     authorOnly    -> role with catalog.author only, scoped to brand B1 (proves publish is denied).
--     noCatalog     -> active membership with NO role assignment (proves author write is denied).
--   catalog.author / catalog.publish are seeded by migration; this fixture only creates the roles,
--   scopes, and assignments that grant them.

begin;

insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('ca7a1000-0000-4000-8000-000000000001', 'catalog-mgmt-t1', 'Catalog Mgmt T1', 'active', 'completed', 'USD'),
  ('ca7a1000-0000-4000-8000-000000000002', 'catalog-mgmt-t2', 'Catalog Mgmt T2', 'active', 'completed', 'USD');

insert into public.brands (id, tenant_id, code, display_name)
values
  ('ca7ab000-0000-4000-8000-0000000000b1', 'ca7a1000-0000-4000-8000-000000000001', 'brand-1', 'Brand One'),
  ('ca7ab000-0000-4000-8000-0000000000b2', 'ca7a1000-0000-4000-8000-000000000002', 'brand-2', 'Brand Two');

insert into public.user_identities (id, status)
values
  ('ca7a1d00-0000-4000-8000-0000000000a1', 'active'),
  ('ca7a1d00-0000-4000-8000-0000000000a2', 'active'),
  ('ca7a1d00-0000-4000-8000-0000000000a3', 'active');

insert into public.user_identity_provider_bindings (id, user_identity_id, provider, provider_subject)
values
  ('ca7a1b00-0000-4000-8000-0000000000a1', 'ca7a1d00-0000-4000-8000-0000000000a1', 'clerk', 'clerk-2j-authorpublish'),
  ('ca7a1b00-0000-4000-8000-0000000000a2', 'ca7a1d00-0000-4000-8000-0000000000a2', 'clerk', 'clerk-2j-author'),
  ('ca7a1b00-0000-4000-8000-0000000000a3', 'ca7a1d00-0000-4000-8000-0000000000a3', 'clerk', 'clerk-2j-nocatalog');

insert into public.memberships (id, tenant_id, user_identity_id, status, activated_at, suspended_at)
values
  ('ca7a1300-0000-4000-8000-0000000000a1', 'ca7a1000-0000-4000-8000-000000000001', 'ca7a1d00-0000-4000-8000-0000000000a1', 'active', now(), null),
  ('ca7a1300-0000-4000-8000-0000000000a2', 'ca7a1000-0000-4000-8000-000000000001', 'ca7a1d00-0000-4000-8000-0000000000a2', 'active', now(), null),
  ('ca7a1300-0000-4000-8000-0000000000a3', 'ca7a1000-0000-4000-8000-000000000001', 'ca7a1d00-0000-4000-8000-0000000000a3', 'active', now(), null);

insert into public.roles (id, tenant_id, name, status, is_protected)
values
  ('ca7a1400-0000-4000-8000-0000000000a1', 'ca7a1000-0000-4000-8000-000000000001', 'Catalog Author + Publisher', 'active', false),
  ('ca7a1400-0000-4000-8000-0000000000a2', 'ca7a1000-0000-4000-8000-000000000001', 'Catalog Author', 'active', false);

insert into public.role_permissions (tenant_id, role_id, permission_id)
values
  ('ca7a1000-0000-4000-8000-000000000001', 'ca7a1400-0000-4000-8000-0000000000a1', (select id from public.permissions where key = 'catalog.author')),
  ('ca7a1000-0000-4000-8000-000000000001', 'ca7a1400-0000-4000-8000-0000000000a1', (select id from public.permissions where key = 'catalog.publish')),
  ('ca7a1000-0000-4000-8000-000000000001', 'ca7a1400-0000-4000-8000-0000000000a2', (select id from public.permissions where key = 'catalog.author'));

insert into public.access_scopes (id, tenant_id, name, scope_mode, status)
values
  ('ca7a1500-0000-4000-8000-0000000000a1', 'ca7a1000-0000-4000-8000-000000000001', 'Brand One Only', 'explicit', 'active');

insert into public.access_scope_targets (id, tenant_id, access_scope_id, brand_id, branch_id, warehouse_id, inventory_location_id)
values
  ('ca7a1600-0000-4000-8000-0000000000a1', 'ca7a1000-0000-4000-8000-000000000001', 'ca7a1500-0000-4000-8000-0000000000a1', 'ca7ab000-0000-4000-8000-0000000000b1', null, null, null);

insert into public.membership_role_assignments (id, tenant_id, membership_id, role_id, access_scope_id, assigned_at)
values
  ('ca7a1700-0000-4000-8000-0000000000a1', 'ca7a1000-0000-4000-8000-000000000001', 'ca7a1300-0000-4000-8000-0000000000a1', 'ca7a1400-0000-4000-8000-0000000000a1', 'ca7a1500-0000-4000-8000-0000000000a1', now() - interval '1 day'),
  ('ca7a1700-0000-4000-8000-0000000000a2', 'ca7a1000-0000-4000-8000-000000000001', 'ca7a1300-0000-4000-8000-0000000000a2', 'ca7a1400-0000-4000-8000-0000000000a2', 'ca7a1500-0000-4000-8000-0000000000a1', now() - interval '1 day');

commit;
