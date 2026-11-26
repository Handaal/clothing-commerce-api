-- Phase 1B (Storefront program): delivery zones, fees, free-delivery threshold, order accounting.
-- Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql + phase_2l_online.setup.sql
-- (tenant ...1-...0001, brand ...2-...0001 with COD in USD, published variant ...7-...0001 at 2500, stock 10).
\set ON_ERROR_STOP on

create or replace function pg_temp.intent(p_zone text, p_qty int, p_expected bigint)
returns jsonb language sql as $f$
  select jsonb_build_object(
    'tenantId','2a000001-0000-4000-8000-000000000001','brandId','2a000002-0000-4000-8000-000000000001',
    'lines',jsonb_build_array(jsonb_build_object('variantId','2a000007-0000-4000-8000-000000000001','quantity',p_qty)),
    'customer',jsonb_build_object('name','Shopper','email',null,'phone','+201000000000'),
    'delivery',jsonb_build_object('recipientName','Shopper','phone','+201000000000','line1','1 Street','line2',null,
      'city','Nasr City','region',null,'postalCode',null,'countryCode','EG','notes',null)
      || case when p_zone is null then '{}'::jsonb else jsonb_build_object('zoneCode',p_zone) end,
    'paymentMethod','cash_on_delivery','expectedTotalMinor',p_expected,'expectedCurrency','USD');
$f$;

create or replace function pg_temp.quote(p_zone text, p_qty int)
returns jsonb language sql as $f$
  select online_private.quote_checkout(jsonb_build_object(
    'tenantId','2a000001-0000-4000-8000-000000000001','brandId','2a000002-0000-4000-8000-000000000001',
    'lines',jsonb_build_array(jsonb_build_object('variantId','2a000007-0000-4000-8000-000000000001','quantity',p_qty)))
    || case when p_zone is null then '{}'::jsonb else jsonb_build_object('zoneCode',p_zone) end);
$f$;

-- 1. Privileges ----------------------------------------------------------------------------------------
do $b$ begin
  assert not has_table_privilege('anon', 'public.storefront_delivery_zones', 'select')
     and not has_table_privilege('authenticated', 'public.storefront_delivery_zones', 'select')
     and not has_table_privilege('service_role', 'public.storefront_delivery_zones', 'insert'),
    'P1 clients cannot read zones directly and the server cannot bypass the settings writer';
  assert has_function_privilege('service_role', 'settings_private.write_storefront_delivery(uuid,uuid,uuid,text,jsonb)', 'execute')
     and not has_function_privilege('anon', 'settings_private.write_storefront_delivery(uuid,uuid,uuid,text,jsonb)', 'execute')
     and has_function_privilege('service_role', 'online_private.delivery_options(uuid,uuid)', 'execute')
     and not has_function_privilege('service_role', 'orders_private.apply_delivery_fee(uuid,uuid,bigint)', 'execute'),
    'P2 only the sanctioned paths write zones and fees';
end $b$;

-- 2. No zones: delivery is free and no zone is needed (pre-1B behaviour) ---------------------------------
do $b$
declare q jsonb := pg_temp.quote(null, 1);
begin
  assert (q->'delivery'->>'required')::boolean = false and (q->'delivery'->>'feeMinor')::bigint = 0,
    'N1 unconfigured brand quotes free delivery';
  assert (q->>'totalMinor')::bigint = 2500, 'N2 total is goods only';
end $b$;
set role service_role;
select (r->>'totalMinor') as total, r->>'deliveryFeeMinor' as fee
  from (select online_private.place_checkout('no-zones-1', pg_temp.intent(null, 1, 2500))) x(r);
reset role;
do $b$ begin
  assert (select delivery_fee_minor = 0 and total_minor = 2500 from public.orders where channel = 'online' order by created_at desc limit 1),
    'N3 order placed without a fee';
end $b$;

-- 3. Configure zones (Cairo 500, Alexandria 700, an inactive zone) and a 6000 threshold ------------------
set role service_role;
select settings_private.write_storefront_delivery('2a000001-0000-4000-8000-000000000001','2a000002-0000-4000-8000-000000000001',
  null, 'zones-1', '{"freeDeliveryThresholdMinor":6000,"zones":[{"code":"eg-c","name":"Cairo","feeMinor":500},
  {"code":"EG-ALX","name":"Alexandria","feeMinor":700},{"code":"EG-JS","name":"South Sinai","feeMinor":900,"active":false}]}'::jsonb);
reset role;
do $b$
declare opts jsonb := online_private.delivery_options('2a000001-0000-4000-8000-000000000001','2a000002-0000-4000-8000-000000000001');
begin
  assert jsonb_array_length(opts->'zones') = 2, 'Z1 inactive zones are not offered';
  assert opts->'zones'->0->>'code' = 'EG-C', 'Z2 codes stored upper-case, in order';
  assert (opts->>'freeDeliveryThresholdMinor')::bigint = 6000, 'Z3 threshold exposed';
  begin
    perform settings_private.write_storefront_delivery('2a000001-0000-4000-8000-000000000001','2a000002-0000-4000-8000-000000000001',
      null, 'zones-1', '{"freeDeliveryThresholdMinor":null,"zones":[]}'::jsonb);
    raise exception 'Z4 expected ID409';
  exception when sqlstate 'ID409' then null; end;
  begin
    perform settings_private.write_storefront_delivery('2a000001-0000-4000-8000-000000000001','2a000002-0000-4000-8000-000000000001',
      null, 'zones-2', '{"zones":[{"code":"A","name":"x","feeMinor":1},{"code":"a","name":"y","feeMinor":2}]}'::jsonb);
    raise exception 'Z5 expected 22023';
  exception when sqlstate '22023' then null; end;
end $b$;

-- 4. Quotes -------------------------------------------------------------------------------------------
do $b$
declare q jsonb;
begin
  q := pg_temp.quote(null, 1);
  assert (q->'delivery'->>'required')::boolean and q->'delivery'->'feeMinor' = 'null'::jsonb
     and (q->>'totalMinor')::bigint = 2500, 'Q1 zone required; total excludes the unknown fee';
  q := pg_temp.quote('eg-c', 1);
  assert (q->'delivery'->>'feeMinor')::bigint = 500 and (q->>'totalMinor')::bigint = 3000
     and q->'delivery'->'zone'->>'name' = 'Cairo', 'Q2 Cairo adds 500';
  q := pg_temp.quote('EG-ALX', 3);
  assert (q->'delivery'->>'feeMinor')::bigint = 0 and (q->'delivery'->>'freeApplied')::boolean
     and (q->>'totalMinor')::bigint = 7500, 'Q3 7500 >= 6000 ships free';
  begin
    perform pg_temp.quote('EG-JS', 1);
    raise exception 'Q4 expected OC006';
  exception when sqlstate 'OC006' then null; end;
end $b$;

-- 5. Placement ----------------------------------------------------------------------------------------
do $b$ begin
  begin
    perform online_private.place_checkout('needs-zone', pg_temp.intent(null, 1, 2500));
    raise exception 'C1 expected OC006';
  exception when sqlstate 'OC006' then null; end;
  begin
    perform online_private.place_checkout('bad-zone', pg_temp.intent('EG-XX', 1, 3000));
    raise exception 'C2 expected OC006';
  exception when sqlstate 'OC006' then null; end;
  begin
    -- A client still expecting the goods-only total is told the real (fee-inclusive) total.
    perform online_private.place_checkout('stale-total', pg_temp.intent('EG-C', 1, 2500));
    raise exception 'C3 expected OC003';
  exception when sqlstate 'OC003' then
    null;
  end;
end $b$;

set role service_role;
select r->>'totalMinor' as total, r->>'deliveryFeeMinor' as fee, r->'deliveryZone'->>'code' as zone
  from (select online_private.place_checkout('cairo-1', pg_temp.intent('EG-C', 1, 3000))) x(r);
reset role;
do $b$
declare o public.orders; p public.payments; replay jsonb;
begin
  select * into o from public.orders where channel = 'online' order by created_at desc limit 1;
  select * into p from public.payments where order_id = o.id;
  assert o.delivery_fee_minor = 500 and o.total_minor = 3000 and o.gross_subtotal_minor = 2500,
    'C4 order carries the fee inside its total';
  assert p.amount_minor = 3000, 'C5 COD payment collects goods + delivery';
  assert o.delivery_snapshot->>'zoneCode' = 'EG-C', 'C6 delivery snapshot keeps the zone';
  replay := online_private.place_checkout('cairo-1', pg_temp.intent('EG-C', 1, 3000));
  assert (replay->>'deliveryFeeMinor')::bigint = 500, 'C7 exact replay returns the stored result';
  begin
    update public.orders set delivery_fee_minor = 0 where id = o.id;
    raise exception 'C8 expected guard';
  exception when insufficient_privilege then null; end;
end $b$;

set role service_role;
select r->>'totalMinor' from (select online_private.place_checkout('free-1', pg_temp.intent('EG-ALX', 3, 7500))) x(r);
reset role;
do $b$ begin
  assert (select delivery_fee_minor = 0 and total_minor = 7500 from public.orders where channel = 'online' order by created_at desc limit 1),
    'T1 threshold reached: free delivery';
  assert (select count(*) = 0 from public.orders where channel = 'pos' and delivery_fee_minor <> 0),
    'T2 POS orders never carry a delivery fee';
  assert (select bool_and(total_minor = gross_subtotal_minor - discount_total_minor + delivery_fee_minor) from public.orders),
    'T3 total identity holds for every order';
end $b$;

select 'ALL_STOREFRONT_DELIVERY_FEE_ASSERTIONS_PASSED' as result;
