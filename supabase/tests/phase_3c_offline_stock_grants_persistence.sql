-- ADR-042 §4 offline POS stock grants. Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql +
-- phase_2i_offline_pos.setup.sql (tenant ...0001, register ...5-...0001 with an offline policy: max 3 per
-- line, 3 pending sales, 6000 per sale, 10000 cumulative; location ...4-...0001; variant ...7-...0001 at
-- 2500, 10 units). Separate top-level statements so the deferred channel trigger fires at real COMMIT.
\set ON_ERROR_STOP on

create function pg_temp.key_state()
returns table(canonical bigint, website bigint, pos bigint, unallocated bigint, mismatch bigint, pos_reserved bigint)
language sql as $f$
  select r.canonical_on_hand, r.website_on_hand, r.pos_on_hand, r.unallocated_on_hand, r.mismatch,
         (select b.reserved_qty from public.inventory_channel_balances b
           where b.inventory_location_id = '2a000004-0000-4000-8000-000000000001'
             and b.variant_id = '2a000007-0000-4000-8000-000000000001' and b.channel = 'pos')
    from inventory_private.channel_reconciliation('2a000001-0000-4000-8000-000000000001',
                                                  '2a000004-0000-4000-8000-000000000001') r
   where r.variant_id = '2a000007-0000-4000-8000-000000000001';
$f$;

-- Offline sale command for grant p_grant, as the till would sign it (the DB stores, never verifies, the signature).
create function pg_temp.sale(p_grant uuid, p_sync uuid, p_ordinal int, p_qty int, p_cumulative bigint) returns jsonb
language sql as $f$
  select jsonb_build_object(
    'schemaVersion', 1, 'localSaleId', 'local-' || p_sync, 'syncCommandId', p_sync, 'grantId', g.id,
    'deviceId', g.device_id, 'registerId', g.register_id, 'acceptedAt', now(), 'currency', g.currency,
    'lines', jsonb_build_array(jsonb_build_object('variantId', '2a000007-0000-4000-8000-000000000001',
      'quantity', p_qty, 'grantedUnitPriceMinor', 2500,
      'priceId', (select v.value->>'priceId' from jsonb_array_elements(g.catalog_snapshot) p(value),
                   lateral jsonb_array_elements(p.value->'variants') v(value)
                  where v.value->>'variantId' = '2a000007-0000-4000-8000-000000000001'))),
    'totalMinor', 2500 * p_qty, 'cashReceivedMinor', 2500 * p_qty, 'changeMinor', 0,
    'offlineSaleOrdinal', p_ordinal, 'cumulativeExposureMinor', p_cumulative)
  from public.offline_grants g where g.id = p_grant;
$f$;
create function pg_temp.ingest(p_grant uuid, p_sync uuid, p_ordinal int, p_qty int, p_cumulative bigint)
returns text language plpgsql as $f$
declare v_cmd jsonb := pg_temp.sale(p_grant, p_sync, p_ordinal, p_qty, p_cumulative); v_status text;
begin
  select r.sync_status into v_status from offline_pos_private.record_offline_sale(
    '2a000001-0000-4000-8000-000000000001',
    (select c.id from public.device_credentials c join public.offline_grants g on g.device_id = c.device_id where g.id = p_grant limit 1),
    v_cmd, v_cmd::text, encode(sha256(convert_to(p_sync::text, 'utf8')), 'hex'), 'c2lnbmF0dXJl') r;
  return v_status;
end;
$f$;
create function pg_temp.grant_for(p_key text) returns uuid language sql as $f$
  select g.id from offline_pos_private.issue_grant('2a000001-0000-4000-8000-000000000001', (select id from public.devices limit 1),
    '2a000005-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', p_key) g;
$f$;

-- 1. Structure and privileges --------------------------------------------------------------------------
do $b$ begin
  assert to_regclass('public.offline_pos_stock_grants') is not null, 'S1 grant table exists';
  assert (select relrowsecurity from pg_class where oid = 'public.offline_pos_stock_grant_lines'::regclass), 'S2 RLS on lines';
  assert not has_function_privilege('anon', 'inventory_private.issue_offline_stock_grant(uuid,uuid,jsonb,uuid,integer)', 'execute'), 'S3 anon cannot issue';
  assert not has_function_privilege('service_role', 'inventory_private.consume_offline_stock_grant(uuid,uuid,uuid,jsonb,uuid)', 'execute'), 'S4 consume only via ingestion';
  assert has_function_privilege('service_role', 'inventory_private.close_offline_stock_grant(uuid,uuid,integer)', 'execute'), 'S5 server can close';
end $b$;

-- 2. Legacy location: no stock grant, ingestion unchanged ------------------------------------------------
select offline_pos_private.enroll_device('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','till-1','Till 1','c3BraS1rZXk=',repeat('ab',32),'1.0.0','win32','11','sg-enroll-1');
create temp table g(name text primary key, id uuid);
insert into g values ('legacy', pg_temp.grant_for('sg-grant-legacy'));
do $b$ begin
  assert inventory_private.issue_offline_stock_grant('2a000001-0000-4000-8000-000000000001', (select id from g where name='legacy'), null, null, null) is null, 'L1 legacy issues no stock grant';
  assert pg_temp.ingest((select id from g where name='legacy'), '3c000000-0000-4000-8000-000000000001', 1, 1, 2500) = 'synced', 'L2 legacy offline sale synced as before';
  assert (select count(*) = 0 from public.offline_pos_stock_grant_shortfalls), 'L3 no shortfall at legacy';
end $b$;

-- 3. Initialize + split: website 2, pos 6, unallocated 1 (canonical 9) ----------------------------------
select inventory_private.initialize_channel_stock('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000001');
select inventory_private.allocate_channel_stock('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','pilot split','sg-alloc-1',
  (select jsonb_agg(jsonb_build_object('variantId', b.variant_id,
     'websiteQuantity', case when b.variant_id = '2a000007-0000-4000-8000-000000000001' then 2 else 0 end,
     'posQuantity', case when b.variant_id = '2a000007-0000-4000-8000-000000000001' then 6 else 0 end,
     'expectedBalanceVersion', b.version))
   from public.inventory_balances b where b.inventory_location_id = '2a000004-0000-4000-8000-000000000001' and b.on_hand_quantity > 0));

-- 4. Default grant takes all free POS stock; a second grant needs the first closed --------------------
insert into g values ('g1', pg_temp.grant_for('sg-grant-1'));
do $b$ declare r jsonb; s record; begin
  r := inventory_private.issue_offline_stock_grant('2a000001-0000-4000-8000-000000000001', (select id from g where name='g1'), null, null, null);
  assert (r->'lines'->0->>'grantedQuantity')::bigint = 6, 'G1 default grant = all 6 free POS units';
  assert inventory_private.issue_offline_stock_grant('2a000001-0000-4000-8000-000000000001', (select id from g where name='g1'), null, null, null)->>'stockGrantId' = r->>'stockGrantId', 'G2 replay returns the same grant';
  select * into s from pg_temp.key_state();
  assert s.pos = 6 and s.pos_reserved = 6 and s.website = 2 and s.mismatch = 0, 'G3 pos reserved 6, website untouched';
end $b$;
insert into g values ('g2', pg_temp.grant_for('sg-grant-2'));
do $b$ begin
  begin
    perform inventory_private.issue_offline_stock_grant('2a000001-0000-4000-8000-000000000001', (select id from g where name='g2'), null, null, null);
    raise exception 'G4 expected SG409';
  exception when sqlstate 'SG409' then null; end;
end $b$;
-- Close g1 (no offline sales: final ordinal 0) and issue g2 with an explicit 3-unit line.
do $b$ declare r jsonb; s record; begin
  r := inventory_private.issue_offline_stock_grant('2a000001-0000-4000-8000-000000000001', (select id from g where name='g2'),
         '[{"variantId":"2a000007-0000-4000-8000-000000000001","quantity":3}]',
         (select id from g where name='g1'), 0);
  assert (r->'lines'->0->>'grantedQuantity')::bigint = 3, 'G5 explicit grant of 3';
  assert (select status = 'closed' and final_sale_ordinal = 0 from public.offline_pos_stock_grants where offline_grant_id = (select id from g where name='g1')), 'G6 previous grant closed';
  assert (select released_qty = 6 from public.offline_pos_stock_grant_lines l join public.offline_pos_stock_grants sg on sg.id = l.stock_grant_id where sg.offline_grant_id = (select id from g where name='g1')), 'G7 previous grant released its 6';
  select * into s from pg_temp.key_state();
  assert s.pos_reserved = 3, 'G8 pos reserved now 3';
  begin
    perform inventory_private.issue_offline_stock_grant('2a000001-0000-4000-8000-000000000001', pg_temp.grant_for('sg-grant-x'),
      '[{"variantId":"2a000007-0000-4000-8000-000000000001","quantity":4}]', null, null);
    raise exception 'G9 expected SG409 or CH409';
  exception when sqlstate 'SG409' then null; when sqlstate 'CH409' then null; end;
end $b$;

-- 5. Enforced: the grant is protected from connected sales ------------------------------------------------
update inventory_private.channel_feature_gate set enforcement_unlocked = true; -- test-only, disposable DB
select inventory_private.set_channel_stock_mode('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','enforced','2a000012-0000-4000-8000-000000000001','pilot');
do $b$ begin
  -- pos on_hand 6, reserved 3 -> 3 free. A connected sale of 3 fits; of 4 does not.
  begin
    perform pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
      '2a000012-0000-4000-8000-000000000001','sg-conn-over',10000,10000,'[{"variant_id":"2a000007-0000-4000-8000-000000000001","quantity":4}]');
    set constraints all immediate;
    raise exception 'E1 expected CH409';
  exception when sqlstate 'CH409' then null; end;
end $b$;
select pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','sg-conn-ok',7500,7500,'[{"variant_id":"2a000007-0000-4000-8000-000000000001","quantity":3}]');
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 6 and s.pos = 3 and s.pos_reserved = 3 and s.website = 2 and s.mismatch = 0, 'E2 connected sale used free POS only; grant intact';
end $b$;

-- 6. Offline sales consume the grant; beyond it is reconciliation, never oversell -----------------------
do $b$ begin
  assert pg_temp.ingest((select id from g where name='g2'), '3c000000-0000-4000-8000-000000000002', 1, 2, 5000) = 'synced', 'O1 offline sale within grant synced';
end $b$;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 4 and s.pos = 1 and s.pos_reserved = 1 and s.website = 2 and s.mismatch = 0, 'O2 sale took pos on_hand and reservation together';
  assert (select consumed_qty = 2 from public.offline_pos_stock_grant_lines l join public.offline_pos_stock_grants sg on sg.id = l.stock_grant_id where sg.offline_grant_id = (select id from g where name='g2')), 'O3 grant line consumed 2';
  assert pg_temp.ingest((select id from g where name='g2'), '3c000000-0000-4000-8000-000000000002', 1, 2, 5000) = 'synced', 'O4 replay returns the original';
  assert (select count(*) = 1 from public.offline_pos_stock_grant_consumptions), 'O5 replay consumed nothing more';
  begin
    perform inventory_private.close_offline_stock_grant('2a000001-0000-4000-8000-000000000001',
      (select id from public.offline_pos_stock_grants where offline_grant_id = (select id from g where name='g2')), 2);
    raise exception 'O6 expected SG409 (ordinal 2 not yet synced)';
  exception when sqlstate 'SG409' then null; end;
end $b$;
do $b$ begin
  assert pg_temp.ingest((select id from g where name='g2'), '3c000000-0000-4000-8000-000000000003', 2, 2, 10000) = 'needs_reconciliation', 'O7 sale beyond the grant is reconciliation';
end $b$;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.canonical = 4 and s.pos = 1 and s.pos_reserved = 1 and s.website = 2 and s.mismatch = 0, 'O8 nothing moved for the refused sale';
  assert (select count(*) = 1 from public.offline_pos_stock_grant_shortfalls where code = 'stock_grant_exceeded' and (detail->>'remaining')::int = 1), 'O9 shortfall evidence kept';
end $b$;

-- 7. Close releases the remainder ---------------------------------------------------------------------------
do $b$ declare r jsonb; s record; begin
  r := inventory_private.close_offline_stock_grant('2a000001-0000-4000-8000-000000000001',
         (select id from public.offline_pos_stock_grants where offline_grant_id = (select id from g where name='g2')), 2);
  assert r->>'status' = 'closed' and (r->'lines'->0->>'releasedQuantity')::int = 1, 'C1 closed, remaining 1 released';
  assert inventory_private.close_offline_stock_grant('2a000001-0000-4000-8000-000000000001',
         (select id from public.offline_pos_stock_grants where offline_grant_id = (select id from g where name='g2')), 2)->>'status' = 'closed', 'C2 close is idempotent';
  select * into s from pg_temp.key_state();
  assert s.pos_reserved = 0 and s.pos = 1 and s.mismatch = 0, 'C3 reservation fully released';
end $b$;

-- 8. A late sale against an ended grant is reconciliation in enforced mode ---------------------------------
insert into g values ('g3', pg_temp.grant_for('sg-grant-3'));
select inventory_private.issue_offline_stock_grant('2a000001-0000-4000-8000-000000000001', (select id from g where name='g3'), null, null, null);
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.pos_reserved = 1, 'X1 new default grant holds the 1 free POS unit';
end $b$;
-- 9. Expiry never releases without the till's final ordinal (ADR-042 §4.6): an offline sale accepted before
--    expiry may still sync later, so the reservation is retained and surfaced, and the late sale consumes it.
update public.offline_pos_stock_grants set issued_at = now() - interval '2 hours', expires_at = now() - interval '10 minutes'
 where offline_grant_id = (select id from g where name='g3');
do $b$ declare s record; begin
  assert inventory_private.release_expired_offline_stock_grants('2a000001-0000-4000-8000-000000000001') = 0, 'X2 expiry releases nothing without proof';
  assert (select status = 'active' from public.offline_pos_stock_grants where offline_grant_id = (select id from g where name='g3')), 'X3 grant retained (still active)';
  select * into s from pg_temp.key_state();
  assert s.pos_reserved = 1 and s.mismatch = 0, 'X4 expired reservation retained';
  assert (select count(*) = 1 from inventory_private.offline_stock_grants_awaiting_close('2a000001-0000-4000-8000-000000000001') a
           where a.offline_grant_id = (select id from g where name='g3') and a.reserved_units = 1), 'X5 surfaced as awaiting close';
  assert pg_temp.ingest((select id from g where name='g3'), '3c000000-0000-4000-8000-000000000004', 1, 1, 2500) = 'synced', 'X6 sale accepted before expiry, synced after: consumes the retained grant';
end $b$;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.pos_reserved = 0 and s.mismatch = 0, format('X7 consumed, not double-counted: %s', row_to_json(s));
  assert (select consumed_qty = 1 from public.offline_pos_stock_grant_lines l join public.offline_pos_stock_grants sg on sg.id = l.stock_grant_id where sg.offline_grant_id = (select id from g where name='g3')), 'X7b grant line consumed 1';
  assert (select count(*) = 0 from public.offline_pos_stock_grant_shortfalls where code = 'stock_grant_missing'), 'X8 no missing-grant shortfall';
  assert inventory_private.close_offline_stock_grant('2a000001-0000-4000-8000-000000000001',
         (select id from public.offline_pos_stock_grants where offline_grant_id = (select id from g where name='g3')), 1)->>'status' = 'closed', 'X9 till close ends it';
  raise notice 'ALL_OFFLINE_STOCK_GRANT_ASSERTIONS_PASSED';
end $b$;
