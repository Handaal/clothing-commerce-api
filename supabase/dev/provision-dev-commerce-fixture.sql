-- Development-only canonical commerce fixture for Phase 2F-B Admin Mobile real-runtime acceptance.
--
-- This script is NOT a migration and NOT a production seed. It is applied ONLY by
-- scripts/provision-dev-commerce-fixture.mjs against the LOCAL disposable Supabase Postgres container.
-- It seeds a small, deterministic, representative commerce graph (brand -> branch -> inventory
-- location -> products/variants/options/prices -> opening inventory -> one online order -> one partial
-- fulfillment) into the EXISTING dev-local tenant so the Admin Mobile Products (and future Inventory /
-- Orders / Fulfillment) read slices have real data to render.
--
-- It COMPLEMENTS scripts/provision-dev-identity.mjs and never replaces it: identity provisioning creates
-- and authorizes the dev-local tenant; this fixture populates that tenant's catalog/inventory/sales. It
-- therefore REQUIRES the dev-local tenant to already exist and FAILS CLEARLY if it does not.
--
-- Safety: it grants NO permission, creates NO role/membership/scope, adds NO owner/manager bypass, and
-- introduces NO new database function. All catalog rows are inserted idempotently (deterministic ids,
-- ON CONFLICT DO NOTHING on natural keys); inventory, the order, and the fulfillment are written ONLY
-- through the existing sanctioned domain functions (inventory_private.record_operation,
-- orders_private.create_order, fulfillments_private.record_fulfillment) with stable idempotency keys, so
-- re-running changes nothing. The whole graph commits together or not at all.

\set ON_ERROR_STOP on

begin;

create temporary table dev_fixture_result (
  sort_key integer primary key,
  entity text not null,
  id uuid not null,
  created boolean not null
) on commit preserve rows;

do $$
declare
  -- Deterministic fixture identifiers. Stable across runs so tests and the Admin Mobile detail route
  -- can rely on a known product id. On a fresh dev-local these exact ids are used; if a row already
  -- exists under the same natural key its existing id is reused (idempotent).
  c_brand      constant uuid := 'b0a11d00-0000-4000-8000-000000000001';
  c_branch     constant uuid := 'b7a11c00-0000-4000-8000-000000000001';
  c_location   constant uuid := '10ca7100-0000-4000-8000-000000000001';
  c_location2  constant uuid := '10ca7100-0000-4000-8000-000000000002';
  c_register   constant uuid := 'ae6157e0-0000-4000-8000-000000000001';
  c_offline_policy constant uuid := '0ff11e00-0000-4000-8000-000000000001';
  c_product1   constant uuid := '90000000-0000-4000-8000-000000000001';
  c_product2   constant uuid := '90000000-0000-4000-8000-000000000002';
  c_option     constant uuid := '0f710000-0000-4000-8000-000000000001';
  c_value_m    constant uuid := '0f710000-0000-4000-8000-0000000000a1';
  c_value_l    constant uuid := '0f710000-0000-4000-8000-0000000000a2';
  c_variant_m  constant uuid := '71a71a00-0000-4000-8000-000000000001';
  c_variant_l  constant uuid := '71a71a00-0000-4000-8000-000000000002';
  c_variant_2  constant uuid := '71a71a00-0000-4000-8000-000000000003';

  v_tenant_id uuid;
  v_status text;
  v_brand_id uuid;
  v_branch_id uuid;
  v_location_id uuid;
  v_location2_id uuid;
  v_register_id uuid;
  v_product1_id uuid;
  v_product2_id uuid;
  v_option_id uuid;
  v_value_m_id uuid;
  v_value_l_id uuid;
  v_variant_m_id uuid;
  v_variant_l_id uuid;
  v_variant_2_id uuid;

  v_inventory_operation_id uuid;
  v_order_id uuid;
  v_order_created boolean := false;
  v_line_m_id uuid;
  v_line_l_id uuid;
  v_fulfillment_id uuid;
begin
  -- 0. The dev-local tenant MUST already exist (created by the identity provisioning utility). This
  --    fixture never creates a tenant; a missing dev-local means run `pnpm dev:provision-identity` first.
  select id, status into v_tenant_id, v_status
  from public.tenants
  where normalized_slug = 'dev-local';
  if not found then
    raise exception
      'DEV_FIXTURE: tenant dev-local not found. Provision the dev identity first (COMMERCE_DEV_PROVISIONING=1 pnpm dev:provision-identity -- --clerk-subject <id>).';
  end if;
  if v_status <> 'active' then
    raise exception 'DEV_FIXTURE: tenant dev-local exists with status=% (expected active).', v_status;
  end if;

  -- 1. Brand: one active development trading identity.
  insert into public.brands (id, tenant_id, code, display_name, status)
  values (c_brand, v_tenant_id, 'DEV-BRAND', 'Dev Threads', 'active')
  on conflict (tenant_id, normalized_code) do nothing;
  select id into v_brand_id from public.brands
  where tenant_id = v_tenant_id and normalized_code = 'dev-brand';

  -- 2a. Branch: one active retail location (never a warehouse).
  insert into public.branches (id, tenant_id, code, display_name, timezone, status, is_fulfillment_enabled)
  values (c_branch, v_tenant_id, 'DEV-BRANCH', 'Dev Flagship', 'UTC', 'active', true)
  on conflict (tenant_id, normalized_code) do nothing;
  select id into v_branch_id from public.branches
  where tenant_id = v_tenant_id and normalized_code = 'dev-branch';

  -- The branch must explicitly operate the fixture brand. POS sale creation validates this relationship
  -- server-side after resolving the register and each variant's product brand.
  insert into public.branch_brands (tenant_id, branch_id, brand_id)
  values (v_tenant_id, v_branch_id, v_brand_id)
  on conflict (tenant_id, branch_id, brand_id) do nothing;

  -- 2b. Inventory location 1: one sellable, fulfillment-enabled branch location (branch parent, not a
  --     warehouse). Fulfillment issue requires active + is_fulfillment_enabled. The three write-capability
  --     flags are enabled so Phase 2G management writes (receive, transfer origin/destination) are usable
  --     against it; adjust needs no capability flag.
  insert into public.inventory_locations (
    id, tenant_id, branch_id, code, display_name, location_type, status, is_sellable, is_fulfillment_enabled,
    is_receiving_enabled, is_transfer_origin_enabled, is_transfer_destination_enabled
  )
  values (
    c_location, v_tenant_id, v_branch_id, 'DEV-LOC-1', 'Dev Flagship Stockroom', 'stockroom',
    'active', true, true, true, true, true
  )
  on conflict (tenant_id, normalized_code) do nothing;
  select id into v_location_id from public.inventory_locations
  where tenant_id = v_tenant_id and normalized_code = 'dev-loc-1';

  -- 2c. Inventory location 2: a second active location so Transfer has a distinct destination. It starts
  --     with NO stock (a valid empty balance in this domain) and carries the same write-capability flags,
  --     so it can serve as a transfer destination (and, if needed, a receive target or transfer source).
  --     It is NOT fulfillment-enabled: it only exists for the inventory write slice, not order execution.
  insert into public.inventory_locations (
    id, tenant_id, branch_id, code, display_name, location_type, status, is_sellable, is_fulfillment_enabled,
    is_receiving_enabled, is_transfer_origin_enabled, is_transfer_destination_enabled
  )
  values (
    c_location2, v_tenant_id, v_branch_id, 'DEV-LOC-2', 'Dev Overflow Stockroom', 'stockroom',
    'active', false, false, true, true, true
  )
  on conflict (tenant_id, normalized_code) do nothing;
  select id into v_location2_id from public.inventory_locations
  where tenant_id = v_tenant_id and normalized_code = 'dev-loc-2';

  -- Idempotent upgrade path: if either location already existed from an earlier fixture version without
  -- the write-capability flags, force them on. Setting a boolean to the same value is a stable no-op on
  -- re-run and never touches inventory balances.
  update public.inventory_locations
  set is_receiving_enabled = true,
      is_transfer_origin_enabled = true,
      is_transfer_destination_enabled = true
  where tenant_id = v_tenant_id
    and id in (v_location_id, v_location2_id)
    and not (
      is_receiving_enabled
      and is_transfer_origin_enabled
      and is_transfer_destination_enabled
    );

  -- 2d. Active deterministic register. Branch, fulfillment location, and currency are server-trusted
  --     inputs to Connected POS Sale V1; clients submit only this register id.
  insert into public.registers (
    id, tenant_id, branch_id, code, display_name, status,
    default_inventory_location_id, selling_currency
  ) values (
    c_register, v_tenant_id, v_branch_id, 'DEV-REG-1', 'Dev Front Register', 'active',
    v_location_id, 'EGP'
  ) on conflict (tenant_id, branch_id, normalized_code) do nothing;
  select id into v_register_id from public.registers
  where tenant_id = v_tenant_id and branch_id = v_branch_id and normalized_code = 'dev-reg-1';

  -- Phase 2I development-only limits. Enrollment still happens through the authenticated API so this
  -- fixture never stores a public/private key or invents a device identity.
  insert into public.offline_pos_policies (
    id, tenant_id, register_id, enabled, operator_lease_seconds, catalog_grant_seconds,
    max_sale_amount_minor, max_cumulative_exposure_minor, max_quantity_per_line,
    max_pending_offline_sales, max_offline_credit_exposure_minor
  ) values (
    c_offline_policy, v_tenant_id, v_register_id, true, 43200, 86400,
    100000, 500000, 20, 50, 300000
  ) on conflict (tenant_id, register_id) do nothing;

  -- 3. Product 1: an ACTIVE style with a Size option (M, L) and two active variants.
  insert into public.products (id, tenant_id, brand_id, name, slug, style_code, description, status)
  values (
    c_product1, v_tenant_id, v_brand_id, 'Dev Linen Shirt', 'dev-linen-shirt', 'DEV-LS-001',
    'Deterministic development fixture product.', 'active'
  )
  on conflict (tenant_id, normalized_slug) do nothing;
  select id into v_product1_id from public.products
  where tenant_id = v_tenant_id and normalized_slug = 'dev-linen-shirt';

  insert into public.product_options (id, tenant_id, product_id, name, position, status)
  values (c_option, v_tenant_id, v_product1_id, 'Size', 0, 'active')
  on conflict (tenant_id, product_id, normalized_name) do nothing;
  select id into v_option_id from public.product_options
  where tenant_id = v_tenant_id and product_id = v_product1_id and normalized_name = 'size';

  insert into public.product_option_values (id, tenant_id, product_id, option_id, display_value, position, status)
  values (c_value_m, v_tenant_id, v_product1_id, v_option_id, 'M', 0, 'active')
  on conflict (tenant_id, option_id, normalized_value) do nothing;
  select id into v_value_m_id from public.product_option_values
  where tenant_id = v_tenant_id and option_id = v_option_id and normalized_value = 'm';

  insert into public.product_option_values (id, tenant_id, product_id, option_id, display_value, position, status)
  values (c_value_l, v_tenant_id, v_product1_id, v_option_id, 'L', 1, 'active')
  on conflict (tenant_id, option_id, normalized_value) do nothing;
  select id into v_value_l_id from public.product_option_values
  where tenant_id = v_tenant_id and option_id = v_option_id and normalized_value = 'l';

  -- Variants. option_signature must equal the selected option value's id (single-option product); the
  -- deferred canonical-signature trigger validates this against variant_option_values at commit.
  insert into public.product_variants (
    id, tenant_id, product_id, sku, display_name, option_signature, status
  )
  values (
    c_variant_m, v_tenant_id, v_product1_id, 'DEV-LS-001-M', 'Medium', v_value_m_id::text, 'active'
  )
  on conflict (tenant_id, normalized_sku) do nothing;
  select id into v_variant_m_id from public.product_variants
  where tenant_id = v_tenant_id and normalized_sku = 'dev-ls-001-m';

  insert into public.product_variants (
    id, tenant_id, product_id, sku, display_name, option_signature, status
  )
  values (
    c_variant_l, v_tenant_id, v_product1_id, 'DEV-LS-001-L', 'Large', v_value_l_id::text, 'active'
  )
  on conflict (tenant_id, normalized_sku) do nothing;
  select id into v_variant_l_id from public.product_variants
  where tenant_id = v_tenant_id and normalized_sku = 'dev-ls-001-l';

  insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
  values (v_tenant_id, v_product1_id, v_variant_m_id, v_option_id, v_value_m_id)
  on conflict (tenant_id, variant_id, option_id) do nothing;
  insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
  values (v_tenant_id, v_product1_id, v_variant_l_id, v_option_id, v_value_l_id)
  on conflict (tenant_id, variant_id, option_id) do nothing;

  insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor, status)
  values (v_tenant_id, v_variant_m_id, 'EGP', 2599, 'active')
  on conflict (tenant_id, variant_id, currency) where status = 'active' do nothing;
  insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor, status)
  values (v_tenant_id, v_variant_l_id, 'EGP', 2599, 'active')
  on conflict (tenant_id, variant_id, currency) where status = 'active' do nothing;

  -- 4. Product 2: a DRAFT style (different legitimate status) so list status rendering is visible. One
  --    optionless variant with a price so its detail view has content.
  insert into public.products (id, tenant_id, brand_id, name, slug, style_code, description, status)
  values (
    c_product2, v_tenant_id, v_brand_id, 'Dev Canvas Tote', 'dev-canvas-tote', 'DEV-CT-001',
    'Deterministic development fixture product (draft).', 'draft'
  )
  on conflict (tenant_id, normalized_slug) do nothing;
  select id into v_product2_id from public.products
  where tenant_id = v_tenant_id and normalized_slug = 'dev-canvas-tote';

  insert into public.product_variants (
    id, tenant_id, product_id, sku, display_name, option_signature, status
  )
  values (
    c_variant_2, v_tenant_id, v_product2_id, 'DEV-CT-001', 'One Size', 'default', 'active'
  )
  on conflict (tenant_id, normalized_sku) do nothing;
  select id into v_variant_2_id from public.product_variants
  where tenant_id = v_tenant_id and normalized_sku = 'dev-ct-001';

  insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor, status)
  values (v_tenant_id, v_variant_2_id, 'EGP', 1899, 'active')
  on conflict (tenant_id, variant_id, currency) where status = 'active' do nothing;

  -- 5. Opening inventory via the SOLE sanctioned inventory write path. A stable idempotency key makes a
  --    re-run a no-op replay (it never re-adds stock).
  select inventory_private.record_operation(
    v_tenant_id,
    'opening',
    jsonb_build_array(
      jsonb_build_object('variant_id', v_variant_m_id, 'inventory_location_id', v_location_id, 'quantity_delta', 25),
      jsonb_build_object('variant_id', v_variant_l_id, 'inventory_location_id', v_location_id, 'quantity_delta', 40),
      jsonb_build_object('variant_id', v_variant_2_id, 'inventory_location_id', v_location_id, 'quantity_delta', 12)
    ),
    null,
    'dev-fixture:inventory-opening:v1',
    null,
    'Dev commerce fixture opening stock.'
  )
  into v_inventory_operation_id;

  -- 6. One deterministic ONLINE order (no branch/register) via the sole sanctioned order path. Stable
  --    idempotency key => a re-run replays to the same order and inserts nothing.
  select orders_private.create_order(
    v_tenant_id,
    'online',
    'EGP',
    v_brand_id,
    null,
    null,
    null,
    'dev-fixture:order:v1',
    now(),
    'Dev commerce fixture order.',
    jsonb_build_array(
      jsonb_build_object(
        'variant_id', v_variant_m_id, 'product_id', v_product1_id, 'quantity', 3,
        'unit_price_minor', 2599, 'product_name', 'Dev Linen Shirt', 'variant_name', 'Medium',
        'sku', 'DEV-LS-001-M', 'option_summary', 'Size: M'
      ),
      jsonb_build_object(
        'variant_id', v_variant_l_id, 'product_id', v_product1_id, 'quantity', 2,
        'unit_price_minor', 2599, 'product_name', 'Dev Linen Shirt', 'variant_name', 'Large',
        'sku', 'DEV-LS-001-L', 'option_summary', 'Size: L'
      )
    )
  )
  into v_order_id;

  select id into v_line_m_id from public.order_lines
  where tenant_id = v_tenant_id and order_id = v_order_id and line_number = 1;
  select id into v_line_l_id from public.order_lines
  where tenant_id = v_tenant_id and order_id = v_order_id and line_number = 2;

  -- 7. One deterministic PARTIAL fulfillment via the sole sanctioned fulfillment path: line 1 fully
  --    (3/3), line 2 partially (1/2) => overall partially_fulfilled. This issues stock at the location
  --    (deducting 3 + 1), so fulfillment progress AND a stock movement both exist for later read slices.
  --    Stable idempotency key => a re-run replays and deducts nothing further.
  select fulfillment_id
  into v_fulfillment_id
  from fulfillments_private.record_fulfillment(
    v_tenant_id,
    v_order_id,
    v_location_id,
    null,
    'dev-fixture:fulfillment:v1',
    now(),
    jsonb_build_array(
      jsonb_build_object('order_line_id', v_line_m_id, 'quantity', 3),
      jsonb_build_object('order_line_id', v_line_l_id, 'quantity', 1)
    )
  );

  insert into dev_fixture_result (sort_key, entity, id, created)
  values
    (1, 'tenant', v_tenant_id, false),
    (2, 'brand', v_brand_id, false),
    (3, 'branch', v_branch_id, false),
    (4, 'inventory_location', v_location_id, false),
    (5, 'inventory_location_2', v_location2_id, false),
    (6, 'register', v_register_id, false),
    (7, 'product_active', v_product1_id, false),
    (8, 'product_draft', v_product2_id, false),
    (9, 'variant_m', v_variant_m_id, false),
    (10, 'variant_l', v_variant_l_id, false),
    (11, 'variant_tote', v_variant_2_id, false),
    (12, 'inventory_operation', v_inventory_operation_id, false),
    (13, 'order', v_order_id, false),
    (14, 'fulfillment', v_fulfillment_id, false);
end
$$;

commit;

\pset border 2
\pset title 'Dev commerce fixture (deterministic ids)'
select entity as "Entity", id as "Id"
from dev_fixture_result
order by sort_key;
