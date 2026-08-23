-- Disposable fixtures for the Phase 2C inventory operations integration suite. Two tenants, an active
-- variant and capability-flagged locations in tenant A, and one location in tenant B for the
-- cross-tenant rejection case. The integration test builds the authorization context in code and uses
-- the real authorization service (for resource-tenant lookup) and the real inventory repository (for
-- the sanctioned ledger functions).

insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('10000000-0000-4000-8000-000000000001', 'inv-int-a', 'Inventory Integration A', 'active', 'completed', 'USD'),
  ('10000000-0000-4000-8000-000000000002', 'inv-int-b', 'Inventory Integration B', 'active', 'completed', 'EUR');

insert into public.user_identities (id, display_name, primary_email)
values ('70000000-0000-4000-8000-000000000001', 'Integration User', 'inv-int@example.test');

insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
values ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'B', 'Brand B');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Prod A', 'prod-a', 'active'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Prod B', 'prod-b', 'active');

insert into public.product_variants (id, tenant_id, product_id, sku, status)
values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'SKU-A', 'active'),
  ('60000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'SKU-B', 'active');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRA', 'Branch A', 'UTC'),
  ('b0000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000002', 'BRB', 'Branch B', 'UTC');

insert into public.inventory_locations (
  id, tenant_id, branch_id, code, display_name, location_type,
  is_receiving_enabled, is_transfer_origin_enabled, is_transfer_destination_enabled
)
-- Each integration test owns a distinct tenant-A location so no test depends on another's state.
values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A', 'Floor A', 'sales_floor', true, true, true),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A2', 'Stock A2', 'stockroom', true, true, true),
  ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A3', 'Floor A3', 'sales_floor', true, true, true),
  ('50000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A4', 'Floor A4', 'sales_floor', true, true, true),
  ('50000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A5', 'Floor A5', 'sales_floor', true, true, true),
  ('50000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A6', 'Floor A6', 'sales_floor', true, true, true),
  ('50000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A7', 'Floor A7', 'sales_floor', true, true, true),
  ('50000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b', 'LOC-B', 'Floor B', 'sales_floor', true, true, true);
