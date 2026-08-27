-- Wrap the whole fixture in one transaction so the catalog's DEFERRABLE option-signature constraint
-- evaluates against the complete variant + selected-option-value state at COMMIT (psql otherwise
-- autocommits each statement, firing the deferred trigger before the option values are inserted).
begin;

-- Disposable fixtures for the Phase 2D orders integration suite. Tenant A carries an active brand,
-- product, an option-bearing variant with a USD price, an active branch/register, and branch_brands
-- eligibility. A second brand (not carried by the branch), an inactive register, a register in an
-- inactive branch, and a tenant B variant support the negative/cross-tenant cases. The integration
-- test builds authorization contexts in code and uses the real authorization service (for
-- resource-tenant lookup) and the real orders repository (for the sanctioned functions).

insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('10000000-0000-4000-8000-000000000001', 'ord-int-a', 'Orders Integration A', 'active', 'completed', 'USD'),
  ('10000000-0000-4000-8000-000000000002', 'ord-int-b', 'Orders Integration B', 'active', 'completed', 'USD');

-- Two distinct identities/memberships in tenant A so the cancel write-once test can prove a SECOND
-- actor cannot overwrite the first cancellation's actor. (memberships_tenant_identity_unique forbids
-- two memberships for one identity in a tenant, so a second identity is required.)
insert into public.user_identities (id, display_name, primary_email)
values
  ('70000000-0000-4000-8000-000000000001', 'Integration User', 'ord-int@example.test'),
  ('70000000-0000-4000-8000-000000000002', 'Integration User Two', 'ord-int-2@example.test');

insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
values
  ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now()),
  ('71000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002', 'active', now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'AOTHER', 'Brand Other'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'B', 'Brand B');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Classic Tee', 'classic-tee', 'active'),
  ('30000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Price Test', 'price-test', 'active'),
  ('30000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Archive Test', 'archive-test', 'active'),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'Other Hoodie', 'other-hoodie', 'active'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Prod B', 'prod-b', 'active');

insert into public.product_options (id, tenant_id, product_id, name, position)
values
  ('a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Size', 0),
  ('a1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Color', 1);

insert into public.product_option_values (id, tenant_id, product_id, option_id, display_value, position)
values
  ('a2000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'M', 0),
  ('a2000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'Black', 1);

-- option_signature is the selected value UUIDs ordered by option UUID (see catalog conventions).
insert into public.product_variants (id, tenant_id, product_id, sku, display_name, option_signature, status)
values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'TEE-M-BLK', 'Classic Tee - M / Black', 'a2000000-0000-4000-8000-000000000001,a2000000-0000-4000-8000-000000000002', 'active'),
  ('60000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-00000000000b', 'TEE-PRICE', 'Classic Tee - price test', 'default', 'active'),
  ('60000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-00000000000c', 'TEE-ARCH', 'Classic Tee - archive test', 'default', 'active'),
  ('60000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'HOOD-1', null, 'default', 'active'),
  ('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'B-1', null, 'default', 'active');

insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000002');

insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor)
values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'USD', 2599),
  ('40000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-00000000000b', 'USD', 1999),
  ('40000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-00000000000c', 'USD', 1499),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000003', 'USD', 4999);

insert into public.branches (id, tenant_id, code, display_name, timezone, status)
values
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRA', 'Branch A', 'UTC', 'active'),
  ('b0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'BRINACT', 'Branch Inactive', 'UTC', 'inactive'),
  ('b0000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000002', 'BRB', 'Branch B', 'UTC', 'active');

insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type)
values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A', 'Floor A', 'sales_floor'),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 'LOC-INA', 'Floor Inactive', 'sales_floor');

insert into public.registers (id, tenant_id, branch_id, code, display_name, status, default_inventory_location_id)
values
  ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'REG1', 'Register 1', 'active', '50000000-0000-4000-8000-000000000001'),
  ('c0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'REG2', 'Register 2', 'inactive', null),
  ('c0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 'REG3', 'Register 3', 'active', '50000000-0000-4000-8000-000000000002'),
  ('c0000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'REG4', 'Register 4', 'active', '50000000-0000-4000-8000-000000000001');

insert into public.branch_brands (tenant_id, branch_id, brand_id)
values ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');

commit;
