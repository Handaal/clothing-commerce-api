-- ADR-042 §8 typed offline customer.create and §9 retired intent kinds.
-- Runs AFTER phase_2h_pos_sale.setup.sql + phase_2i_offline_pos.setup.sql (customer Layla +201000000000 exists).
\set ON_ERROR_STOP on

select offline_pos_private.enroll_device('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','till-1','Till 1','c3BraS1rZXk=',repeat('aa',32),'1.0.0','win32','11','cu-enroll-1');
create temp table g as select g2.id from offline_pos_private.issue_grant('2a000001-0000-4000-8000-000000000001',
  (select id from public.devices limit 1), '2a000005-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', 'cu-boot-1') g2;

create function pg_temp.customer_cmd(p_sync uuid, p_local uuid, p_name text, p_phone text) returns jsonb language sql as $f$
  select jsonb_build_object('schemaVersion', 1, 'syncCommandId', p_sync, 'localCustomerId', p_local, 'grantId', og.id,
    'deviceId', og.device_id, 'registerId', og.register_id, 'acceptedAt', now(), 'name', p_name, 'phone', p_phone)
  from public.offline_grants og where og.id = (select id from g);
$f$;
create function pg_temp.ingest_customer(p_cmd jsonb) returns record language sql as $f$
  select r.customer_id, r.duplicate_of_customer_id from offline_pos_private.record_offline_customer('2a000001-0000-4000-8000-000000000001',
    (select c.id from public.device_credentials c limit 1), p_cmd, p_cmd::text,
    encode(sha256(convert_to(p_cmd::text, 'utf8')), 'hex'), 'c2lnbmF0dXJl') r;
$f$;

do $b$ declare r record; c jsonb; begin
  -- New phone: created with the till's id, no duplicate.
  c := pg_temp.customer_cmd('3f000000-0000-4000-8000-000000000001', '3f0000cc-0000-4000-8000-000000000001', 'Omar Adel', '+20 100 555 0101');
  select * into r from pg_temp.ingest_customer(c) as x(customer_id uuid, duplicate_of uuid);
  assert r.customer_id = '3f0000cc-0000-4000-8000-000000000001' and r.duplicate_of is null, 'CU1 new customer created with the till id';
  -- Exact replay returns the original.
  select * into r from pg_temp.ingest_customer(c) as x(customer_id uuid, duplicate_of uuid);
  assert r.customer_id = '3f0000cc-0000-4000-8000-000000000001', 'CU2 replay is idempotent';
  assert (select count(*) = 1 from public.customers where id = '3f0000cc-0000-4000-8000-000000000001'), 'CU3 replay created nothing more';
  -- Existing phone: flagged, never merged.
  c := pg_temp.customer_cmd('3f000000-0000-4000-8000-000000000002', '3f0000cc-0000-4000-8000-000000000002', 'Layla H', '+201000000000');
  select * into r from pg_temp.ingest_customer(c) as x(customer_id uuid, duplicate_of uuid);
  assert r.duplicate_of = '2a000030-0000-4000-8000-000000000001' and r.customer_id = '3f0000cc-0000-4000-8000-000000000002', 'CU4 duplicate flagged';
  assert (select name = 'Layla Hassan' from public.customers where id = '2a000030-0000-4000-8000-000000000001'), 'CU5 existing customer untouched (no merge)';
  -- Invalid phone is a deterministic refusal.
  begin
    perform pg_temp.ingest_customer(pg_temp.customer_cmd('3f000000-0000-4000-8000-000000000003', '3f0000cc-0000-4000-8000-000000000003', 'Bad', '0100'));
    raise exception 'CU6 expected OS422';
  exception when sqlstate 'OS422' then null; end;
end $b$;

-- §9: registers cannot opt into generic intents; a received one is rejected out of scope with no effect.
do $b$ declare r record; v_cmd jsonb; v_before bigint; begin
  begin
    update public.offline_pos_policies set offline_intent_operations = '{inventory.receive}' where register_id = '2a000005-0000-4000-8000-000000000001';
    raise exception 'IS1 expected 23514';
  exception when sqlstate '23514' then null; end;
  select on_hand_quantity into v_before from public.inventory_balances where variant_id = '2a000007-0000-4000-8000-000000000001' and inventory_location_id = '2a000004-0000-4000-8000-000000000001';
  select jsonb_build_object('schemaVersion', 1, 'localIntentId', 'li-1', 'syncCommandId', '3f000000-0000-4000-8000-000000000010',
    'grantId', og.id, 'deviceId', og.device_id, 'registerId', og.register_id, 'operatorMembershipId', og.operator_membership_id,
    'acceptedAt', now(), 'operation', 'inventory.receive', 'subjectId', '2a000007-0000-4000-8000-000000000001',
    'payload', jsonb_build_object('variantId', '2a000007-0000-4000-8000-000000000001', 'quantity', 5)) into v_cmd
    from public.offline_grants og where og.id = (select id from g);
  select * into r from offline_pos_private.record_offline_intent('2a000001-0000-4000-8000-000000000001', (select c.id from public.device_credentials c limit 1),
    v_cmd, v_cmd::text, encode(sha256(convert_to(v_cmd::text, 'utf8')), 'hex'), 'c2lnbmF0dXJl');
  assert r.disposition = 'rejected' and r.disposition_code = 'OIX_KIND_OUT_OF_SCOPE', 'IS2 out-of-scope intent rejected';
  assert (select on_hand_quantity = v_before from public.inventory_balances where variant_id = '2a000007-0000-4000-8000-000000000001' and inventory_location_id = '2a000004-0000-4000-8000-000000000001'), 'IS3 no stock effect';
  assert offline_pos_private.get_intent_operations('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001') = '{}', 'IS4 nothing offered to the till';
  raise notice 'ALL_OFFLINE_CUSTOMER_SCOPE_ASSERTIONS_PASSED';
end $b$;
