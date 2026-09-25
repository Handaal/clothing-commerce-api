\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(condition boolean, label text)
returns void language plpgsql as $function$
begin
  if condition is distinct from true then raise exception 'assertion failed: %', label; end if;
end;
$function$;

create or replace function pg_temp.assert_raises(statement text, expected_state text, label text)
returns void language plpgsql as $function$
declare actual_state text;
begin
  begin execute statement;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate;
    if actual_state = expected_state then return; end if;
    raise exception 'assertion failed: %, expected SQLSTATE %, received %', label, expected_state, actual_state;
  end;
  raise exception 'assertion failed: %, expected SQLSTATE %, but statement succeeded', label, expected_state;
end;
$function$;

create or replace function pg_temp.ny(p text) returns timestamptz language sql as $function$
  select (p::timestamp) at time zone 'America/New_York'
$function$;

-- ============================ seed (mirrors the Phase 2Q-A reporting fixture) ============================
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency, default_timezone) values
  ('a0000000-0000-4000-8000-000000000001','rep-a','Report A','active','completed','USD','America/New_York'),
  ('a0000000-0000-4000-8000-000000000002','rep-b','Report B','active','completed','USD','America/New_York');

insert into public.user_identities (id, display_name, primary_email) values
  ('71000000-0000-4000-8000-000000000001','Olivia Operator','op@example.test');
insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at) values
  ('72000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','active',now(),now());

insert into public.brands (id, tenant_id, code, display_name) values
  ('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','A','Brand A'),
  ('b0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000001','B','Brand B');

insert into public.branches (id, tenant_id, code, display_name, timezone) values
  ('e0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','BR1','Main Branch','America/New_York');
insert into public.registers (id, tenant_id, branch_id, code, display_name, status) values
  ('f0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-00000000000a','R1','Register 1','inactive');

-- A product name that begins with '=' proves the CSV neutralization is exercised downstream (the RPC
-- returns it verbatim; the CSV writer neutralizes it). The DB layer never mutates it.
insert into public.products (id, tenant_id, brand_id, name, slug, status) values
  ('c0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000a','=Tee','tee','active'),
  ('c0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000a','Pants','pants','active'),
  ('c0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000b','Cap','cap','active');
insert into public.product_variants (id, tenant_id, product_id, sku, status) values
  ('d0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','TEE-M','active'),
  ('d0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002','PANTS-1','active'),
  ('d0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-00000000000b','CAP-1','active');

insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type, is_sellable) values
  ('e1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-00000000000a','L1','Sales Floor','branch',true),
  ('e1000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-00000000000a','L2','Back Room','branch',false);
select set_config('inventory_private.allow_balance_write', 'on', true);
insert into public.inventory_balances (tenant_id, variant_id, inventory_location_id, on_hand_quantity, version) values
  ('a0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',10,0),
  ('a0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',5,0);

insert into public.suppliers (id, tenant_id, name, code) values
  ('51000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Supplier One','SUP1');

insert into public.promotions (id, tenant_id, name, benefit_type, benefit_percent_bp, target_type, activation_type, status) values
  ('80000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Summer Sale','percentage',2000,'order','code','active');

-- O1: discounted USD POS order, TEE-M x2 gross 5198 discount 1000 net 4198.
insert into public.orders (id, tenant_id, brand_id, branch_id, register_id, order_number, channel, status, currency,
    total_minor, gross_subtotal_minor, discount_total_minor, actor_membership_id, placed_at, created_at) values
  ('90000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000a',
   'e0000000-0000-4000-8000-00000000000a','f0000000-0000-4000-8000-00000000000a','1001','pos','placed','USD',
   4198,5198,1000,'72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-15 12:00'),pg_temp.ny('2026-06-15 12:00'));
insert into public.order_lines (id, tenant_id, order_id, brand_id, product_id, variant_id, line_number, quantity,
    unit_price_minor, line_total_minor, product_name_snapshot, sku_snapshot) values
  ('91000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-00000000000a','c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',
   1,2,2599,5198,'=Tee','TEE-M');
insert into public.order_line_adjustments (id, tenant_id, order_id, order_line_id, promotion_id, discount_minor) values
  ('93000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001',1000);
insert into public.payments (id, tenant_id, order_id, method, status, currency, amount_minor, cash_received_minor,
    change_minor, captured_by_membership_id, idempotency_key, payload_fingerprint) values
  ('95000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   'cash','captured','USD',4198,5000,802,'72000000-0000-4000-8000-00000000000a','pay-o1','fp-o1');

-- O2: EUR online order, CAP-1 x2 gross 3000. A different currency — never combined with USD.
insert into public.orders (id, tenant_id, brand_id, order_number, channel, status, currency,
    total_minor, gross_subtotal_minor, discount_total_minor, placed_at, created_at) values
  ('90000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000b',
   '1002','online','placed','EUR',3000,3000,0,pg_temp.ny('2026-06-16 12:00'),pg_temp.ny('2026-06-16 12:00'));
insert into public.order_lines (id, tenant_id, order_id, brand_id, product_id, variant_id, line_number, quantity,
    unit_price_minor, line_total_minor, product_name_snapshot, sku_snapshot) values
  ('91000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002',
   'b0000000-0000-4000-8000-00000000000b','c0000000-0000-4000-8000-00000000000b','d0000000-0000-4000-8000-00000000000b',
   1,2,1500,3000,'Cap','CAP-1');

-- ---- Returns + refunds on O1 (net-per-unit basis = 2099; gross unit is 2599) ----
insert into public.returns (id, tenant_id, order_id, channel, source, actor_membership_id, currency, amount_minor,
    normalized_key, intent, policy_snapshot, created_at) values
  ('a1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   'pos','pos','72000000-0000-4000-8000-00000000000a','USD',2099,'ret-1','{}','{}',pg_temp.ny('2026-06-21 12:00')),
  ('a1000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   'pos','pos','72000000-0000-4000-8000-00000000000a','USD',2099,'ret-2','{}','{}',pg_temp.ny('2026-06-22 12:00'));
insert into public.return_lines (id, tenant_id, return_id, order_id, order_line_id, variant_id, quantity, reason, disposition, amount_minor) values
  ('a2000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',
   '90000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',1,'too small','restock',2099),
  ('a2000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002',
   '90000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',1,'defect','non_restock',2099);
insert into public.refunds (id, tenant_id, order_id, return_id, payment_id, method, status, amount_minor, currency, created_at) values
  ('a3000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000001','cash','pending',2099,'USD',pg_temp.ny('2026-06-21 12:00'));
insert into public.refunds (id, tenant_id, order_id, return_id, payment_id, method, status, amount_minor, currency,
    settlement_reference, settled_by_membership_id, settled_at, created_at) values
  ('a3000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000002','95000000-0000-4000-8000-000000000001','cash','succeeded',2099,'USD',
   'cash-ref-2','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-23 12:00'),pg_temp.ny('2026-06-22 12:00'));

-- ---- Inventory operations (June): supplier receipt, unattributed receipt, adjustment, transfer, sale ----
insert into public.inventory_operations (id, tenant_id, operation_type, actor_membership_id, occurred_at, supplier_id, supplier_name_snapshot, notes) values
  ('b1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','receipt','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-05 09:00'),'51000000-0000-4000-8000-000000000001','Supplier One','pallet 7'),
  ('b1000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','receipt','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-06 09:00'),null,null,null),
  ('b1000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','adjustment','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-07 09:00'),null,null,null),
  ('b1000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','transfer','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-08 09:00'),null,null,null),
  ('b1000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001','sale','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-09 09:00'),null,null,null);
insert into public.inventory_movements (id, tenant_id, operation_id, variant_id, inventory_location_id, quantity_delta, line_number) values
  ('b2000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',10,1),
  ('b2000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',5,2),
  ('b2000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',3,1),
  ('b2000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',-2,1),
  ('b2000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',-3,1),
  ('b2000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002',3,2),
  ('b2000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000005','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',-2,1);

-- ============================ export assertions ============================
do $t$
declare
  a uuid := 'a0000000-0000-4000-8000-000000000001';
  b uuid := 'a0000000-0000-4000-8000-000000000002';
  j jsonb; rows jsonb; r jsonb; usd jsonb; eur jsonb;
begin
  -- (1) sales-products (variant): TEE-M USD net 4198 (after allocated discount 1000), CAP-1 EUR net 3000.
  --     Every monetary row carries its own currency; the two currencies are separate rows, never merged.
  j := reporting_private.export_sales_products(a, '2026-06-01', '2026-06-30', 'variant', 1000);
  rows := j->'rows';
  perform pg_temp.assert_true(jsonb_array_length(rows) = 2, 'sales-products: two variant rows');
  usd := (select e from jsonb_array_elements(rows) e where e->>'sku' = 'TEE-M');
  eur := (select e from jsonb_array_elements(rows) e where e->>'sku' = 'CAP-1');
  perform pg_temp.assert_true((usd->>'currency') = 'USD' and (usd->>'netSalesMinor') = '4198'
    and (usd->>'allocatedDiscountsMinor') = '1000' and (usd->>'level') = 'variant',
    'sales-products: TEE-M USD net 4198 net-discounted');
  perform pg_temp.assert_true((eur->>'currency') = 'EUR' and (eur->>'netSalesMinor') = '3000',
    'sales-products: CAP-1 EUR row separate from USD');
  perform pg_temp.assert_true(j->'period'->>'timezone' = 'America/New_York', 'sales-products: tenant tz period echoed');

  -- (2) sales-products (product): variantId/sku are null at product level.
  rows := (reporting_private.export_sales_products(a, '2026-06-01', '2026-06-30', 'product', 1000))->'rows';
  r := (select e from jsonb_array_elements(rows) e where e->>'productName' = '=Tee');
  perform pg_temp.assert_true(r->'variantId' = 'null'::jsonb and r->'sku' = 'null'::jsonb and r->>'level' = 'product',
    'sales-products: product level has null variant/sku');

  -- (3) inventory-movements: all seven movements; the receipt movement carries the supplier snapshot; the
  --     adjustment movement carries a negative delta; the reason note is projected.
  rows := (reporting_private.export_inventory_movements(a, '2026-06-01', '2026-06-30', 1000))->'rows';
  perform pg_temp.assert_true(jsonb_array_length(rows) = 7, 'inventory-movements: seven movement rows');
  r := (select e from jsonb_array_elements(rows) e where e->>'operationId' = 'b1000000-0000-4000-8000-000000000001' limit 1);
  perform pg_temp.assert_true(r->>'supplierName' = 'Supplier One' and r->>'notes' = 'pallet 7'
    and r->>'operationType' = 'receipt' and r->>'productName' = '=Tee',
    'inventory-movements: receipt movement has supplier snapshot + note + product');
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements(rows) e where (e->>'quantityDelta')::bigint = -2),
    'inventory-movements: negative adjustment delta present');

  -- (4) returns: one row per return line, with the return's single refund attached (1:1). Accepted amount
  --     is the net-discounted per-line basis (2099), NOT the gross 2599. Returns and refunds stay distinct.
  rows := (reporting_private.export_returns(a, '2026-06-01', '2026-06-30', 1000))->'rows';
  perform pg_temp.assert_true(jsonb_array_length(rows) = 2, 'returns: two return-line rows');
  r := (select e from jsonb_array_elements(rows) e where e->>'returnId' = 'a1000000-0000-4000-8000-000000000001');
  perform pg_temp.assert_true((r->>'acceptedNetReturnAmountMinor') = '2099' and (r->>'currency') = 'USD'
    and (r->>'disposition') = 'restock' and (r->>'refundStatus') = 'pending' and r->'refundSettledAt' = 'null'::jsonb,
    'returns: ret-1 net 2099, pending refund, unsettled');
  r := (select e from jsonb_array_elements(rows) e where e->>'returnId' = 'a1000000-0000-4000-8000-000000000002');
  perform pg_temp.assert_true((r->>'refundStatus') = 'succeeded' and (r->>'refundAmountMinor') = '2099'
    and r->>'refundSettledAt' is not null and r->>'orderId' = '90000000-0000-4000-8000-000000000001',
    'returns: ret-2 succeeded refund settled, order reference present');

  -- (5) supplier-receipts: one row per received unit line on supplier-attributed receipts; the unattributed
  --     receipt is excluded; both current name and immutable snapshot present; NO cost/spend/value fields.
  rows := (reporting_private.export_supplier_receipts(a, '2026-06-01', '2026-06-30', 1000))->'rows';
  perform pg_temp.assert_true(jsonb_array_length(rows) = 2, 'supplier-receipts: two received-line rows (unattributed excluded)');
  r := rows->0;
  perform pg_temp.assert_true(r->>'supplierName' = 'Supplier One' and r->>'supplierNameSnapshot' = 'Supplier One'
    and (r->>'unitsReceived')::bigint > 0,
    'supplier-receipts: current + snapshot supplier label and units received');
  perform pg_temp.assert_true(
    not (r ? 'spend') and not (r ? 'value') and not (r ? 'unitCost') and not (r ? 'costMinor')
      and not (r ? 'cogs') and not (r ? 'acquisitionValueMinor'),
    'supplier-receipts: no acquisition cost/spend/value fields');

  -- (6) Tenant isolation: tenant B sees none of tenant A's rows across every dataset.
  perform pg_temp.assert_true(
    jsonb_array_length((reporting_private.export_sales_products(b, '2026-06-01', '2026-06-30', 'variant', 1000))->'rows') = 0
    and jsonb_array_length((reporting_private.export_inventory_movements(b, '2026-06-01', '2026-06-30', 1000))->'rows') = 0
    and jsonb_array_length((reporting_private.export_returns(b, '2026-06-01', '2026-06-30', 1000))->'rows') = 0
    and jsonb_array_length((reporting_private.export_supplier_receipts(b, '2026-06-01', '2026-06-30', 1000))->'rows') = 0,
    'exports: tenant B fully isolated');

  -- (7) Row bound is explicit: exceeding p_max_rows raises RP413 and never silently truncates.
  perform pg_temp.assert_raises(
    $q$ select reporting_private.export_inventory_movements('a0000000-0000-4000-8000-000000000001','2026-06-01','2026-06-30',1) $q$,
    'RP413', 'inventory-movements: row bound exceeded raises RP413');
  perform pg_temp.assert_raises(
    $q$ select reporting_private.export_returns('a0000000-0000-4000-8000-000000000001','2026-06-01','2026-06-30',1) $q$,
    'RP413', 'returns: row bound exceeded raises RP413');
  -- A bound at exactly the row count succeeds (boundary is inclusive, no off-by-one truncation).
  perform pg_temp.assert_true(
    jsonb_array_length((reporting_private.export_returns(a, '2026-06-01', '2026-06-30', 2))->'rows') = 2,
    'returns: bound equal to row count returns all rows');

  -- (8) Invalid bound and end-before-start are rejected (defense in depth behind the service).
  perform pg_temp.assert_raises(
    $q$ select reporting_private.export_returns('a0000000-0000-4000-8000-000000000001','2026-06-01','2026-06-30',0) $q$,
    '22023', 'returns: non-positive row bound rejected');
  perform pg_temp.assert_raises(
    $q$ select reporting_private.export_sales_products('a0000000-0000-4000-8000-000000000001','2026-06-30','2026-06-01','variant',10) $q$,
    '22023', 'sales-products: end-before-start rejected');

  -- (9) Empty period yields an empty rows array and still echoes the resolved period.
  j := reporting_private.export_returns(a, '2020-01-01', '2020-01-31', 1000);
  perform pg_temp.assert_true(jsonb_array_length(j->'rows') = 0 and j->'period' is not null,
    'returns: empty period returns [] with period');

  raise notice 'phase 2q-c reporting export persistence assertions passed';
end;
$t$;
