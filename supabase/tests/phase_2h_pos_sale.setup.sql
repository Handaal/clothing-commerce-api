-- Disposable Connected POS Sale V1 HTTP integration fixture.
begin;

insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('2a000001-0000-4000-8000-000000000001', 'pos-test', 'POS Test', 'active', 'completed', 'USD'),
  ('2a000001-0000-4000-8000-000000000002', 'pos-foreign', 'POS Foreign', 'active', 'completed', 'USD');

insert into public.brands (id, tenant_id, code, display_name)
values ('2a000002-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', 'pos-brand', 'POS Brand');

insert into public.branches (id, tenant_id, code, display_name, timezone, status)
values
  ('2a000003-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', 'main', 'Main Branch', 'UTC', 'active'),
  ('2a000003-0000-4000-8000-000000000002', '2a000001-0000-4000-8000-000000000001', 'other', 'Other Branch', 'UTC', 'active');

insert into public.branch_brands (tenant_id, branch_id, brand_id)
values ('2a000001-0000-4000-8000-000000000001', '2a000003-0000-4000-8000-000000000001', '2a000002-0000-4000-8000-000000000001');

insert into public.inventory_locations
  (id, tenant_id, branch_id, code, display_name, location_type, status, is_fulfillment_enabled)
values
  ('2a000004-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', '2a000003-0000-4000-8000-000000000001', 'sell', 'Selling Floor', 'store', 'active', true),
  ('2a000004-0000-4000-8000-000000000002', '2a000001-0000-4000-8000-000000000001', '2a000003-0000-4000-8000-000000000001', 'other', 'Other Location', 'store', 'active', true);

insert into public.registers
  (id, tenant_id, branch_id, code, display_name, status, default_inventory_location_id, selling_currency)
values
  ('2a000005-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', '2a000003-0000-4000-8000-000000000001', 'front', 'Front Register', 'active', '2a000004-0000-4000-8000-000000000001', 'USD'),
  ('2a000005-0000-4000-8000-000000000002', '2a000001-0000-4000-8000-000000000001', '2a000003-0000-4000-8000-000000000001', 'closed', 'Closed Register', 'inactive', null, 'USD');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values ('2a000006-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', '2a000002-0000-4000-8000-000000000001', 'POS Tee', 'pos-tee', 'active');

insert into public.product_variants (id, tenant_id, product_id, sku, status)
values ('2a000007-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', '2a000006-0000-4000-8000-000000000001', 'POS-TEE', 'active');

insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor, status)
values ('2a000008-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', '2a000007-0000-4000-8000-000000000001', 'USD', 2500, 'active');

-- Identities: full cashier, missing-payment cashier, wrong-branch cashier, wrong-location cashier.
insert into public.user_identities (id, status)
values
  ('2a000010-0000-4000-8000-000000000001', 'active'),
  ('2a000010-0000-4000-8000-000000000002', 'active'),
  ('2a000010-0000-4000-8000-000000000003', 'active'),
  ('2a000010-0000-4000-8000-000000000004', 'active');

insert into public.user_identity_provider_bindings
  (id, user_identity_id, provider, provider_subject)
values
  ('2a000011-0000-4000-8000-000000000001', '2a000010-0000-4000-8000-000000000001', 'clerk', 'pos-full'),
  ('2a000011-0000-4000-8000-000000000002', '2a000010-0000-4000-8000-000000000002', 'clerk', 'pos-no-payment'),
  ('2a000011-0000-4000-8000-000000000003', '2a000010-0000-4000-8000-000000000003', 'clerk', 'pos-wrong-branch'),
  ('2a000011-0000-4000-8000-000000000004', '2a000010-0000-4000-8000-000000000004', 'clerk', 'pos-wrong-location');

insert into public.memberships (id, tenant_id, user_identity_id, status, activated_at)
values
  ('2a000012-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', '2a000010-0000-4000-8000-000000000001', 'active', now()),
  ('2a000012-0000-4000-8000-000000000002', '2a000001-0000-4000-8000-000000000001', '2a000010-0000-4000-8000-000000000002', 'active', now()),
  ('2a000012-0000-4000-8000-000000000003', '2a000001-0000-4000-8000-000000000001', '2a000010-0000-4000-8000-000000000003', 'active', now()),
  ('2a000012-0000-4000-8000-000000000004', '2a000001-0000-4000-8000-000000000001', '2a000010-0000-4000-8000-000000000004', 'active', now());

insert into public.roles (id, tenant_id, name, status, is_protected)
values
  ('2a000013-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', 'POS Full', 'active', false),
  ('2a000013-0000-4000-8000-000000000002', '2a000001-0000-4000-8000-000000000001', 'POS No Payment', 'active', false),
  ('2a000013-0000-4000-8000-000000000003', '2a000001-0000-4000-8000-000000000001', 'POS Commercial', 'active', false),
  ('2a000013-0000-4000-8000-000000000004', '2a000001-0000-4000-8000-000000000001', 'POS Custody', 'active', false);

insert into public.role_permissions (tenant_id, role_id, permission_id)
select '2a000001-0000-4000-8000-000000000001'::uuid, '2a000013-0000-4000-8000-000000000001'::uuid, id
from public.permissions where key in ('orders.create','orders.fulfill','orders.read','inventory.issue','payments.capture')
union all
select '2a000001-0000-4000-8000-000000000001'::uuid, '2a000013-0000-4000-8000-000000000002'::uuid, id
from public.permissions where key in ('orders.create','orders.fulfill','orders.read','inventory.issue')
union all
select '2a000001-0000-4000-8000-000000000001'::uuid, '2a000013-0000-4000-8000-000000000003'::uuid, id
from public.permissions where key in ('orders.create','orders.fulfill','orders.read','payments.capture')
union all
select '2a000001-0000-4000-8000-000000000001'::uuid, '2a000013-0000-4000-8000-000000000004'::uuid, id
from public.permissions where key = 'inventory.issue';

insert into public.access_scopes (id, tenant_id, name, scope_mode, status)
values
  ('2a000014-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', 'POS Tenant', 'tenant', 'active'),
  ('2a000014-0000-4000-8000-000000000002', '2a000001-0000-4000-8000-000000000001', 'Other Branch', 'explicit', 'active'),
  ('2a000014-0000-4000-8000-000000000003', '2a000001-0000-4000-8000-000000000001', 'Main Branch', 'explicit', 'active'),
  ('2a000014-0000-4000-8000-000000000004', '2a000001-0000-4000-8000-000000000001', 'Other Location', 'explicit', 'active');

insert into public.access_scope_targets
  (id, tenant_id, access_scope_id, branch_id, inventory_location_id)
values
  ('2a000015-0000-4000-8000-000000000002', '2a000001-0000-4000-8000-000000000001', '2a000014-0000-4000-8000-000000000002', '2a000003-0000-4000-8000-000000000002', null),
  ('2a000015-0000-4000-8000-000000000003', '2a000001-0000-4000-8000-000000000001', '2a000014-0000-4000-8000-000000000003', '2a000003-0000-4000-8000-000000000001', null),
  ('2a000015-0000-4000-8000-000000000004', '2a000001-0000-4000-8000-000000000001', '2a000014-0000-4000-8000-000000000004', null, '2a000004-0000-4000-8000-000000000002');

insert into public.membership_role_assignments
  (id, tenant_id, membership_id, role_id, access_scope_id, assigned_at)
values
  ('2a000016-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', '2a000013-0000-4000-8000-000000000001', '2a000014-0000-4000-8000-000000000001', now()),
  ('2a000016-0000-4000-8000-000000000002', '2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000002', '2a000013-0000-4000-8000-000000000002', '2a000014-0000-4000-8000-000000000001', now()),
  ('2a000016-0000-4000-8000-000000000003', '2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000003', '2a000013-0000-4000-8000-000000000001', '2a000014-0000-4000-8000-000000000002', now()),
  ('2a000016-0000-4000-8000-000000000004', '2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000004', '2a000013-0000-4000-8000-000000000003', '2a000014-0000-4000-8000-000000000003', now()),
  ('2a000016-0000-4000-8000-000000000005', '2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000004', '2a000013-0000-4000-8000-000000000004', '2a000014-0000-4000-8000-000000000004', now());

select inventory_private.record_opening(
  '2a000001-0000-4000-8000-000000000001',
  '2a000007-0000-4000-8000-000000000001',
  '2a000004-0000-4000-8000-000000000001',
  10
);

commit;
