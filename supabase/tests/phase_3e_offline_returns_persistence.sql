-- ADR-042 §7 + D-7: offline return refund budget (required), admin credential flag, assertion binding.
-- Runs AFTER phase_2h_pos_sale.setup.sql + phase_2i_offline_pos.setup.sql + phase_2m_returns.setup.sql.
\set ON_ERROR_STOP on

create temp table g(name text primary key, id uuid);
select offline_pos_private.enroll_device('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','till-1','Till 1','c3BraS1rZXk=',repeat('ef',32),'1.0.0','win32','11','rt-enroll-1');
-- A connected POS sale of 2 units (2 x 2500) to return against.
select pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','rt-sale-1',5000,5000,'[{"variant_id":"2a000007-0000-4000-8000-000000000001","quantity":2}]');
insert into g values ('order', (select id from public.orders where channel = 'pos' order by created_at desc limit 1));
insert into g values ('boot', (select g2.id from offline_pos_private.issue_grant('2a000001-0000-4000-8000-000000000001',
  (select id from public.devices limit 1), '2a000005-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', 'rt-boot-1') g2));

create function pg_temp.return_grant(p_key text) returns public.offline_return_grants language sql as $f$
  select * from offline_pos_private.issue_return_grant('2a000001-0000-4000-8000-000000000001', (select id from public.devices limit 1),
    '2a000005-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', (select id from g where name = 'order'), p_key);
$f$;
create function pg_temp.return_ingest(p_grant uuid, p_sync uuid, p_assertion jsonb) returns record language plpgsql as $f$
declare v_grant public.offline_return_grants%rowtype; v_cmd jsonb; r record;
begin
  select * into v_grant from public.offline_return_grants where id = p_grant;
  v_cmd := jsonb_build_object('schemaVersion', 1, 'localReturnId', 'ret-' || p_sync, 'syncCommandId', p_sync,
    'returnGrantId', v_grant.id, 'deviceId', v_grant.device_id, 'registerId', v_grant.register_id, 'orderId', v_grant.order_id,
    'acceptedAt', now(), 'currency', v_grant.currency,
    'lines', jsonb_build_array(jsonb_build_object('orderLineId', v_grant.eligibility_snapshot->'lines'->0->>'orderLineId',
      'quantity', 1, 'reason', 'changed_mind', 'disposition', 'restock')));
  if p_assertion is not null then v_cmd := v_cmd || jsonb_build_object('adminAssertion', p_assertion); end if;
  perform offline_pos_private.record_offline_return('2a000001-0000-4000-8000-000000000001',
      (select c.id from public.device_credentials c where c.device_id = v_grant.device_id limit 1),
      v_cmd, v_cmd::text, encode(sha256(convert_to(p_sync::text, 'utf8')), 'hex'), 'c2lnbmF0dXJl');
  select i.sync_status, i.refund_amount_minor, c.reason into r
    from public.offline_return_ingestions i left join public.offline_return_reconciliations c on c.ingestion_id = i.id
   where i.sync_command_id = p_sync;
  return r;
end;
$f$;

-- 1. Budget configured: grant refunds at most min(ceiling, budget); no credential flag by default -----------
do $b$ declare v public.offline_return_grants; begin
  v := pg_temp.return_grant('rt-grant-1');
  assert v.max_refundable_minor = 5000 and not v.requires_pos_admin_credentials, 'B1 budget above ceiling => ceiling (5000)';
end $b$;

-- 2. No budget => no offline return grant (fail closed, D-7) -------------------------------------------------
update public.return_settings set offline_refund_budget_minor = null;
do $b$ begin
  begin
    perform pg_temp.return_grant('rt-grant-2');
    raise exception 'B2 expected RT423';
  exception when sqlstate 'RT423' then null; end;
end $b$;

-- 3. Budget below one unit's refund + credential required --------------------------------------------------------
update public.return_settings set offline_refund_budget_minor = 3000, offline_requires_admin_credentials = true;
insert into g values ('rg3', (pg_temp.return_grant('rt-grant-3')).id);
do $b$ declare r record; begin
  assert (select max_refundable_minor = 3000 and requires_pos_admin_credentials from public.offline_return_grants where id = (select id from g where name = 'rg3')), 'B3 grant capped at 3000 and flagged';
  r := pg_temp.return_ingest((select id from g where name = 'rg3'), '3e000000-0000-4000-8000-000000000001', null);
  assert r.sync_status = 'needs_reconciliation' and r.reason = 'admin_credential_invalid_at_ingestion', 'B4 missing credential is held: ' || r::text;
end $b$;
insert into public.offline_pos_admin_verifier_issuances (tenant_id, offline_grant_id, membership_id, permission, verifier_version, expires_at)
values ('2a000001-0000-4000-8000-000000000001', (select id from g where name = 'boot'), '2a000012-0000-4000-8000-000000000002', 'payments.refund', 1, now() + interval '1 hour');
do $b$ declare r record; begin
  r := pg_temp.return_ingest((select id from g where name = 'rg3'), '3e000000-0000-4000-8000-000000000002', jsonb_build_object(
    'assertionId', '3e0000aa-0000-4000-8000-000000000001', 'adminMembershipId', '2a000012-0000-4000-8000-000000000002',
    'permission', 'payments.refund', 'verifierVersion', 1, 'commandId', '3e000000-0000-4000-8000-000000000002',
    'offlineGrantId', (select id from g where name = 'boot')));
  assert r.sync_status = 'synced' and r.refund_amount_minor = 2500, 'B5 credentialed return within budget synced (refund 2500 pending)';
  r := pg_temp.return_ingest((select id from g where name = 'rg3'), '3e000000-0000-4000-8000-000000000003', jsonb_build_object(
    'assertionId', '3e0000aa-0000-4000-8000-000000000002', 'adminMembershipId', '2a000012-0000-4000-8000-000000000002',
    'permission', 'payments.refund', 'verifierVersion', 1, 'commandId', '3e000000-0000-4000-8000-000000000003',
    'offlineGrantId', (select id from g where name = 'boot')));
  assert r.sync_status = 'needs_reconciliation' and r.reason = 'refund_budget_exceeded_at_ingestion', 'B6 second unit (2500 + 2500 > 3000) is held';
  assert (select count(*) = 1 from public.refunds), 'B7 the held return created no refund';
  r := pg_temp.return_ingest((select id from g where name = 'rg3'), '3e000000-0000-4000-8000-000000000004', jsonb_build_object(
    'assertionId', '3e0000aa-0000-4000-8000-000000000003', 'adminMembershipId', '2a000012-0000-4000-8000-000000000002',
    'permission', 'promotions.manage', 'verifierVersion', 1, 'commandId', '3e000000-0000-4000-8000-000000000004',
    'offlineGrantId', (select id from g where name = 'boot')));
  assert r.reason = 'admin_credential_invalid_at_ingestion', 'B8 an assertion for the wrong permission is held';
end $b$;

-- 4. Settings round-trip ---------------------------------------------------------------------------------------------
do $b$ declare r jsonb; begin
  r := settings_private.write_return_settings('2a000001-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000001','rt-set-1',
         '{"offlineRefundBudgetMinor":7000,"offlineRequiresAdminCredentials":false}');
  assert (r->>'offlineRefundBudgetMinor')::bigint = 7000 and not (r->>'offlineRequiresAdminCredentials')::boolean, 'S1 settings write the new fields';
  raise notice 'ALL_OFFLINE_RETURN_ASSERTIONS_PASSED';
end $b$;
