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

-- Convenience: America/New_York local timestamp -> UTC instant (exercises the real tenant timezone).
create or replace function pg_temp.ny(p text) returns timestamptz language sql as $function$
  select (p::timestamp) at time zone 'America/New_York'
$function$;

-- ============================ seed ============================
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

insert into public.products (id, tenant_id, brand_id, name, slug, status) values
  ('c0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000a','Tee','tee','active'),
  ('c0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000a','Pants','pants','active'),
  ('c0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000b','Cap','cap','active');
insert into public.product_variants (id, tenant_id, product_id, sku, status) values
  ('d0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','TEE-M','active'),
  ('d0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002','PANTS-1','active'),
  ('d0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-00000000000b','CAP-1','active');

insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type, is_sellable) values
  ('e1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-00000000000a','L1','Sales Floor','branch',true),
  ('e1000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-00000000000a','L2','Back Room','branch',false);
-- Balances carry an append-only guard; the sanctioned writer sets this transaction-local flag. The test
-- seeds balances directly (as superuser), so it sets the same flag for the seeding transaction only.
select set_config('inventory_private.allow_balance_write', 'on', true);
insert into public.inventory_balances (tenant_id, variant_id, inventory_location_id, on_hand_quantity, version) values
  ('a0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',10,0),
  ('a0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',5,0);

insert into public.suppliers (id, tenant_id, name, code) values
  ('51000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Supplier One','SUP1');

-- Promotion (percentage, code-activated) + code. Renamed AFTER redemption to prove report snapshots.
insert into public.promotions (id, tenant_id, name, benefit_type, benefit_percent_bp, target_type, activation_type, status) values
  ('80000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Summer Sale','percentage',2000,'order','code','active');
insert into public.promotion_codes (id, tenant_id, promotion_id, code) values
  ('81000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001','SUMMER');

-- ---- Orders ----
-- O1: discounted USD POS order (in June period), brand A, branch/register/operator attributed.
insert into public.orders (id, tenant_id, brand_id, branch_id, register_id, order_number, channel, status, currency,
    total_minor, gross_subtotal_minor, discount_total_minor, actor_membership_id, placed_at, created_at) values
  ('90000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000a',
   'e0000000-0000-4000-8000-00000000000a','f0000000-0000-4000-8000-00000000000a','1001','pos','placed','USD',
   4198,5198,1000,'72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-15 12:00'),pg_temp.ny('2026-06-15 12:00'));
insert into public.order_lines (id, tenant_id, order_id, brand_id, product_id, variant_id, line_number, quantity,
    unit_price_minor, line_total_minor, product_name_snapshot, sku_snapshot) values
  ('91000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-00000000000a','c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',
   1,2,2599,5198,'Tee','TEE-M');
insert into public.order_adjustments (id, tenant_id, order_id, promotion_id, code_id, promotion_name_snapshot,
    benefit_type_snapshot, benefit_value_snapshot, target_type_snapshot, code_snapshot,
    gross_subtotal_minor, eligible_basis_minor, discount_total_minor) values
  ('92000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','Summer Sale','percentage',2000,'order','SUMMER',5198,5198,1000);
insert into public.order_line_adjustments (id, tenant_id, order_id, order_line_id, promotion_id, discount_minor) values
  ('93000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001',1000);
insert into public.promotion_redemptions (id, tenant_id, promotion_id, code_id, order_id, channel, discount_total_minor, redeemed_at) values
  ('94000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','pos',1000,pg_temp.ny('2026-06-15 12:00'));
insert into public.payments (id, tenant_id, order_id, method, status, currency, amount_minor, cash_received_minor,
    change_minor, captured_by_membership_id, idempotency_key, payload_fingerprint) values
  ('95000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
   'cash','captured','USD',4198,5000,802,'72000000-0000-4000-8000-00000000000a','pay-o1','fp-o1');

-- O2: EUR online order (in period), brand B. Different currency — must never be summed with USD.
insert into public.orders (id, tenant_id, brand_id, order_number, channel, status, currency,
    total_minor, gross_subtotal_minor, discount_total_minor, placed_at, created_at) values
  ('90000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000b',
   '1002','online','placed','EUR',3000,3000,0,pg_temp.ny('2026-06-16 12:00'),pg_temp.ny('2026-06-16 12:00'));
insert into public.order_lines (id, tenant_id, order_id, brand_id, product_id, variant_id, line_number, quantity,
    unit_price_minor, line_total_minor, product_name_snapshot, sku_snapshot) values
  ('91000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002',
   'b0000000-0000-4000-8000-00000000000b','c0000000-0000-4000-8000-00000000000b','d0000000-0000-4000-8000-00000000000b',
   1,2,1500,3000,'Cap','CAP-1');

-- Oc: cancelled USD POS order (in period) with a redemption — excluded from sales, counted as cancelled.
insert into public.orders (id, tenant_id, brand_id, branch_id, register_id, order_number, channel, status, currency,
    total_minor, gross_subtotal_minor, discount_total_minor, actor_membership_id, placed_at, cancelled_at) values
  ('90000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000a',
   'e0000000-0000-4000-8000-00000000000a','f0000000-0000-4000-8000-00000000000a','1003','pos','cancelled','USD',
   400,500,100,'72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-17 12:00'),pg_temp.ny('2026-06-18 12:00'));
insert into public.order_adjustments (id, tenant_id, order_id, promotion_id, code_id, promotion_name_snapshot,
    benefit_type_snapshot, benefit_value_snapshot, target_type_snapshot, code_snapshot,
    gross_subtotal_minor, eligible_basis_minor, discount_total_minor) values
  ('92000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000003',
   '80000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','Summer Sale','percentage',2000,'order','SUMMER',500,500,100);
insert into public.promotion_redemptions (id, tenant_id, promotion_id, code_id, order_id, channel, discount_total_minor, redeemed_at) values
  ('94000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000003','pos',100,pg_temp.ny('2026-06-17 12:00'));

-- Ob: boundary order at UTC 2026-06-01T00:00Z == 2026-05-31 20:00 America/New_York (local May 31).
insert into public.orders (id, tenant_id, brand_id, branch_id, register_id, order_number, channel, status, currency,
    total_minor, gross_subtotal_minor, discount_total_minor, actor_membership_id, placed_at) values
  ('90000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000a',
   'e0000000-0000-4000-8000-00000000000a','f0000000-0000-4000-8000-00000000000a','1004','pos','placed','USD',
   777,777,0,'72000000-0000-4000-8000-00000000000a','2026-06-01T00:00:00Z');

-- Ooff: offline-origin USD POS order. created_at long past; placed_at (acceptedAt) is in June and drives the period.
insert into public.orders (id, tenant_id, brand_id, branch_id, register_id, order_number, channel, status, currency,
    total_minor, gross_subtotal_minor, discount_total_minor, actor_membership_id, placed_at, created_at) values
  ('90000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000a',
   'e0000000-0000-4000-8000-00000000000a','f0000000-0000-4000-8000-00000000000a','1005','pos','placed','USD',
   1000,1000,0,'72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-20 12:00'),pg_temp.ny('2026-01-01 00:00'));

-- Rename the promotion AFTER redemptions: reports must still show the immutable snapshot 'Summer Sale'.
update public.promotions set name = 'Renamed Later', updated_at = now()
  where id = '80000000-0000-4000-8000-000000000001';

-- ---- Returns + refunds on O1 (2 units of TEE-M; net-per-unit basis = (5198-1000)/2 = 2099) ----
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

-- ---- Inventory operations (June) ----
insert into public.inventory_operations (id, tenant_id, operation_type, actor_membership_id, occurred_at, supplier_id, supplier_name_snapshot) values
  ('b1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','receipt','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-05 09:00'),'51000000-0000-4000-8000-000000000001','Supplier One'),
  ('b1000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','receipt','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-06 09:00'),null,null),
  ('b1000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','adjustment','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-07 09:00'),null,null),
  ('b1000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','transfer','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-08 09:00'),null,null),
  ('b1000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001','sale','72000000-0000-4000-8000-00000000000a',pg_temp.ny('2026-06-09 09:00'),null,null);
insert into public.inventory_movements (id, tenant_id, operation_id, variant_id, inventory_location_id, quantity_delta, line_number) values
  ('b2000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',10,1),
  ('b2000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',5,2),
  ('b2000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',3,1),
  ('b2000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',-2,1),
  ('b2000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',-3,1),
  ('b2000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002',3,2),
  ('b2000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000005','d0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',-2,1);

-- ============================ assertions ============================
do $t$
declare
  a uuid := 'a0000000-0000-4000-8000-000000000001';
  b uuid := 'a0000000-0000-4000-8000-000000000002';
  s jsonb; usd jsonb; eur jsonb; j jsonb; items jsonb;
begin
  -- Summary over the June (EDT) period.
  s := reporting_private.report_summary(a, '2026-06-01', '2026-06-30');

  -- (1) Mixed currencies are reported separately and never combined.
  perform pg_temp.assert_true(jsonb_array_length(s->'salesByCurrency') = 2, 'summary: two currency rows');
  usd := (select e from jsonb_array_elements(s->'salesByCurrency') e where e->>'currency' = 'USD');
  eur := (select e from jsonb_array_elements(s->'salesByCurrency') e where e->>'currency' = 'EUR');
  perform pg_temp.assert_true(usd is not null and eur is not null, 'summary: USD and EUR present');

  -- (2) Sales KPIs over placed orders: gross/discount/net/count/AOV. Cancelled + boundary excluded.
  perform pg_temp.assert_true((usd->>'orderCount')::int = 2, 'summary: USD placed count is 2 (O1 + offline)');
  perform pg_temp.assert_true((usd->>'grossSalesMinor')::bigint = 6198, 'summary: USD gross 6198');
  perform pg_temp.assert_true((usd->>'discountsMinor')::bigint = 1000, 'summary: USD discounts 1000');
  perform pg_temp.assert_true((usd->>'netSalesMinor')::bigint = 5198, 'summary: USD net 5198');
  perform pg_temp.assert_true((usd->>'averageOrderValueMinor')::bigint = 2599, 'summary: USD AOV round(5198/2)=2599');
  perform pg_temp.assert_true((eur->>'netSalesMinor')::bigint = 3000, 'summary: EUR net 3000 (never merged with USD)');

  -- (3) offline acceptedAt: Ooff (created_at Jan, placed_at Jun) IS counted -> it is in the USD count above.
  --     Prove the boundary order Ob (UTC Jun-1 00:00 == NY May-31) is NOT in the June period.
  perform pg_temp.assert_true((usd->>'grossSalesMinor')::bigint = 6198, 'summary: boundary order Ob excluded from June');

  -- (4) Tenant-local date boundary: the SAME boundary order IS in the May (local) period.
  j := reporting_private.report_summary(a, '2026-05-01', '2026-05-31');
  usd := (select e from jsonb_array_elements(j->'salesByCurrency') e where e->>'currency' = 'USD');
  perform pg_temp.assert_true((usd->>'netSalesMinor')::bigint = 777, 'summary: boundary order in local May period');

  -- (5) DST boundary: a 3-calendar-day span across US spring-forward is 71 hours, not 72.
  perform pg_temp.assert_true(
    (select to_ts - from_ts from reporting_private.resolve_period(a, '2026-03-07', '2026-03-09')) = interval '71 hours',
    'resolve_period: DST spring-forward yields 71h across 3 local days');

  -- (6) Returns/refunds KPI section: accepted returned value + succeeded vs pending refunds by currency.
  usd := (select e from jsonb_array_elements(s->'returns'->'byCurrency') e where e->>'currency' = 'USD');
  perform pg_temp.assert_true((usd->>'acceptedReturnedValueMinor')::bigint = 4198, 'summary: accepted returned 4198');
  perform pg_temp.assert_true((usd->>'returnCount')::int = 2, 'summary: return count 2');
  usd := (select e from jsonb_array_elements(s->'returns'->'refundsByCurrency') e where e->>'currency' = 'USD');
  perform pg_temp.assert_true((usd->>'succeededRefundMinor')::bigint = 2099, 'summary: succeeded refund 2099');
  perform pg_temp.assert_true((usd->>'pendingRefundMinor')::bigint = 2099, 'summary: pending refund 2099');

  -- (7) Current stock summary + inventoryAsOf present.
  perform pg_temp.assert_true((s->'stock'->>'totalOnHandQuantity')::bigint = 15, 'summary: stock on hand 15');
  perform pg_temp.assert_true(s->>'inventoryAsOf' is not null, 'summary: inventoryAsOf present');

  -- (8) Empty period returns empty currency arrays and does not crash.
  j := reporting_private.report_summary(a, '2020-01-01', '2020-01-31');
  perform pg_temp.assert_true(jsonb_array_length(j->'salesByCurrency') = 0, 'summary: empty period sales []');
  perform pg_temp.assert_true(jsonb_array_length(j->'returns'->'byCurrency') = 0, 'summary: empty period returns []');

  -- (9) Tenant isolation: tenant B sees none of tenant A's data.
  j := reporting_private.report_summary(b, '2026-06-01', '2026-06-30');
  perform pg_temp.assert_true(jsonb_array_length(j->'salesByCurrency') = 0, 'summary: tenant B isolated');

  -- (10) POS vs online split.
  items := reporting_private.report_sales(a, '2026-06-01', '2026-06-30', 'channel', null)->'items';
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements(items) e where e->>'channel' = 'pos' and e->>'currency' = 'USD')
    and exists (select 1 from jsonb_array_elements(items) e where e->>'channel' = 'online' and e->>'currency' = 'EUR'),
    'sales channel: pos USD and online EUR split');

  -- (11) Brand split.
  items := reporting_private.report_sales(a, '2026-06-01', '2026-06-30', 'brand', null)->'items';
  perform pg_temp.assert_true(jsonb_array_length(items) = 2, 'sales brand: two brand rows');

  -- (12) POS branch/register/operator attribution — POS only (online carries none).
  items := reporting_private.report_sales(a, '2026-06-01', '2026-06-30', 'pos_branch', null)->'items';
  perform pg_temp.assert_true(
    (select sum((e->>'orderCount')::int) from jsonb_array_elements(items) e) = 2
    and not exists (select 1 from jsonb_array_elements(items) e where e->>'currency' = 'EUR'),
    'sales pos_branch: only POS USD orders attributed');
  items := reporting_private.report_sales(a, '2026-06-01', '2026-06-30', 'pos_register', null)->'items';
  perform pg_temp.assert_true(items->0->>'registerName' = 'Register 1', 'sales pos_register: register name');
  items := reporting_private.report_sales(a, '2026-06-01', '2026-06-30', 'pos_operator', null)->'items';
  perform pg_temp.assert_true(items->0->>'operatorName' = 'Olivia Operator', 'sales pos_operator: operator name');

  -- (13) Trend buckets (weeks start Monday).
  items := reporting_private.report_sales(a, '2026-06-01', '2026-06-30', 'trend', 'week')->'items';
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements(items) e where e->>'bucketStart' = '2026-06-15'),
    'sales trend: Monday-aligned week bucket 2026-06-15');

  -- (14) Invalid inputs raise (defense in depth behind the service validation).
  perform pg_temp.assert_raises(
    $q$ select reporting_private.report_summary('a0000000-0000-4000-8000-000000000001','2026-06-30','2026-06-01') $q$,
    '22023', 'summary: end-before-start rejected');
  perform pg_temp.assert_raises(
    $q$ select reporting_private.report_sales('a0000000-0000-4000-8000-000000000001','2026-06-01','2026-06-30','bogus',null) $q$,
    '22023', 'sales: invalid view rejected');

  -- (15) Products: discounted sales metrics with allocated discount + net.
  j := reporting_private.report_products(a, '2026-06-01', '2026-06-30', 'variant', 'sales', 50, 0);
  items := j->'items';
  perform pg_temp.assert_true(
    (select e->>'netSalesMinor' from jsonb_array_elements(items) e where e->>'sku' = 'TEE-M') = '4198'
    and (select e->>'allocatedDiscountsMinor' from jsonb_array_elements(items) e where e->>'sku' = 'TEE-M') = '1000',
    'products: TEE-M net 4198 after allocated discount 1000');

  -- (16) Non-moving signal: current stock, no sale in period. PANTS-1 qualifies; TEE-M (sold) does not.
  items := reporting_private.report_products(a, '2026-06-01', '2026-06-30', 'variant', 'no_sales_with_current_stock', 50, 0)->'items';
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements(items) e where e->>'sku' = 'PANTS-1')
    and not exists (select 1 from jsonb_array_elements(items) e where e->>'sku' = 'TEE-M'),
    'products: no_sales_with_current_stock = PANTS-1 only');

  -- (17) Cursor bounds.
  j := reporting_private.report_products(a, '2026-06-01', '2026-06-30', 'variant', 'sales', 1, 0);
  perform pg_temp.assert_true(jsonb_array_length(j->'items') = 1 and (j->'pageInfo'->>'hasMore')::boolean
    and (j->'pageInfo'->>'nextOffset')::int = 1, 'products: cursor page 1 hasMore');
  j := reporting_private.report_products(a, '2026-06-01', '2026-06-30', 'variant', 'sales', 50, 999);
  perform pg_temp.assert_true(jsonb_array_length(j->'items') = 0 and (j->'pageInfo'->>'hasMore')::boolean = false,
    'products: cursor beyond end empties');

  -- (18) Inventory balances are current state (no period), with asOf set.
  j := reporting_private.report_inventory(a, null, null, 'balances', 50, 0);
  perform pg_temp.assert_true(jsonb_array_length(j->'items') = 2 and j->'period' = 'null'::jsonb and j->>'asOf' is not null,
    'inventory balances: current state, no period, asOf set');

  -- (19) Inventory event views over the period.
  perform pg_temp.assert_true(
    jsonb_array_length(reporting_private.report_inventory(a,'2026-06-01','2026-06-30','receipts',50,0)->'items') = 2,
    'inventory receipts: two receipt operations');
  perform pg_temp.assert_true(
    jsonb_array_length(reporting_private.report_inventory(a,'2026-06-01','2026-06-30','transfers',50,0)->'items') = 1,
    'inventory transfers: one transfer operation');
  perform pg_temp.assert_true(
    jsonb_array_length(reporting_private.report_inventory(a,'2026-06-01','2026-06-30','adjustments',50,0)->'items') = 1,
    'inventory adjustments: one adjustment operation');
  perform pg_temp.assert_true(
    jsonb_array_length(reporting_private.report_inventory(a,'2026-06-01','2026-06-30','movements',50,0)->'items') = 7,
    'inventory movements: all seven movements');

  -- (20) Returns summary by disposition + product/variant breakdown (net-per-unit basis).
  j := reporting_private.report_returns(a, '2026-06-01', '2026-06-30', 'summary', null, null);
  perform pg_temp.assert_true(
    (select sum((e->>'returnedQuantity')::int) from jsonb_array_elements(j->'summary'->'byDisposition') e) = 2,
    'returns summary: disposition quantity total 2');
  items := reporting_private.report_returns(a, '2026-06-01', '2026-06-30', 'variants', 50, 0)->'items';
  perform pg_temp.assert_true(
    (select e->>'returnedValueMinor' from jsonb_array_elements(items) e where e->>'sku' = 'TEE-M') = '4198',
    'returns variants: TEE-M net returned value 4198 (not gross 5198)');

  -- (21) Promotions from immutable redemption + adjustment data; snapshot name survives the live rename.
  items := reporting_private.report_promotions(a, '2026-06-01', '2026-06-30')->'items';
  usd := (select e from jsonb_array_elements(items) e where e->>'currency' = 'USD');
  perform pg_temp.assert_true(usd->>'promotionName' = 'Summer Sale', 'promotions: immutable snapshot name, not live rename');
  perform pg_temp.assert_true((usd->>'redemptionCount')::int = 2, 'promotions: 2 redemptions (incl cancelled order)');
  perform pg_temp.assert_true((usd->>'discountAmountMinor')::bigint = 1100, 'promotions: discount 1000 + 100');
  perform pg_temp.assert_true((usd->>'orderCount')::int = 1, 'promotions: 1 placed associated order');
  perform pg_temp.assert_true((usd->>'cancelledOrderCount')::int = 1, 'promotions: 1 cancelled associated order');

  -- (22) Suppliers: receipt count + units received + last receipt; NO spend/value; unattributed receipt excluded.
  items := reporting_private.report_suppliers(a, '2026-06-01', '2026-06-30', 50, 0)->'items';
  perform pg_temp.assert_true(jsonb_array_length(items) = 1, 'suppliers: only attributed receipts (unattributed excluded)');
  j := items->0;
  perform pg_temp.assert_true((j->>'receiptCount')::int = 1 and (j->>'unitsReceived')::bigint = 15, 'suppliers: 1 receipt, 15 units');
  perform pg_temp.assert_true(
    not (j ? 'spend') and not (j ? 'value') and not (j ? 'unitCost') and not (j ? 'costMinor'),
    'suppliers: no acquisition cost/spend fields');

  raise notice 'phase 2q reporting persistence assertions passed';
end;
$t$;

rollback;
