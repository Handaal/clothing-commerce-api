-- ADR-042 §13 — online-first POS / bounded emergency offline / post-sync conflicts.
-- Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql + phase_2i_offline_pos.setup.sql +
-- phase_2l_online.setup.sql. Variant ...7-...0001 at location ...4-...0001 (price 2500, 10 units; offline policy:
-- max 3 per line, 3 pending sales, 6000 per sale). Separate top-level statements so each step commits.
\set ON_ERROR_STOP on

create function pg_temp.fp(p jsonb) returns text language sql as $f$ select encode(sha256(convert_to(p::text, 'utf8')), 'hex'); $f$;
create function pg_temp.cred(p_grant uuid) returns uuid language sql as $f$
  select c.id from public.device_credentials c join public.offline_grants g on g.device_id = c.device_id where g.id = p_grant limit 1;
$f$;
create function pg_temp.grant_for(p_key text) returns uuid language sql as $f$
  select g.id from offline_pos_private.issue_grant('2a000001-0000-4000-8000-000000000001', (select id from public.devices limit 1),
    '2a000005-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', p_key) g;
$f$;
create function pg_temp.on_hand() returns bigint language sql as $f$
  select on_hand_quantity from public.inventory_balances
   where variant_id = '2a000007-0000-4000-8000-000000000001' and inventory_location_id = '2a000004-0000-4000-8000-000000000001';
$f$;
create function pg_temp.ledger_sum() returns bigint language sql as $f$
  select coalesce(sum(quantity_delta), 0) from public.inventory_movements
   where variant_id = '2a000007-0000-4000-8000-000000000001' and inventory_location_id = '2a000004-0000-4000-8000-000000000001';
$f$;
create function pg_temp.sale(p_grant uuid, p_sync uuid, p_ordinal int, p_qty int, p_customer uuid default null) returns jsonb
language sql as $f$
  select jsonb_build_object(
    'schemaVersion', 1, 'localSaleId', 'local-' || p_sync, 'syncCommandId', p_sync, 'grantId', g.id,
    'deviceId', g.device_id, 'registerId', g.register_id, 'acceptedAt', now(), 'currency', g.currency,
    'lines', jsonb_build_array(jsonb_build_object('variantId', '2a000007-0000-4000-8000-000000000001',
      'quantity', p_qty, 'grantedUnitPriceMinor', 2500,
      'priceId', (select v.value->>'priceId' from jsonb_array_elements(g.catalog_snapshot) p(value),
                   lateral jsonb_array_elements(p.value->'variants') v(value)
                  where v.value->>'variantId' = '2a000007-0000-4000-8000-000000000001'))),
    'totalMinor', 2500 * p_qty, 'cashReceivedMinor', case when p_customer is null then 2500 * p_qty else 1000 end, 'changeMinor', 0,
    'offlineSaleOrdinal', p_ordinal, 'cumulativeExposureMinor', 2500 * p_qty)
    || case when p_customer is null then '{}'::jsonb else jsonb_build_object('customerId', p_customer,
         'amountPaidMinor', 1000, 'outstandingMinor', 2500 * p_qty - 1000) end
  from public.offline_grants g where g.id = p_grant;
$f$;
create function pg_temp.ingest(p_sale jsonb) returns record language sql as $f$
  select r.sync_status, r.order_id, r.reconciliation_id, r.ingestion_id from offline_pos_private.record_offline_sale('2a000001-0000-4000-8000-000000000001',
    pg_temp.cred((p_sale->>'grantId')::uuid), p_sale, p_sale::text, pg_temp.fp(p_sale), 'c2FsZQ==') r;
$f$;
create function pg_temp.payment(p_grant uuid, p_sync uuid, p_amount bigint) returns jsonb language sql as $f$
  select jsonb_build_object('schemaVersion', 1, 'localPaymentId', 'pay-' || p_sync, 'syncCommandId', p_sync, 'grantId', g.id,
    'deviceId', g.device_id, 'registerId', g.register_id, 'acceptedAt', now(), 'currency', g.currency,
    'customerId', '2a000030-0000-4000-8000-000000000001', 'amountMinor', p_amount)
  from public.offline_grants g where g.id = p_grant;
$f$;
create function pg_temp.clock(p_grant uuid, p_sync uuid, p_type text) returns jsonb language sql as $f$
  select jsonb_build_object('schemaVersion', 1, 'localEventId', 'evt-' || p_sync, 'syncCommandId', p_sync, 'grantId', g.id,
    'deviceId', g.device_id, 'registerId', g.register_id, 'acceptedAt', now(), 'eventAt', now(), 'eventType', p_type,
    'operatorMembershipId', g.operator_membership_id)
  from public.offline_grants g where g.id = p_grant;
$f$;
create function pg_temp.conflict(p_kind text, p_cmd jsonb, p_refusal text) returns record language sql as $f$
  select r.conflict_ingestion_id, r.conflict_id, r.reason_code from offline_pos_private.record_offline_conflict(
    '2a000001-0000-4000-8000-000000000001', pg_temp.cred((p_cmd->>'grantId')::uuid), p_kind, p_cmd, p_cmd::text,
    pg_temp.fp(p_cmd), 'c2ln', p_refusal) r;
$f$;

-- 0. Structure, privileges, retired entry points -----------------------------------------------------------
do $b$ begin
  assert (select relrowsecurity from pg_class where oid = 'public.pos_sync_conflicts'::regclass), 'P1 RLS on pos_sync_conflicts';
  assert (select relrowsecurity from pg_class where oid = 'public.offline_conflict_ingestions'::regclass), 'P2 RLS on conflict ingestions';
  assert not has_table_privilege('anon', 'public.pos_sync_conflicts', 'select'), 'P3 anon cannot read conflicts';
  assert not has_table_privilege('authenticated', 'public.pos_sync_conflicts', 'select'), 'P4 authenticated cannot read conflicts directly';
  assert has_table_privilege('service_role', 'public.pos_sync_conflicts', 'select'), 'P5 server reads conflicts';
  assert not has_table_privilege('service_role', 'public.pos_sync_conflicts', 'insert'), 'P6 server cannot write conflicts directly';
  assert has_table_privilege('service_role', 'public.offline_conflict_ingestions', 'select'), 'P6b server reads preserved commands (replay check)';
  assert not has_table_privilege('service_role', 'public.offline_conflict_ingestions', 'insert'), 'P6c server cannot write evidence directly';
  assert has_function_privilege('service_role', 'offline_pos_private.record_offline_conflict(uuid,uuid,text,jsonb,text,text,text,text)', 'execute'), 'P7 server preserves refused commands';
  assert not has_function_privilege('anon', 'offline_pos_private.record_offline_conflict(uuid,uuid,text,jsonb,text,text,text,text)', 'execute'), 'P8 anon cannot';
  assert not has_function_privilege('service_role', 'inventory_private.initialize_channel_stock(uuid,uuid,uuid)', 'execute'), 'R1 channel init retired';
  assert not has_function_privilege('service_role', 'inventory_private.allocate_channel_stock(uuid,uuid,uuid,text,text,jsonb)', 'execute'), 'R2 channel split retired';
  assert not has_function_privilege('service_role', 'inventory_private.issue_offline_stock_grant(uuid,uuid,jsonb,uuid,integer)', 'execute'), 'R3 stock grants retired';
  assert not has_function_privilege('service_role', 'promotions_private.issue_offline_voucher_grants(uuid,uuid,uuid,integer)', 'execute'), 'R4 voucher quota grants retired';
  assert not has_function_privilege('service_role', 'offline_pos_private.issue_return_grant(uuid,uuid,uuid,uuid,uuid,text)', 'execute'), 'R5 return grants retired';
  assert not has_function_privilege('service_role', 'offline_pos_private.record_offline_return(uuid,uuid,jsonb,text,text,text)', 'execute'), 'R6 offline returns retired';
  assert to_regprocedure('inventory_private.allocate_channel_stock_v2(uuid,uuid,uuid,text,text,jsonb)') is null, 'R7 withdrawn split v2 not installed';
  assert to_regprocedure('payments_private.offline_tender_awaiting_confirmation()') is null, 'R8 withdrawn pending-tender trigger not installed';
  assert (select bool_and(channel_stock_mode = 'legacy') from public.inventory_locations), 'L1 every location on shared stock';
end $b$;
do $b$ begin
  begin
    update public.inventory_locations set channel_stock_mode = 'shadow' where id = '2a000004-0000-4000-8000-000000000001';
    raise exception 'L2 expected CH410';
  exception when sqlstate 'CH410' then null; end;
  begin
    update public.inventory_locations set channel_stock_mode = 'enforced' where id = '2a000004-0000-4000-8000-000000000001';
    raise exception 'L3 expected CH410';
  exception when sqlstate 'CH410' then null; end;
end $b$;

select offline_pos_private.enroll_device('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','till-1','Till 1','c3BraS1rZXk=',repeat('cd',32),'1.0.0','win32','11','oc-enroll-1');
create temp table g(name text primary key, id uuid);
create temp table cmd(name text primary key, body jsonb);
create temp table ref(name text primary key, id uuid);

-- 1. Installment + paydown conflict (while stock is plentiful) -------------------------------------------
insert into g values ('g0', pg_temp.grant_for('oc-grant-0'));
insert into cmd values ('inst', pg_temp.sale((select id from g where name='g0'), '3b000000-0000-4000-8000-000000000001', 1, 1, '2a000030-0000-4000-8000-000000000001'));
do $b$ declare r record; begin
  select * into r from pg_temp.ingest((select body from cmd where name='inst')) as x(s text, o uuid, rc uuid, i uuid);
  assert r.s = 'synced', 'I1 offline installment synced (outstanding 1500)';
  assert customers_ar_private.customer_outstanding('2a000001-0000-4000-8000-000000000001','2a000030-0000-4000-8000-000000000001') = 1500, 'I2 outstanding 1500';
end $b$;
-- Website/online paydown while the till was offline reduces the debt to 500 (connected AR path).
select customers_ar_private.record_customer_payment('2a000001-0000-4000-8000-000000000001','2a000030-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','oc-online-pay-1', '{"amountMinor":1000}'::jsonb);
insert into cmd values ('pay', pg_temp.payment((select id from g where name='g0'), '3b000000-0000-4000-8000-0000000000a1', 1500));
do $b$ declare r record; r2 record; v_payments bigint; begin
  select count(*) into v_payments from public.customer_payments;
  begin
    perform * from offline_pos_private.record_offline_customer_payment('2a000001-0000-4000-8000-000000000001',
      pg_temp.cred((select id from g where name='g0')), (select body from cmd where name='pay'), (select body::text from cmd where name='pay'),
      pg_temp.fp((select body from cmd where name='pay')), 'c2ln');
    raise exception 'D1 expected CA409 (stale debt: 1500 paid offline, 500 outstanding)';
  exception when sqlstate 'CA409' then null; end;
  select * into r from pg_temp.conflict('customer_payment', (select body from cmd where name='pay'), 'CA409') as x(ci uuid, c uuid, rc text);
  assert r.rc = 'PAYDOWN_EXCEEDS_OUTSTANDING', 'D2 paydown preserved as a customer_debt conflict';
  select * into r2 from pg_temp.conflict('customer_payment', (select body from cmd where name='pay'), 'CA409') as x(ci uuid, c uuid, rc text);
  assert r2.ci = r.ci and r2.c = r.c, 'D3 exact replay returns the same evidence + conflict';
  assert (select count(*) = 1 from public.pos_sync_conflicts where kind = 'customer_debt'), 'D4 no duplicate conflict';
  assert (select count(*) from public.customer_payments) = v_payments, 'D5 AR ledger untouched by the preserved paydown';
  assert (select amount_minor = 1500 and (server_evidence->>'outstandingAtSyncMinor')::bigint = 500 and (server_evidence->>'appliedToLedger')::boolean = false
            and local_evidence->>'tenderRecordedBy' = 'cashier' from public.pos_sync_conflicts where id = r.c), 'D6 evidence: amount, outstanding, not applied, cashier tender';
  begin
    perform * from pg_temp.conflict('customer_payment', (select body from cmd where name='pay') || '{"amountMinor":1499}', 'CA409') as x(ci uuid, c uuid, rc text);
    raise exception 'D7 expected ID409 (different content, same sync id)';
  exception when sqlstate 'ID409' then null; end;
end $b$;
-- A later debt increase must NOT let the preserved command be applied as well (never both).
insert into cmd values ('inst2', pg_temp.sale((select id from g where name='g0'), '3b000000-0000-4000-8000-000000000002', 2, 2, '2a000030-0000-4000-8000-000000000001'));
select * from pg_temp.ingest((select body from cmd where name='inst2')) as x(s text, o uuid, rc uuid, i uuid);
do $b$ declare v_payments bigint; begin
  select count(*) into v_payments from public.customer_payments;
  begin
    perform * from offline_pos_private.record_offline_customer_payment('2a000001-0000-4000-8000-000000000001',
      pg_temp.cred((select id from g where name='g0')), (select body from cmd where name='pay'), (select body::text from cmd where name='pay'),
      pg_temp.fp((select body from cmd where name='pay')), 'c2ln');
    raise exception 'D8 expected ID409 (already preserved as a conflict)';
  exception when sqlstate 'ID409' then null; end;
  assert (select count(*) from public.customer_payments) = v_payments, 'D9 apply attempt rolled back completely';
end $b$;

-- 2. Attendance duplicate preserved ----------------------------------------------------------------------
insert into cmd values ('in1', pg_temp.clock((select id from g where name='g0'), '3b000000-0000-4000-8000-0000000000b1', 'clock_in'));
insert into cmd values ('in2', pg_temp.clock((select id from g where name='g0'), '3b000000-0000-4000-8000-0000000000b2', 'clock_in'));
select * from offline_pos_private.record_offline_attendance('2a000001-0000-4000-8000-000000000001', pg_temp.cred((select id from g where name='g0')),
  (select body from cmd where name='in1'), (select body::text from cmd where name='in1'), pg_temp.fp((select body from cmd where name='in1')), 'c2ln');
do $b$ declare r record; begin
  begin
    perform * from offline_pos_private.record_offline_attendance('2a000001-0000-4000-8000-000000000001', pg_temp.cred((select id from g where name='g0')),
      (select body from cmd where name='in2'), (select body::text from cmd where name='in2'), pg_temp.fp((select body from cmd where name='in2')), 'c2ln');
    raise exception 'T1 expected AT409';
  exception when sqlstate 'AT409' then null; end;
  select * into r from pg_temp.conflict('attendance', (select body from cmd where name='in2'), 'AT409') as x(ci uuid, c uuid, rc text);
  assert r.rc = 'ALREADY_CLOCKED_IN', 'T2 duplicate clock-in preserved as attendance conflict';
  assert (select count(*) = 1 from public.offline_attendance_ingestions), 'T3 timeline has only the first event';
  assert (select (server_evidence->>'appliedToTimeline')::boolean = false and membership_id is not null from public.pos_sync_conflicts where id = r.c), 'T4 not applied, member referenced';
  begin
    perform * from pg_temp.conflict('attendance', (select body from cmd where name='in2') || '{"operatorMembershipId":"2a000012-0000-4000-8000-000000000002"}', 'AT409') as x(ci uuid, c uuid, rc text);
    raise exception 'T5 expected OG403 or ID409';
  exception when sqlstate 'OG403' then null; when sqlstate 'ID409' then null; end;
end $b$;

-- 3. Possible duplicate customer (flagged, never merged, no PII in the conflict) ---------------------------
do $b$ declare v_cmd jsonb; r record; begin
  v_cmd := jsonb_build_object('schemaVersion', 1, 'syncCommandId', '3b000000-0000-4000-8000-0000000000c1', 'localCustomerId', '3b0000cc-0000-4000-8000-000000000001',
    'grantId', (select id from g where name='g0'), 'deviceId', (select device_id from public.offline_grants where id = (select id from g where name='g0')),
    'registerId', '2a000005-0000-4000-8000-000000000001', 'acceptedAt', now(), 'name', 'Layla H', 'phone', '+201000000000');
  select x.customer_id, x.duplicate_of_customer_id into r from offline_pos_private.record_offline_customer('2a000001-0000-4000-8000-000000000001',
    pg_temp.cred((select id from g where name='g0')), v_cmd, v_cmd::text, pg_temp.fp(v_cmd), 'c2ln') x;
  assert r.duplicate_of_customer_id = '2a000030-0000-4000-8000-000000000001', 'C1 duplicate flagged';
  assert (select count(*) = 1 from public.pos_sync_conflicts where kind = 'customer_duplicate' and status = 'informational'
            and reason_code = 'POSSIBLE_DUPLICATE_CUSTOMER'), 'C2 informational duplicate conflict';
  assert (select bool_and(not (local_evidence::text ilike '%layla%' or server_evidence::text ilike '%201000000000%'
            or local_evidence ? 'phone' or local_evidence ? 'name')) from public.pos_sync_conflicts), 'C3 no customer name/phone in any conflict';
  assert (select name = 'Layla Hassan' from public.customers where id = '2a000030-0000-4000-8000-000000000001'), 'C4 existing customer untouched';
end $b$;

-- 4. CRITICAL: shared stock, POS offline, Website sells the remaining units, stale offline sale syncs ---------
-- Bring the shared balance to exactly 2 (connected online POS sales), then the till bootstraps (snapshot = 2).
do $b$ declare v_n bigint; begin
  v_n := pg_temp.on_hand() - 2;
  if v_n > 0 then
    perform pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000002',
      '2a000012-0000-4000-8000-000000000001','oc-connected-'||v_n, 2500 * v_n, 2500 * v_n,
      jsonb_build_array(jsonb_build_object('variant_id','2a000007-0000-4000-8000-000000000001','quantity', v_n)));
  end if;
  assert pg_temp.on_hand() = 2, 'S0 shared balance is 2 before the outage';
end $b$;
insert into g values ('g1', pg_temp.grant_for('oc-grant-1'));
do $b$ begin
  assert (select (v.value->'advisoryInventory'->>'onHandQuantity')::bigint = 2
            from public.offline_grants og, jsonb_array_elements(og.catalog_snapshot) p(value), jsonb_array_elements(p.value->'variants') v(value)
           where og.id = (select id from g where name='g1') and v.value->>'variantId' = '2a000007-0000-4000-8000-000000000001'), 'S1 till snapshot = 2';
  assert not exists (select 1 from public.offline_pos_stock_grants), 'S2 no per-till stock grant exists';
  assert not exists (select 1 from public.inventory_channel_balances), 'S3 no Website/POS bucket exists';
end $b$;
-- The till is now offline. The Website sells the same 2 units (real checkout + fulfilment on the shared pool).
select online_private.place_checkout('oc-web-1', '{
 "tenantId":"2a000001-0000-4000-8000-000000000001","brandId":"2a000002-0000-4000-8000-000000000001",
 "lines":[{"variantId":"2a000007-0000-4000-8000-000000000001","quantity":2}],
 "customer":{"name":"Guest","phone":"+201001234567","email":"guest@example.com"},
 "delivery":{"recipientName":"Guest","phone":"+201001234567","line1":"Street","line2":null,"city":"Cairo","region":null,"postalCode":null,"countryCode":"EG","notes":null},
 "expectedTotalMinor":5000,"expectedCurrency":"USD","paymentMethod":"cash_on_delivery"}');
insert into ref values ('web_order', (select id from public.orders where channel = 'online' order by created_at desc limit 1));
select * from fulfillments_private.record_fulfillment('2a000001-0000-4000-8000-000000000001',
  (select id from ref where name='web_order'), '2a000004-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001', 'oc-web-fulfil-1', now(),
  (select jsonb_agg(jsonb_build_object('order_line_id', ol.id, 'quantity', ol.quantity)) from public.order_lines ol where ol.order_id = (select id from ref where name='web_order')));
do $b$ begin
  assert pg_temp.on_hand() = 0, 'S4 Website sold the last 2 units; shared balance 0';
end $b$;
-- The offline till, from its stale snapshot (estimate 2), completes a 2-unit cash sale; then reconnects.
insert into cmd values ('stale', pg_temp.sale((select id from g where name='g1'), '3b000000-0000-4000-8000-0000000000d1', 1, 2));
do $b$ declare r record; r2 record; c record; v_orders bigint; v_payments bigint; begin
  select * into r from pg_temp.ingest((select body from cmd where name='stale')) as x(s text, o uuid, rc uuid, i uuid);
  insert into ref values ('pos_order', r.o), ('recon', r.rc);
  assert r.s = 'needs_reconciliation' and r.o is not null and r.rc is not null, 'S5 offline sale recorded (needs_reconciliation), never rejected';
  assert (select count(*) = 1 from public.payments where order_id = r.o and status = 'captured' and amount_minor = 5000), 'S6 cashier tender recorded in the ledger at the paid amount';
  assert pg_temp.on_hand() = 0, 'S7 canonical balance not driven negative';
  assert pg_temp.on_hand() = pg_temp.ledger_sum(), 'S8 balance = append-only ledger (internally valid)';
  assert not exists (select 1 from public.fulfillments where order_id = r.o), 'S9 no stock posted for the conflicted sale';
  assert (select count(*) = 1 from public.fulfillments where order_id = (select id from ref where name='web_order')), 'S10 Website order fulfilled exactly once';
  select * into c from public.pos_sync_conflicts where kind = 'stock_shortfall' and sync_command_id = '3b000000-0000-4000-8000-0000000000d1';
  assert c.id is not null and c.reason_code = 'STOCK_SHORTFALL_AT_SYNC' and c.status = 'open', 'S11 stock_shortfall conflict open';
  assert c.variant_id = '2a000007-0000-4000-8000-000000000001' and c.quantity = 2, 'S12 SKU + shortfall quantity 2';
  assert (c.local_evidence->>'cachedOnHand')::bigint = 2 and (c.local_evidence->>'requestedQuantity')::bigint = 2
     and c.local_evidence->>'sku' is not null and c.local_evidence ? 'cachedBalanceVersion', 'S13 cached snapshot evidence';
  assert (c.server_evidence->>'canonicalOnHandAtSync')::bigint = 0 and (c.server_evidence->>'stockPostedForSale')::boolean = false, 'S14 server evidence';
  assert exists (select 1 from jsonb_array_elements(c.server_evidence->'interveningMovements') m(value)
                  where m.value->>'orderChannel' = 'online' and (m.value->>'orderId')::uuid = (select id from ref where name='web_order')
                    and (m.value->>'quantityDelta')::bigint = -2), 'S15 intervening Website order + movement referenced';
  assert c.order_id = r.o and c.payment_id is not null and c.local_reference = 'local-3b000000-0000-4000-8000-0000000000d1'
     and c.register_id = '2a000005-0000-4000-8000-000000000001' and c.device_id is not null, 'S16 offline sale / order / payment / till references';
  -- Duplicate request / lost response after commit: exact replay returns the original, writes nothing.
  select count(*) into v_orders from public.orders; select count(*) into v_payments from public.payments;
  select * into r2 from pg_temp.ingest((select body from cmd where name='stale')) as x(s text, o uuid, rc uuid, i uuid);
  assert r2.i = r.i and r2.o = r.o and r2.rc = r.rc and r2.s = 'needs_reconciliation', 'S17 replay returns the original outcome';
  assert (select count(*) from public.orders) = v_orders and (select count(*) from public.payments) = v_payments, 'S18 replay wrote nothing';
  assert (select count(*) = 1 from public.pos_sync_conflicts where kind = 'stock_shortfall' and sync_command_id = '3b000000-0000-4000-8000-0000000000d1'), 'S19 conflict not duplicated';
  begin
    perform * from pg_temp.ingest((select body from cmd where name='stale') || '{"changeMinor":0,"localSaleId":"tampered"}') as x(s text, o uuid, rc uuid, i uuid);
    raise exception 'S20 expected ID409';
  exception when sqlstate 'ID409' then null; end;
end $b$;

-- 5. Out-of-order replay: ordinal 3 arrives before ordinal 2, both with stock available again -------------
select inventory_private.record_operation('2a000001-0000-4000-8000-000000000001','receipt',
  jsonb_build_array(jsonb_build_object('variant_id','2a000007-0000-4000-8000-000000000001','inventory_location_id','2a000004-0000-4000-8000-000000000001','quantity_delta',5)),
  null,'oc-receipt-1',null);
insert into cmd values ('o3', pg_temp.sale((select id from g where name='g1'), '3b000000-0000-4000-8000-0000000000e3', 3, 1));
insert into cmd values ('o2', pg_temp.sale((select id from g where name='g1'), '3b000000-0000-4000-8000-0000000000e2', 2, 1));
do $b$ declare a record; b record; begin
  select * into a from pg_temp.ingest((select body from cmd where name='o3')) as x(s text, o uuid, rc uuid, i uuid);
  select * into b from pg_temp.ingest((select body from cmd where name='o2')) as x(s text, o uuid, rc uuid, i uuid);
  assert a.s = 'synced' and b.s = 'synced', 'O1 out-of-order sales both sync when stock suffices';
  assert pg_temp.on_hand() = 3 and pg_temp.on_hand() = pg_temp.ledger_sum(), 'O2 balance 5-2 = 3, ledger valid';
  assert (select count(*) = 1 from public.pos_sync_conflicts where kind = 'stock_shortfall'), 'O3 no new stock conflict';
end $b$;

-- 6. Voucher exception (dormant D-2 path) feeds the report; immutability ------------------------------------
insert into public.offline_voucher_exceptions(tenant_id, order_id, offline_grant_id, sync_command_id, code, discount_total_minor)
values ('2a000001-0000-4000-8000-000000000001', (select id from ref where name='pos_order'), (select id from g where name='g1'),
        '3b000000-0000-4000-8000-0000000000d1', 'VX_REVOKED', 100);
do $b$ begin
  assert (select count(*) = 1 from public.pos_sync_conflicts where kind = 'voucher' and reason_code = 'VX_REVOKED'
            and (server_evidence->>'saleStandsAtPricePaid')::boolean and not (server_evidence->>'redemptionApproved')::boolean), 'V1 voucher conflict, sale stands, not an approval';
  begin
    update public.pos_sync_conflicts set status = 'informational';
    raise exception 'M1 expected immutable';
  exception when sqlstate '42501' then null; end;
  begin
    delete from public.pos_sync_conflicts;
    raise exception 'M2 expected immutable';
  exception when sqlstate '42501' then null; end;
end $b$;

select 'ALL_ONLINE_FIRST_SYNC_CONFLICT_ASSERTIONS_PASSED' as result;
