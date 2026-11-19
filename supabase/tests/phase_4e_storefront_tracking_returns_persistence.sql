-- Phase 4 (Storefront program): order tracking by number + phone, and customer return requests.
-- Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql + phase_2l_online.setup.sql
-- (tenant ...1-...0001, brand ...2-...0001 with COD in USD, published variant ...7-...0001 at 2500,
-- location ...4-...0001, staff membership ...12-...0001).
\set ON_ERROR_STOP on

create or replace function pg_temp.intent(p_qty int, p_expected bigint)
returns jsonb language sql as $f$
  select jsonb_build_object(
    'tenantId','2a000001-0000-4000-8000-000000000001','brandId','2a000002-0000-4000-8000-000000000001',
    'lines',jsonb_build_array(jsonb_build_object('variantId','2a000007-0000-4000-8000-000000000001','quantity',p_qty)),
    'customer',jsonb_build_object('name','Omar Shopper','email',null,'phone','+20 100 000 0001'),
    'delivery',jsonb_build_object('recipientName','Omar Shopper','phone','+201000000002','line1','1 Street','line2',null,
      'city','Nasr City','region','Cairo','postalCode',null,'countryCode','EG','notes',null),
    'paymentMethod','cash_on_delivery','expectedTotalMinor',p_expected,'expectedCurrency','USD');
$f$;

create or replace function pg_temp.track(p_ref text, p_phone text) returns jsonb language sql as $f$
  select online_private.track_storefront_order('2a000001-0000-4000-8000-000000000001', null, p_ref, p_phone);
$f$;
create or replace function pg_temp.req(p_ref text, p_phone text, p_lines jsonb) returns jsonb language sql as $f$
  select online_private.request_storefront_return('2a000001-0000-4000-8000-000000000001', null, p_ref, p_phone,
    'exchange', '  Size swap please  ', p_lines);
$f$;

-- 1. Privileges ----------------------------------------------------------------------------------------
do $b$ begin
  assert not has_table_privilege('anon', 'public.return_requests', 'select')
     and not has_table_privilege('service_role', 'public.return_requests', 'insert')
     and not has_table_privilege('service_role', 'public.return_request_lines', 'update')
     and has_table_privilege('service_role', 'public.return_requests', 'select')
     and not has_table_privilege('service_role', 'public.storefront_lookup_failures', 'select'),
    'P1 requests are written only by the functions; lookup misses are private';
  assert has_function_privilege('service_role', 'online_private.track_storefront_order(uuid,uuid,text,text)', 'execute')
     and has_function_privilege('service_role', 'online_private.request_storefront_return(uuid,uuid,text,text,text,text,jsonb)', 'execute')
     and not has_function_privilege('service_role', 'online_private.match_storefront_order(uuid,uuid,text,text)', 'execute')
     and not has_function_privilege('anon', 'online_private.track_storefront_order(uuid,uuid,text,text)', 'execute'),
    'P2 only the server tracks orders, through the public entry points';
end $b$;

-- 2. Place an order --------------------------------------------------------------------------------------
set role service_role;
create temp table placed as
  select online_private.place_checkout('track-1', pg_temp.intent(2, 5000)) as r;
reset role;

-- 3. Tracking ---------------------------------------------------------------------------------------------
do $b$
declare
  ref text := (select r->>'orderReference' from placed);
  t jsonb;
begin
  t := pg_temp.track(ref, '+201000000001');
  assert t is not null and t->>'status' = 'placed' and (t->>'totalMinor')::bigint = 5000,
    'T1 customer phone (spaces ignored) finds the order';
  assert pg_temp.track('#' || ref, '+20 100-000-0002') is not null, 'T2 delivery phone and a leading # work too';
  assert t->>'recipientName' = 'Omar' and t->>'deliveryCity' = 'Nasr City'
     and not (t ? 'delivery') and t::text not like '%1 Street%',
    'T3 only first name and city are shown, never the street';
  assert (t->'lines'->0->>'fulfilledQuantity')::int = 0 and (t->'lines'->0->>'returnableQuantity')::int = 0,
    'T4 nothing handed over yet';
  assert t->'returns'->>'reason' = 'RETURNS_DISABLED', 'T5 returns are off until the store enables them';
  assert pg_temp.track(ref, '+201999999999') is null, 'T6 wrong phone is not found';
  assert pg_temp.track('999999', '+201000000001') is null, 'T7 wrong number is not found';
  assert online_private.track_storefront_order(gen_random_uuid(), null, ref, '+201000000001') is null,
    'T8 another tenant cannot see it';
  assert online_private.track_storefront_order('2a000001-0000-4000-8000-000000000001',
    '2a000002-0000-4000-8000-000000000002', ref, '+201000000001') is null,
    'T9 another brand cannot see it';
end $b$;

-- 4. Returns ------------------------------------------------------------------------------------------------
do $b$ begin
  assert online_private.storefront_return_policy('2a000001-0000-4000-8000-000000000001')
    = '{"acceptingReturns": false, "windowDays": null}'::jsonb, 'RP1 no settings: not accepting';
  assert online_private.storefront_return_policy(gen_random_uuid()) is null, 'RP2 unknown tenant';
  assert has_function_privilege('service_role', 'online_private.storefront_return_policy(uuid)', 'execute')
     and not has_function_privilege('anon', 'online_private.storefront_return_policy(uuid)', 'execute'),
    'RP3 only the server reads it';
end $b$;
insert into public.return_settings (tenant_id, enabled, window_days)
values ('2a000001-0000-4000-8000-000000000001', true, 14);

do $b$
declare ref text := (select r->>'orderReference' from placed);
begin
  assert pg_temp.track(ref, '+201000000001')->'returns'->>'reason' = 'NOT_YET_DELIVERED',
    'R1 nothing can be returned before it is handed over';
  assert online_private.storefront_return_policy('2a000001-0000-4000-8000-000000000001')
    = '{"acceptingReturns": true, "windowDays": 14}'::jsonb, 'RP4 the edited window is public';
  assert pg_temp.req(ref, '+201000000001', '[{"lineNumber":1,"quantity":1,"reason":"too_small"}]')->>'refusal'
    = 'NOT_YET_DELIVERED', 'R2 request refused before delivery';
end $b$;

set role service_role;
select * from fulfillments_private.record_fulfillment('2a000001-0000-4000-8000-000000000001',
  (select id from public.orders where order_number = (select r->>'orderReference' from placed)),
  '2a000004-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', 'track-fulfil-1', now(),
  jsonb_build_array(jsonb_build_object('order_line_id',
    (select ol.id from public.order_lines ol join public.orders o on o.id = ol.order_id
      where o.order_number = (select r->>'orderReference' from placed)), 'quantity', 2)));
reset role;

do $b$
declare
  ref text := (select r->>'orderReference' from placed);
  t jsonb;
  q jsonb;
begin
  t := pg_temp.track(ref, '+201000000001');
  assert t->'returns'->>'accepting' = 'true' and (t->'lines'->0->>'returnableQuantity')::int = 2
     and t->>'lastFulfilledAt' is not null and (t->'returns'->>'windowDays')::int = 14,
    'R3 handed-over items can be requested within the window';
  assert pg_temp.req(ref, '+201000000009', '[{"lineNumber":1,"quantity":1,"reason":"too_small"}]')->>'refusal'
    = 'ORDER_NOT_FOUND', 'R4 wrong phone cannot request';
  assert pg_temp.req(ref, '+201000000001', '[{"lineNumber":1,"quantity":3,"reason":"too_small"}]')->>'refusal'
    = 'RETURN_QUANTITY_EXCEEDED', 'R5 more than was delivered';
  assert pg_temp.req(ref, '+201000000001', '[{"lineNumber":7,"quantity":1,"reason":"too_small"}]')->>'refusal'
    = 'INVALID_RETURN_REQUEST', 'R6 unknown line';
  assert pg_temp.req(ref, '+201000000001', '[{"lineNumber":1,"quantity":1,"reason":"meh"}]')->>'refusal'
    = 'INVALID_RETURN_REQUEST', 'R7 unknown reason';
  assert pg_temp.req(ref, '+201000000001', '[{"lineNumber":1,"quantity":1.5,"reason":"other"}]')->>'refusal'
    = 'INVALID_RETURN_REQUEST', 'R8 fractional quantity';
  assert pg_temp.req(ref, '+201000000001', '[]')->>'refusal' = 'INVALID_RETURN_REQUEST', 'R9 empty';

  q := pg_temp.req(ref, '+201000000001', '[{"lineNumber":1,"quantity":1,"reason":"too_small"}]');
  assert q->'request'->>'reference' = ref || '-R1' and q->'request'->>'status' = 'requested', 'R10 request opened';
  assert (select preference = 'exchange' and customer_note = 'Size swap please' from public.return_requests
          where reference = ref || '-R1'), 'R11 preference and trimmed note stored';
  t := pg_temp.track(ref, '+201000000001');
  assert (t->'lines'->0->>'requestedQuantity')::int = 1 and (t->'lines'->0->>'returnableQuantity')::int = 1
     and jsonb_array_length(t->'returnRequests') = 1, 'R12 the open request holds its quantity';
  assert pg_temp.req(ref, '+201000000001', '[{"lineNumber":1,"quantity":2,"reason":"other"}]')->>'refusal'
    = 'RETURN_QUANTITY_EXCEEDED', 'R13 open requests count against what is left';
end $b$;

-- 5. Staff decisions -----------------------------------------------------------------------------------------
do $b$
declare
  ref text := (select r->>'orderReference' from placed);
  rid uuid := (select id from public.return_requests where reference = ref || '-R1');
  j jsonb;
begin
  j := online_private.set_return_request_status('2a000001-0000-4000-8000-000000000001', rid,
    '2a000012-0000-4000-8000-000000000001', 'declined', 'Worn item');
  assert j->>'status' = 'declined' and j->>'staffNote' = 'Worn item' and j->>'decidedAt' is not null
     and j->'lines'->0->>'reason' = 'too_small', 'D1 decline records the note';
  assert (pg_temp.track(ref, '+201000000001')->'lines'->0->>'returnableQuantity')::int = 2,
    'D2 a declined request frees its quantity';
  begin
    perform online_private.set_return_request_status('2a000001-0000-4000-8000-000000000001', rid,
      '2a000012-0000-4000-8000-000000000001', 'approved', null);
    raise exception 'D3 expected RQ409';
  exception when sqlstate 'RQ409' then null; end;
  begin
    perform online_private.set_return_request_status('2a000001-0000-4000-8000-000000000001', gen_random_uuid(),
      '2a000012-0000-4000-8000-000000000001', 'approved', null);
    raise exception 'D4 expected RQ404';
  exception when sqlstate 'RQ404' then null; end;
  assert online_private.set_return_request_status('2a000001-0000-4000-8000-000000000001', rid,
    '2a000012-0000-4000-8000-000000000001', 'declined', null)->>'status' = 'declined', 'D5 repeating is a no-op';

  assert pg_temp.req(ref, '+201000000001', '[{"lineNumber":1,"quantity":2,"reason":"damaged"}]')->'request'->>'reference'
    = ref || '-R2', 'D6 a second request is numbered R2';
  rid := (select id from public.return_requests where reference = ref || '-R2');
  perform online_private.set_return_request_status('2a000001-0000-4000-8000-000000000001', rid,
    '2a000012-0000-4000-8000-000000000001', 'approved', null);
  assert online_private.set_return_request_status('2a000001-0000-4000-8000-000000000001', rid,
    '2a000012-0000-4000-8000-000000000001', 'completed', null)->>'status' = 'completed', 'D7 approve then complete';
  assert pg_temp.track(ref, '+201000000001')->'returns'->>'reason' = 'NOTHING_TO_RETURN',
    'D8 a completed request keeps its quantity';
  assert jsonb_array_length(online_private.list_return_requests('2a000001-0000-4000-8000-000000000001', 'all', null, 50)) = 2
     and jsonb_array_length(online_private.list_return_requests('2a000001-0000-4000-8000-000000000001', 'open', null, 50)) = 0
     and online_private.list_return_requests('2a000001-0000-4000-8000-000000000001', 'completed', null, 50)->0->>'reference' = ref || '-R2'
     and online_private.list_return_requests('2a000001-0000-4000-8000-000000000001', 'all', null, 50)->0->>'customerPhone' = '+20 100 000 0001'
     and jsonb_array_length(online_private.list_return_requests(gen_random_uuid(), 'all', null, 50)) = 0,
    'D9 staff list filters by status and tenant';
end $b$;

-- 6. Window and cancellation ---------------------------------------------------------------------------------
update public.return_settings set window_days = 0 where tenant_id = '2a000001-0000-4000-8000-000000000001';
do $b$ begin
  assert pg_temp.track((select r->>'orderReference' from placed), '+201000000001')->'returns'->>'reason'
    = 'RETURN_WINDOW_EXPIRED', 'W1 outside the window';
end $b$;

-- 7. Throttle -------------------------------------------------------------------------------------------------
do $b$
declare ref text := (select r->>'orderReference' from placed);
begin
  delete from public.storefront_lookup_failures;
  for i in 1..8 loop
    perform pg_temp.track(ref, '+20111111111' || i);
  end loop;
  begin
    perform pg_temp.track(ref, '+201000000001');
    raise exception 'G1 expected TR429';
  exception when sqlstate 'TR429' then null; end;
  begin
    perform pg_temp.req(ref, '+201000000001', '[{"lineNumber":1,"quantity":1,"reason":"other"}]');
    raise exception 'G2 expected TR429';
  exception when sqlstate 'TR429' then null; end;
  update public.storefront_lookup_failures set created_at = now() - interval '16 minutes';
  assert pg_temp.track(ref, '+201000000001') is not null, 'G3 the lock lifts after 15 minutes';
  assert pg_temp.track('other-number', '+201000000001') is null, 'G4 other numbers are unaffected';
end $b$;

-- 8. Readable option names -------------------------------------------------------------------------------------
do $b$ begin
  assert online_private.readable_option_summary('2a000001-0000-4000-8000-000000000001', 'M · Black') = 'M · Black'
     and online_private.readable_option_summary('2a000001-0000-4000-8000-000000000001', ' ') is null
     and online_private.readable_option_summary('2a000001-0000-4000-8000-000000000001', gen_random_uuid()::text) is null,
    'O1 names pass through, blanks and unknown ids give null';
end $b$;

select 'ALL_STOREFRONT_TRACKING_RETURN_ASSERTIONS_PASSED' as result;
