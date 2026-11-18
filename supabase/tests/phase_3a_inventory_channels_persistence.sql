-- ADR-042 §3 channel stock pools: invariant, Website/POS isolation, shadow vs enforced, privileges.
-- Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql + phase_2l_online.setup.sql
-- (tenant ...0001, selling location ...4-...0001, variant ...7-...0001 with 10 opening units).
-- Steps are separate top-level statements so the deferred attribution trigger fires at real COMMIT.
\set ON_ERROR_STOP on

create or replace function pg_temp.key_state()
returns table(canonical bigint, website bigint, pos bigint, unallocated bigint, mismatch bigint)
language sql as $f$
  select r.canonical_on_hand, r.website_on_hand, r.pos_on_hand, r.unallocated_on_hand, r.mismatch
    from inventory_private.channel_reconciliation('2a000001-0000-4000-8000-000000000001',
                                                  '2a000004-0000-4000-8000-000000000001') r
   where r.variant_id = '2a000007-0000-4000-8000-000000000001';
$f$;

-- 1. Structure and privileges -------------------------------------------------------------------------
do $b$ begin
  assert (select count(*) = 4 from pg_tables where schemaname = 'public' and tableowner = 'inventory_writer'
            and tablename in ('inventory_channel_balances','inventory_channel_ledger','inventory_allocation_runs','inventory_channel_divergences')),
    'S1 channel tables exist and are owned by inventory_writer';
  assert (select bool_and(relrowsecurity) from pg_class where oid in (
            'public.inventory_channel_balances'::regclass, 'public.inventory_channel_ledger'::regclass,
            'public.inventory_allocation_runs'::regclass, 'public.inventory_channel_divergences'::regclass)),
    'S2 RLS enabled on every channel table';
  assert not has_table_privilege('anon', 'public.inventory_channel_balances', 'select')
     and not has_table_privilege('authenticated', 'public.inventory_channel_balances', 'select')
     and not has_table_privilege('authenticated', 'public.inventory_channel_ledger', 'insert'),
    'S3 anon/authenticated cannot read or write channel stock';
  assert not has_table_privilege('service_role', 'public.inventory_channel_balances', 'update')
     and not has_function_privilege('service_role', 'inventory_private.channel_try_apply(uuid,uuid,uuid,text,bigint,uuid)', 'execute')
     and has_function_privilege('service_role', 'inventory_private.allocate_channel_stock_v2(uuid,uuid,uuid,text,text,jsonb)', 'execute')
     -- ADR-042 §3.5: the unguarded split (no allocation-version check) is no longer an API entry point.
     and not has_function_privilege('service_role', 'inventory_private.allocate_channel_stock(uuid,uuid,uuid,text,text,jsonb)', 'execute'),
    'S4 server can only use the guarded management entry points, never mutate buckets directly';
  assert (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'inventory_private' and p.proname like '%channel%' and p.proname <> 'guard_allocation_run_mutation'),
    'S5 every channel function is SECURITY DEFINER with an empty search_path';
  assert (select bool_and(channel_stock_mode = 'legacy') from public.inventory_locations), 'S6 every location starts legacy';
  assert (select not enforcement_unlocked from inventory_private.channel_feature_gate), 'S7 enforced mode is locked';
end $b$;

-- 2. Legacy behaviour is unchanged --------------------------------------------------------------------
set role service_role;
select pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','ch-legacy-sale',2500,2500,'[{"variant_id":"2a000007-0000-4000-8000-000000000001","quantity":1}]');
reset role;
do $b$ begin
  assert (select count(*) = 0 from public.inventory_channel_balances), 'L1 legacy sale creates no channel rows';
  assert (select count(*) = 0 from public.inventory_channel_ledger), 'L2 legacy sale writes no channel ledger';
  assert (select count(*) = 0 from inventory_private.channel_pending_movements), 'L3 no pending work left';
  assert (select on_hand_quantity = 9 from public.inventory_balances where variant_id = '2a000007-0000-4000-8000-000000000001'
            and inventory_location_id = '2a000004-0000-4000-8000-000000000001'), 'L4 canonical stock decremented as before';
end $b$;

-- 3. Initialization: all stock unallocated, no guessed split ------------------------------------------
do $b$ begin
  begin
    perform inventory_private.set_channel_stock_mode('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','shadow','2a000012-0000-4000-8000-000000000001','too early');
    raise exception 'I0 expected CH412';
  exception when sqlstate 'CH412' then null; end;
end $b$;
set role service_role;
select inventory_private.initialize_channel_stock('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000001');
reset role;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 9 and s.unallocated = 9 and s.website = 0 and s.pos = 0 and s.mismatch = 0, 'I1 initialize puts all 9 in unallocated';
  assert (select channel_stock_mode = 'shadow' from public.inventory_locations where id = '2a000004-0000-4000-8000-000000000001'), 'I2 location now shadow';
  assert (select channel_stock_mode = 'legacy' from public.inventory_locations where id = '2a000004-0000-4000-8000-000000000002'), 'I3 other location stays legacy';
  assert (select count(*) = 1 from public.inventory_channel_ledger where event_type = 'opening_allocation' and quantity_delta = 9), 'I4 opening ledger entry';
  begin
    perform inventory_private.initialize_channel_stock('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001',null);
    raise exception 'I5 expected CH409';
  exception when sqlstate 'CH409' then null; end;
end $b$;

-- 4. Admin split: validation, idempotency, evidence ---------------------------------------------------
do $b$ declare t uuid := '2a000001-0000-4000-8000-000000000001'; l uuid := '2a000004-0000-4000-8000-000000000001';
  v text := '2a000007-0000-4000-8000-000000000001'; a uuid := '2a000012-0000-4000-8000-000000000001'; r1 uuid; r2 uuid; s record;
begin
  begin
    perform inventory_private.allocate_channel_stock(t, l, a, 'too much', 'ch-alloc-over', jsonb_build_array(jsonb_build_object('variantId', v, 'websiteQuantity', 5, 'posQuantity', 5)));
    raise exception 'A1 expected CH422';
  exception when sqlstate 'CH422' then null; end;
  begin
    perform inventory_private.allocate_channel_stock(t, l, a, 'stale', 'ch-alloc-stale', jsonb_build_array(jsonb_build_object('variantId', v, 'websiteQuantity', 1, 'posQuantity', 1, 'expectedBalanceVersion', 0)));
    raise exception 'A2 expected CH409';
  exception when sqlstate 'CH409' then null; end;
  begin
    perform inventory_private.allocate_channel_stock(t, l, a, 'dup', 'ch-alloc-dup', jsonb_build_array(
      jsonb_build_object('variantId', v, 'websiteQuantity', 1, 'posQuantity', 1),
      jsonb_build_object('variantId', v, 'websiteQuantity', 1, 'posQuantity', 1)));
    raise exception 'A3 expected 22023';
  exception when sqlstate '22023' then null; end;
  r1 := inventory_private.allocate_channel_stock(t, l, a, 'Initial split', 'ch-alloc-1', jsonb_build_array(jsonb_build_object('variantId', v, 'websiteQuantity', 4, 'posQuantity', 5)));
  r2 := inventory_private.allocate_channel_stock(t, l, a, 'Initial split', 'CH-ALLOC-1 ', jsonb_build_array(jsonb_build_object('variantId', v, 'websiteQuantity', 4, 'posQuantity', 5)));
  assert r1 = r2, 'A4 exact replay returns the same run';
  begin
    perform inventory_private.allocate_channel_stock(t, l, a, 'Initial split', 'ch-alloc-1', jsonb_build_array(jsonb_build_object('variantId', v, 'websiteQuantity', 3, 'posQuantity', 5)));
    raise exception 'A5 expected ID409';
  exception when sqlstate 'ID409' then null; end;
  select * into s from pg_temp.key_state();
  assert s.website = 4 and s.pos = 5 and s.unallocated = 0 and s.mismatch = 0, 'A6 split applied, sum = canonical';
  assert (select lines -> 0 -> 'after' = '{"website":4,"pos":5,"unallocated":0}'::jsonb and lines -> 0 -> 'before' ->> 'unallocated' = '9'
            from public.inventory_allocation_runs where id = r1), 'A7 run records before/after evidence';
  assert (select count(*) = 3 from public.inventory_channel_ledger where allocation_run_id = r1), 'A8 one ledger row per changed bucket';
  begin
    update public.inventory_allocation_runs set reason = 'tamper' where id = r1;
    raise exception 'A9 expected 55000';
  exception when sqlstate '55000' then null; end;
  begin
    update public.inventory_channel_ledger set quantity_delta = 99 where allocation_run_id = r1;
    raise exception 'A10 expected immutability error';
  exception when others then
    if sqlerrm like 'A10%' then raise; end if;
  end;
end $b$;

-- 4b. Entry points work under the server role's real privileges (not superuser) ---------------------
set role service_role;
do $b$ declare r record; begin
  begin
    perform inventory_private.allocate_channel_stock_v2('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001',
      '2a000012-0000-4000-8000-000000000001','unknown','ch-alloc-unknown-variant',
      '[{"variantId":"2a000007-0000-4000-8000-0000000000ff","websiteQuantity":0,"posQuantity":0,"expectedBalanceVersion":0,"expectedAllocationVersion":0}]');
    raise exception 'A11 expected CH404';
  exception when sqlstate 'CH404' then null; end;
  begin
    perform inventory_private.allocate_channel_stock('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001',
      '2a000012-0000-4000-8000-000000000001','unguarded','ch-alloc-unguarded',
      '[{"variantId":"2a000007-0000-4000-8000-000000000001","websiteQuantity":0,"posQuantity":0}]');
    raise exception 'A11b expected 42501 (unguarded split is not an API entry point)';
  exception when insufficient_privilege then null; end;
  select * into r from inventory_private.channel_availability('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001')
   where variant_id = '2a000007-0000-4000-8000-000000000001';
  assert r.website_on_hand = 4 and r.pos_on_hand = 5 and r.explicitly_allocated, 'A12 service_role can read availability';
end $b$;
reset role;

-- 5. POS sale consumes POS only; Website untouched (committed) -----------------------------------------
set role service_role;
select pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','ch-pos-sale-1',5000,5000,'[{"variant_id":"2a000007-0000-4000-8000-000000000001","quantity":2}]');
reset role;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 7 and s.pos = 3 and s.website = 4 and s.unallocated = 0 and s.mismatch = 0, 'P1 POS sale: pos 5->3, website stays 4';
  assert (select count(*) = 1 from public.inventory_channel_ledger where event_type = 'pos_sale' and channel = 'pos' and quantity_delta = -2), 'P2 pos_sale ledger entry';
  assert (select count(*) = 0 from public.inventory_channel_ledger where event_type = 'pos_sale' and channel <> 'pos'), 'P3 no other bucket touched';
  assert (select count(*) = 0 from inventory_private.channel_pending_movements), 'P4 pending queue drained at commit';
end $b$;

-- 6. Website order: reservation limits allocation; fulfilment consumes Website only -------------------
set role service_role;
select online_private.place_checkout('ch-web-1', '{
 "tenantId":"2a000001-0000-4000-8000-000000000001","brandId":"2a000002-0000-4000-8000-000000000001",
 "lines":[{"variantId":"2a000007-0000-4000-8000-000000000001","quantity":1}],
 "customer":{"name":"Guest","phone":"+201001234567","email":"guest@example.com"},
 "delivery":{"recipientName":"Guest","phone":"+201001234567","line1":"Street","line2":null,"city":"Cairo","region":null,"postalCode":null,"countryCode":"EG","notes":null},
 "expectedTotalMinor":2500,"expectedCurrency":"USD","paymentMethod":"cash_on_delivery"}');
reset role;
do $b$ declare av record; begin
  select * into av from inventory_private.channel_availability('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001')
   where variant_id = '2a000007-0000-4000-8000-000000000001';
  assert av.website_reserved = 1 and av.website_available = 3 and av.pos_available = 3, 'W1 website hold reduces website availability only';
  begin
    perform inventory_private.allocate_channel_stock('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001',
      '2a000012-0000-4000-8000-000000000001','steal held stock','ch-alloc-held',
      '[{"variantId":"2a000007-0000-4000-8000-000000000001","websiteQuantity":0,"posQuantity":7}]');
    raise exception 'W2 expected CH422';
  exception when sqlstate 'CH422' then null; end;
end $b$;
set role service_role;
select * from fulfillments_private.record_fulfillment('2a000001-0000-4000-8000-000000000001',
  (select id from public.orders where channel = 'online'), '2a000004-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001', 'ch-web-fulfil-1', now(),
  jsonb_build_array(jsonb_build_object('order_line_id', (select ol.id from public.order_lines ol join public.orders o on o.id = ol.order_id where o.channel = 'online'), 'quantity', 1)));
reset role;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 6 and s.website = 3 and s.pos = 3 and s.mismatch = 0, 'W3 website fulfilment: website 4->3, pos stays 3';
  assert (select count(*) = 1 from public.inventory_channel_ledger where event_type = 'website_sale' and channel = 'website' and quantity_delta = -1), 'W4 website_sale ledger entry';
end $b$;

-- 7. Receiving lands in unallocated (owner D-1) --------------------------------------------------------
select inventory_private.record_operation('2a000001-0000-4000-8000-000000000001', 'receipt',
  '[{"variant_id":"2a000007-0000-4000-8000-000000000001","inventory_location_id":"2a000004-0000-4000-8000-000000000001","quantity_delta":5}]',
  '2a000012-0000-4000-8000-000000000001', 'ch-receipt-1', null, null);
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 11 and s.unallocated = 5 and s.website = 3 and s.pos = 3 and s.mismatch = 0, 'R1 receipt goes to unallocated only';
end $b$;

-- 8. Shadow never blocks a sale: POS overdraw is logged, not refused; allocation heals ----------------
set role service_role;
select pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','ch-pos-sale-over',10000,10000,'[{"variant_id":"2a000007-0000-4000-8000-000000000001","quantity":4}]');
reset role;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 7 and s.pos = 3 and s.website = 3 and s.mismatch = -4, 'D1 shadow: sale succeeded, buckets untouched, mismatch visible';
  assert (select count(*) = 1 from public.inventory_channel_divergences where code = 'CH_INSUFFICIENT' and quantity_delta = -4), 'D2 divergence logged';
  perform inventory_private.allocate_channel_stock('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001',
    '2a000012-0000-4000-8000-000000000001','Re-split after overdraw','ch-alloc-heal',
    '[{"variantId":"2a000007-0000-4000-8000-000000000001","websiteQuantity":3,"posQuantity":2}]');
  select * into s from pg_temp.key_state();
  assert s.website = 3 and s.pos = 2 and s.unallocated = 2 and s.mismatch = 0, 'D3 allocation re-derives unallocated and heals the key';
end $b$;

-- 9. Accepted sellable POS return restocks POS only ----------------------------------------------------
do $b$ declare t uuid := '2a000001-0000-4000-8000-000000000001'; o uuid; l uuid; s record; begin
  select ps.order_id into o from public.pos_sales ps where ps.normalized_idempotency_key = 'ch-pos-sale-1';
  select id into l from public.order_lines where tenant_id = t and order_id = o;
  perform returns_private.accept_return(t, o, '2a000012-0000-4000-8000-000000000001', 'management', 'ch-return-1',
    jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderLineId', l, 'quantity', 1, 'reason', 'size', 'disposition', 'restock')),
      'inventoryLocationId', '2a000004-0000-4000-8000-000000000001', 'refundMode', 'manual_confirmed', 'settlementReference', 'cash'));
end $b$;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 8 and s.pos = 3 and s.website = 3 and s.unallocated = 2 and s.mismatch = 0, 'T1 POS return restocks pos only';
  assert (select count(*) = 1 from public.inventory_channel_ledger where event_type = 'pos_return_restock' and channel = 'pos' and quantity_delta = 1), 'T2 restock ledger entry';
end $b$;

-- 10. Enforced mode: locked by the gate; when unlocked, overdraw is refused with no partial effect ----
do $b$ begin
  begin
    perform inventory_private.set_channel_stock_mode('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','enforced','2a000012-0000-4000-8000-000000000001','go live');
    raise exception 'E1 expected CH423';
  exception when sqlstate 'CH423' then null; end;
end $b$;
-- Test-only: unlock the deployment gate on this disposable database (production unlock needs a migration).
update inventory_private.channel_feature_gate set enforcement_unlocked = true;
select inventory_private.set_channel_stock_mode('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','enforced','2a000012-0000-4000-8000-000000000001','pilot');
do $b$ declare s record; v_before bigint; begin
  assert (select channel_stock_mode = 'enforced' from public.inventory_locations where id = '2a000004-0000-4000-8000-000000000001'), 'E2 reconciled + fully split location can enter enforced';
  select on_hand_quantity into v_before from public.inventory_balances where variant_id = '2a000007-0000-4000-8000-000000000001' and inventory_location_id = '2a000004-0000-4000-8000-000000000001';
  begin
    perform pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
      '2a000012-0000-4000-8000-000000000001','ch-pos-sale-enforced-over',10000,10000,'[{"variant_id":"2a000007-0000-4000-8000-000000000001","quantity":4}]');
    set constraints all immediate;
    raise exception 'E3 expected CH409';
  exception when sqlstate 'CH409' then null; end;
  set constraints all deferred;
  assert (select on_hand_quantity = v_before from public.inventory_balances where variant_id = '2a000007-0000-4000-8000-000000000001' and inventory_location_id = '2a000004-0000-4000-8000-000000000001'),
    'E4 refused POS overdraw leaves canonical stock unchanged';
  select * into s from pg_temp.key_state();
  assert s.website = 3 and s.pos = 3 and s.mismatch = 0, 'E5 refused POS overdraw never touches website';
end $b$;
set role service_role;
select pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','ch-pos-sale-enforced-ok',7500,7500,'[{"variant_id":"2a000007-0000-4000-8000-000000000001","quantity":3}]');
reset role;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 5 and s.pos = 0 and s.website = 3 and s.unallocated = 2 and s.mismatch = 0, 'E6 enforced POS sale within pool: pos 3->0, website 3 unchanged';
  assert (select count(*) = 0 from inventory_private.channel_pending_movements), 'E7 nothing pending';
  assert (select count(*) = 0 from public.inventory_channel_balances where inventory_location_id = '2a000004-0000-4000-8000-000000000002'), 'E8 legacy location never gained channel rows';
end $b$;

-- 11. Storefront read path (20261114150000): enforced website sees and sells only its bucket ----------
create function pg_temp.web_available() returns bigint language sql as $f$
  select (v->>'availableQuantity')::bigint
    from public.products p,
         jsonb_array_elements(catalog_public.build_published_product(p)->'variants') v
   where p.id = (select product_id from public.product_variants where id = '2a000007-0000-4000-8000-000000000001')
     and v->>'id' = '2a000007-0000-4000-8000-000000000001';
$f$;
create function pg_temp.checkout_intent(p_qty int) returns jsonb language sql as $f$
  select jsonb_build_object(
    'tenantId','2a000001-0000-4000-8000-000000000001','brandId','2a000002-0000-4000-8000-000000000001',
    'lines',jsonb_build_array(jsonb_build_object('variantId','2a000007-0000-4000-8000-000000000001','quantity',p_qty)),
    'customer',jsonb_build_object('name','Guest','phone','+201001234567','email','guest@example.com'),
    'delivery',jsonb_build_object('recipientName','Guest','phone','+201001234567','line1','Street','line2',null,'city','Cairo',
      'region',null,'postalCode',null,'countryCode','EG','notes',null),
    'expectedTotalMinor',2500 * p_qty,'expectedCurrency','USD','paymentMethod','cash_on_delivery');
$f$;
do $b$ begin
  -- canonical 5 = website 3 + pos 0 + unallocated 2; no open website holds.
  assert pg_temp.web_available() = 3, 'SF1 enforced storefront shows the website bucket (3), not canonical (5)';
  begin
    perform online_private.place_checkout('ch-web-enforced-over', pg_temp.checkout_intent(4));
    raise exception 'SF2 expected 23514';
  exception when sqlstate '23514' then null; end;
  assert (select count(*) = 0 from public.checkout_operations where normalized_key like '%ch-web-enforced-over%'), 'SF3 refused checkout left no order';
end $b$;
set role service_role;
select online_private.place_checkout('ch-web-enforced-ok', pg_temp.checkout_intent(3));
reset role;
do $b$ declare s record; begin
  assert pg_temp.web_available() = 0, 'SF4 website bucket fully held after a 3-unit checkout';
  select * into s from pg_temp.key_state();
  assert s.canonical = 5 and s.website = 3 and s.pos = 0 and s.unallocated = 2 and s.mismatch = 0, 'SF5 a hold moves no bucket';
  begin
    perform online_private.place_checkout('ch-web-enforced-more', pg_temp.checkout_intent(1));
    raise exception 'SF6 expected 23514';
  exception when sqlstate '23514' then null; end;
end $b$;
-- Back to shadow: the storefront returns to canonical - holds (5 - 3 = 2); unallocated stock is visible again.
select inventory_private.set_channel_stock_mode('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','shadow','2a000012-0000-4000-8000-000000000001','pause');
do $b$ begin
  assert pg_temp.web_available() = 2, 'SF7 shadow storefront uses canonical on-hand minus holds';
  assert has_function_privilege('anon', 'inventory_private.channel_online_sellable(uuid,uuid,uuid,bigint)', 'execute') = false, 'SF8 helper not public';
end $b$;

-- 12. Accepted sellable WEBSITE return lands in unallocated only (ADR-042 §3.3 default), here in shadow mode -----
create temp table web_return_before as select * from pg_temp.key_state();
do $b$ declare t uuid := '2a000001-0000-4000-8000-000000000001'; o uuid; l uuid; begin
  select id into o from public.orders where tenant_id = t and channel = 'online' order by created_at limit 1;
  select ol.id into l from public.order_lines ol where ol.tenant_id = t and ol.order_id = o limit 1;
  -- Fixture: the COD amount was collected on delivery (a refund needs a captured payment).
  perform payments_private.transition_payment(t, o, 'captured');
  perform returns_private.accept_return(t, o, '2a000012-0000-4000-8000-000000000001', 'management', 'ch-return-web-1',
    jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderLineId', l, 'quantity', 1, 'reason', 'size', 'disposition', 'restock')),
      'inventoryLocationId', '2a000004-0000-4000-8000-000000000001', 'refundMode', 'manual_confirmed', 'settlementReference', 'cash'));
end $b$;
do $b$ declare s record; b record; begin
  select * into b from web_return_before;
  select * into s from pg_temp.key_state();
  assert s.canonical = b.canonical + 1 and s.unallocated = b.unallocated + 1 and s.website = b.website
     and s.pos = b.pos and s.mismatch = 0, 'T3 website return restocks unallocated only (website and pos untouched)';
  assert (select count(*) = 1 from public.inventory_channel_ledger where channel = 'unallocated'
            and event_type = 'return_restock_unallocated' and quantity_delta = 1), 'T4 website return ledgered to unallocated';
  assert (select count(*) = 1 from public.inventory_channel_ledger where channel = 'pos'
            and event_type = 'pos_return_restock'), 'T5 no extra POS credit for the website return';
  raise notice 'ALL_INVENTORY_CHANNEL_ASSERTIONS_PASSED';
end $b$;

