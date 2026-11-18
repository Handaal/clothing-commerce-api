-- ADR-042 §4.6 (Finding A) offline sale reconciliation holds. Runs on a disposable database AFTER
-- phase_2h_pos_sale.setup.sql + phase_2i_offline_pos.setup.sql (same fixture as phase_3c: variant ...7-...0001 at
-- 2500, 10 units; max 3 per line, 3 pending sales). Separate top-level statements so deferred triggers fire.
\set ON_ERROR_STOP on

create function pg_temp.key_state()
returns table(canonical bigint, website bigint, pos bigint, mismatch bigint, pos_reserved bigint)
language sql as $f$
  select r.canonical_on_hand, r.website_on_hand, r.pos_on_hand, r.mismatch,
         (select b.reserved_qty from public.inventory_channel_balances b
           where b.inventory_location_id = '2a000004-0000-4000-8000-000000000001'
             and b.variant_id = '2a000007-0000-4000-8000-000000000001' and b.channel = 'pos')
    from inventory_private.channel_reconciliation('2a000001-0000-4000-8000-000000000001',
                                                  '2a000004-0000-4000-8000-000000000001') r
   where r.variant_id = '2a000007-0000-4000-8000-000000000001';
$f$;
create function pg_temp.sale(p_grant uuid, p_sync uuid, p_ordinal int, p_qty int, p_customer uuid) returns jsonb
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
create function pg_temp.fp(p jsonb) returns text language sql as $f$ select encode(sha256(convert_to(p::text, 'utf8')), 'hex'); $f$;
create function pg_temp.cred(p_grant uuid) returns uuid language sql as $f$
  select c.id from public.device_credentials c join public.offline_grants g on g.device_id = c.device_id where g.id = p_grant limit 1;
$f$;
create function pg_temp.hold_cmd(p_sale jsonb, p_hold_sync uuid, p_reason text default 'customer_dependency_rejected') returns jsonb
language sql as $f$
  select jsonb_build_object('schemaVersion', 1, 'syncCommandId', p_hold_sync, 'saleSyncCommandId', p_sale->>'syncCommandId',
    'saleCommandFingerprint', pg_temp.fp(p_sale), 'grantId', p_sale->>'grantId', 'deviceId', p_sale->>'deviceId',
    'registerId', p_sale->>'registerId', 'localSaleId', p_sale->>'localSaleId',
    'offlineSaleOrdinal', (p_sale->>'offlineSaleOrdinal')::int, 'customerId', p_sale->>'customerId',
    'reason', p_reason, 'requestedAt', now());
$f$;
create function pg_temp.hold(p_sale jsonb, p_hold jsonb)
returns table(hold_id uuid, status text, held_lines jsonb, received_at timestamptz) language plpgsql as $f$
begin
  return query select * from offline_pos_private.record_offline_sale_hold('2a000001-0000-4000-8000-000000000001',
    pg_temp.cred((p_sale->>'grantId')::uuid), p_hold, p_hold::text, pg_temp.fp(p_hold), 'aG9sZA==',
    pg_temp.cred((p_sale->>'grantId')::uuid), p_sale, p_sale::text, pg_temp.fp(p_sale), 'c2FsZQ==');
end;
$f$;
create function pg_temp.ingest(p_sale jsonb) returns text language plpgsql as $f$
declare v_status text;
begin
  select r.sync_status into v_status from offline_pos_private.record_offline_sale('2a000001-0000-4000-8000-000000000001',
    pg_temp.cred((p_sale->>'grantId')::uuid), p_sale, p_sale::text, pg_temp.fp(p_sale), 'c2FsZQ==') r;
  return v_status;
end;
$f$;
create function pg_temp.grant_for(p_key text) returns uuid language sql as $f$
  select g.id from offline_pos_private.issue_grant('2a000001-0000-4000-8000-000000000001', (select id from public.devices limit 1),
    '2a000005-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', p_key) g;
$f$;

-- 0. Structure & privileges ----------------------------------------------------------------------------------
do $b$ begin
  assert (select relrowsecurity from pg_class where oid = 'public.offline_sale_reconciliation_holds'::regclass), 'P1 RLS on holds';
  assert not has_table_privilege('anon', 'public.offline_sale_reconciliation_holds', 'select'), 'P2 anon cannot read holds';
  assert not has_function_privilege('anon', 'offline_pos_private.record_offline_sale_hold(uuid,uuid,jsonb,text,text,text,uuid,jsonb,text,text,text)', 'execute'), 'P3 anon cannot hold';
  assert has_function_privilege('service_role', 'offline_pos_private.record_offline_sale_hold(uuid,uuid,jsonb,text,text,text,uuid,jsonb,text,text,text)', 'execute'), 'P4 server can hold';
  assert not has_function_privilege('service_role', 'inventory_private.hold_offline_stock_grant(uuid,uuid,uuid,jsonb,uuid)', 'execute'), 'P5 stock hold only via the hold RPC';
  assert (select pg_get_userbyid(relowner) = 'offline_pos_writer' from pg_class where oid = 'public.offline_sale_reconciliation_holds'::regclass), 'P6 owned by offline_pos_writer';
  assert not has_schema_privilege('offline_pos_writer', 'public', 'create'), 'P7 no lasting CREATE on public';
end $b$;

-- Setup: enforced location, website 2 / pos 6, grant g1 holds all 6 POS units.
select offline_pos_private.enroll_device('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','till-1','Till 1','c3BraS1rZXk=',repeat('ab',32),'1.0.0','win32','11','sh-enroll-1');
select inventory_private.initialize_channel_stock('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000001');
select inventory_private.allocate_channel_stock('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','pilot split','sh-alloc-1',
  (select jsonb_agg(jsonb_build_object('variantId', b.variant_id,
     'websiteQuantity', case when b.variant_id = '2a000007-0000-4000-8000-000000000001' then 2 else 0 end,
     'posQuantity', case when b.variant_id = '2a000007-0000-4000-8000-000000000001' then 6 else 0 end,
     'expectedBalanceVersion', b.version))
   from public.inventory_balances b where b.inventory_location_id = '2a000004-0000-4000-8000-000000000001' and b.on_hand_quantity > 0));
update inventory_private.channel_feature_gate set enforcement_unlocked = true; -- TEST-ONLY, disposable DB
select inventory_private.set_channel_stock_mode('2a000001-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','enforced','2a000012-0000-4000-8000-000000000001','pilot');
create temp table g(name text primary key, id uuid);
create temp table cmd(name text primary key, body jsonb);
insert into g values ('g1', pg_temp.grant_for('sh-grant-1'));
select inventory_private.issue_offline_stock_grant('2a000001-0000-4000-8000-000000000001', (select id from g where name='g1'), null, null, null);
-- The held sale: ordinal 1, 2 units, installment for a customer the server never accepted.
insert into cmd values ('s1', pg_temp.sale((select id from g where name='g1'), '3a000000-0000-4000-8000-000000000001', 1, 2, '3a0000cc-0000-4000-8000-000000000001'));
insert into cmd values ('h1', pg_temp.hold_cmd((select body from cmd where name='s1'), '3a0000ff-0000-4000-8000-000000000001'));

-- 1. Before the hold the grant cannot close (the reported wedge) ----------------------------------------------
do $b$ begin
  begin
    perform inventory_private.close_offline_stock_grant('2a000001-0000-4000-8000-000000000001',
      (select id from public.offline_pos_stock_grants where offline_grant_id = (select id from g where name='g1')), 1);
    raise exception 'W1 expected SG409 (ordinal 1 never ingested)';
  exception when sqlstate 'SG409' then null; end;
end $b$;

-- 2. Hold: terminal, replayable, stock retained -------------------------------------------------------------
do $b$ declare r record; r2 record; s record; begin
  select * into r from pg_temp.hold((select body from cmd where name='s1'), (select body from cmd where name='h1'));
  assert r.status = 'held_for_reconciliation', 'H1 terminal status held_for_reconciliation';
  assert (r.held_lines->0->>'quantity')::int = 2, 'H2 two units held';
  select * into r2 from pg_temp.hold((select body from cmd where name='s1'), (select body from cmd where name='h1'));
  assert r2.hold_id = r.hold_id and r2.received_at = r.received_at, 'H3 exact replay returns the original receipt';
  select * into s from pg_temp.key_state();
  assert s.pos = 6 and s.pos_reserved = 6 and s.mismatch = 0, 'H4 held units stay reserved, nothing consumed or released';
  assert (select held_qty = 2 and consumed_qty = 0 and released_qty = 0 from public.offline_pos_stock_grant_lines l
           join public.offline_pos_stock_grants sg on sg.id = l.stock_grant_id where sg.offline_grant_id = (select id from g where name='g1')), 'H5 grant line held 2';
  assert (select count(*) = 1 from public.offline_pos_stock_grant_holds), 'H6 replay held nothing more';
  assert (select count(*) = 0 from public.orders o where o.id in (select order_id from public.offline_sale_ingestions)), 'H7 no order, payment or debt created';
  assert not exists (select 1 from public.customers where id = '3a0000cc-0000-4000-8000-000000000001'), 'H8 no customer created or linked';
  assert (select sale_canonical_command = (select body::text from cmd where name='s1') from public.offline_sale_reconciliation_holds), 'H9 signed sale evidence preserved';
end $b$;

-- 3. Adversarial: conflicting replay, reuse of ordinal / sale, wrong binding -------------------------------
do $b$ declare v_other jsonb; begin
  -- same sale, different hold content (another hold id) -> idempotency conflict
  begin
    perform * from pg_temp.hold((select body from cmd where name='s1'), pg_temp.hold_cmd((select body from cmd where name='s1'), '3a0000ff-0000-4000-8000-0000000000aa') || '{"requestedAt":"2026-01-01T00:00:00Z"}');
    raise exception 'A1 expected ID409';
  exception when sqlstate 'ID409' then null; end;
  -- the held sale itself can no longer be ingested
  begin
    perform pg_temp.ingest(pg_temp.sale((select id from g where name='g1'), '3a000000-0000-4000-8000-000000000001', 1, 2, null));
    raise exception 'A2 expected OH409';
  exception when sqlstate 'OH409' then null; end;
  -- a different sale reusing the held ordinal is refused (and moves no stock)
  begin
    perform pg_temp.ingest(pg_temp.sale((select id from g where name='g1'), '3a000000-0000-4000-8000-000000000009', 1, 1, null));
    raise exception 'A3 expected OH409';
  exception when sqlstate 'OH409' then null; end;
  -- binding mismatch (hold names another ordinal)
  v_other := pg_temp.sale((select id from g where name='g1'), '3a000000-0000-4000-8000-000000000003', 3, 1, '3a0000cc-0000-4000-8000-000000000003');
  begin
    perform * from pg_temp.hold(v_other, pg_temp.hold_cmd(v_other, '3a0000ff-0000-4000-8000-000000000003') || '{"offlineSaleOrdinal":2}');
    raise exception 'A4 expected OH422';
  exception when sqlstate 'OH422' then null; end;
  -- unsupported reason
  begin
    perform * from pg_temp.hold(v_other, pg_temp.hold_cmd(v_other, '3a0000ff-0000-4000-8000-000000000003', 'cashier_changed_mind'));
    raise exception 'A5 expected OH422';
  exception when sqlstate 'OH422' then null; end;
  -- a sale whose customer exists must be synchronized normally, not held
  v_other := pg_temp.sale((select id from g where name='g1'), '3a000000-0000-4000-8000-000000000004', 3, 1,
               (select id from public.customers order by created_at limit 1));
  begin
    perform * from pg_temp.hold(v_other, pg_temp.hold_cmd(v_other, '3a0000ff-0000-4000-8000-000000000004'));
    raise exception 'A6 expected OH422';
  exception when sqlstate 'OH422' then null; end;
end $b$;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.pos = 6 and s.pos_reserved = 6 and s.mismatch = 0, 'A7 refused attempts moved nothing';
end $b$;

-- 4. Ordinal 2 syncs normally; a hold for an ingested ordinal and a duplicate ordinal are refused ------------
insert into cmd values ('s2', pg_temp.sale((select id from g where name='g1'), '3a000000-0000-4000-8000-000000000002', 2, 1, null));
do $b$ begin
  assert pg_temp.ingest((select body from cmd where name='s2')) = 'synced', 'O1 ordinal 2 synced';
end $b$;
do $b$ declare v_dup jsonb; begin
  v_dup := (select body from cmd where name='s2') || '{"customerId":"3a0000cc-0000-4000-8000-000000000002","amountPaidMinor":1000,"outstandingMinor":1500}';
  begin
    perform * from pg_temp.hold(v_dup, pg_temp.hold_cmd(v_dup, '3a0000ff-0000-4000-8000-000000000002'));
    raise exception 'O2 expected OH409';
  exception when sqlstate 'OH409' then null; end;
  begin
    perform pg_temp.ingest(pg_temp.sale((select id from g where name='g1'), '3a000000-0000-4000-8000-000000000008', 2, 1, null));
    raise exception 'O3 expected OH409 (ordinal reuse with different content)';
  exception when sqlstate 'OH409' then null; end;
end $b$;
do $b$ declare s record; begin
  select * into s from pg_temp.key_state();
  assert s.pos = 5 and s.pos_reserved = 5 and s.mismatch = 0, 'O4 one unit consumed by ordinal 2 only';
end $b$;

-- 5. Re-bootstrap: the previous grant closes at final ordinal 2; held units stay reserved -----------------
insert into g values ('g2', pg_temp.grant_for('sh-grant-2'));
do $b$ declare r jsonb; s record; begin
  r := inventory_private.issue_offline_stock_grant('2a000001-0000-4000-8000-000000000001', (select id from g where name='g2'),
         '[{"variantId":"2a000007-0000-4000-8000-000000000001","quantity":1}]', (select id from g where name='g1'), 2);
  assert (r->'lines'->0->>'grantedQuantity')::int = 1, 'R1 new grant issued (register no longer wedged)';
  assert (select status = 'closed' and final_sale_ordinal = 2 from public.offline_pos_stock_grants where offline_grant_id = (select id from g where name='g1')), 'R2 previous grant closed';
  assert (select released_qty = 3 and held_qty = 2 and consumed_qty = 1 from public.offline_pos_stock_grant_lines l
           join public.offline_pos_stock_grants sg on sg.id = l.stock_grant_id where sg.offline_grant_id = (select id from g where name='g1')), 'R3 released 3, held 2, consumed 1';
  select * into s from pg_temp.key_state();
  assert s.pos = 5 and s.pos_reserved = 3 and s.mismatch = 0 and s.website = 2, 'R4 reserved = 2 held + 1 new grant; website untouched';
  -- close replay is idempotent and releases nothing twice
  assert inventory_private.close_offline_stock_grant('2a000001-0000-4000-8000-000000000001',
    (select id from public.offline_pos_stock_grants where offline_grant_id = (select id from g where name='g1')), 2)->>'status' = 'closed', 'R5 close replay';
  select * into s from pg_temp.key_state();
  assert s.pos_reserved = 3, 'R6 no double release';
  assert (select count(*) = 1 from inventory_private.offline_stock_grants_awaiting_close('2a000001-0000-4000-8000-000000000001') a where a.held_units = 2), 'R7 held units surfaced';
  -- hold replay after close still returns the original receipt
  assert (select h.status from pg_temp.hold((select body from cmd where name='s1'), (select body from cmd where name='h1')) h) = 'held_for_reconciliation', 'R8 replay after close';
  assert (select count(*) = 1 from public.offline_sale_reconciliation_holds), 'R9 exactly one terminal record';
  begin
    update public.offline_sale_reconciliation_holds set reason = 'customer_dependency_rejected';
    raise exception 'R10 expected immutable';
  exception when others then
    if sqlerrm like 'R10%' then raise; end if;
  end;
  raise notice 'ALL_OFFLINE_SALE_HOLD_ASSERTIONS_PASSED';
end $b$;
