-- ADR-043 §5.1 offline operator attribution (migration 20261118130000) on a disposable database, AFTER
-- phase_2h_pos_sale.setup.sql + phase_2i_offline_pos.setup.sql. Real record_offline_sale ingestions, real commits.
\set ON_ERROR_STOP on

create function pg_temp.fp(p jsonb) returns text language sql as $f$ select encode(sha256(convert_to(p::text, 'utf8')), 'hex'); $f$;
create function pg_temp.cred(p_grant uuid) returns uuid language sql as $f$
  select c.id from public.device_credentials c join public.offline_grants g on g.device_id = c.device_id where g.id = p_grant limit 1;
$f$;
create function pg_temp.grant_for(p_key text) returns uuid language sql as $f$
  select (offline_pos_private.issue_grant('2a000001-0000-4000-8000-000000000001', (select id from public.devices limit 1),
    '2a000005-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', p_key)).id;
$f$;
create function pg_temp.sale(p_grant uuid, p_sync uuid, p_accepted timestamptz, p_claim uuid) returns jsonb language sql as $f$
  select jsonb_build_object(
    'schemaVersion', 1, 'localSaleId', 'local-' || p_sync, 'syncCommandId', p_sync, 'grantId', g.id,
    'deviceId', g.device_id, 'registerId', g.register_id, 'acceptedAt', p_accepted, 'currency', g.currency,
    'lines', jsonb_build_array(jsonb_build_object('variantId', '2a000007-0000-4000-8000-000000000001',
      'quantity', 1, 'grantedUnitPriceMinor', 2500,
      'priceId', (select v.value->>'priceId' from jsonb_array_elements(g.catalog_snapshot) p(value),
                   lateral jsonb_array_elements(p.value->'variants') v(value)
                  where v.value->>'variantId' = '2a000007-0000-4000-8000-000000000001'))),
    'totalMinor', 2500, 'cashReceivedMinor', 2500, 'changeMinor', 0,
    'offlineSaleOrdinal', 1, 'cumulativeExposureMinor', 2500)
    || case when p_claim is null then '{}'::jsonb else jsonb_build_object('unlockedByMembershipId', p_claim) end
  from public.offline_grants g where g.id = p_grant;
$f$;
create function pg_temp.ingest(p_sale jsonb) returns uuid language sql as $f$
  select (offline_pos_private.record_offline_sale('2a000001-0000-4000-8000-000000000001',
    pg_temp.cred((p_sale->>'grantId')::uuid), p_sale, p_sale::text, pg_temp.fp(p_sale), 'c2FsZQ==')).order_id;
$f$;
create function pg_temp.attr(p_sync uuid) returns public.offline_sale_operator_attributions language sql as $f$
  select * from public.offline_sale_operator_attributions where sync_command_id = p_sync;
$f$;
create function pg_temp.conflict(p_sync uuid) returns text language sql as $f$
  select string_agg(reason_code, ',') from public.pos_sync_conflicts where sync_command_id = p_sync and dedupe_key like 'operator:%';
$f$;

select offline_pos_private.enroll_device('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','till-oa','Till OA','c3BraS1rZXk=',repeat('ef',32),'1.0.0','win32','11','oa-enroll-1');

-- Member m2 enrolled an offline PIN on THIS device an hour ago (direct row: the fixture role is not an offline seller).
insert into public.staff_offline_pin_enrollments (tenant_id, membership_id, device_id, register_id, verifier_version,
  idempotency_key, enrolled_at)
values ('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000002',
  (select id from public.devices limit 1), '2a000005-0000-4000-8000-000000000001', 1, 'oa-m2-pin', now() - interval '1 hour');

-- O1  older till (no claim): attributed to the grant operator, no conflict.
do $b$ declare s uuid := 'a0000000-0000-4000-8000-000000000001'; o uuid; a public.offline_sale_operator_attributions; begin
  o := pg_temp.ingest(pg_temp.sale(pg_temp.grant_for('oa-g1'), s, now(), null));
  a := pg_temp.attr(s);
  assert o is not null and a.order_id = o, 'O1 sale recorded and attribution linked to the order';
  assert a.attribution = 'grant_operator' and a.claimed_membership_id is null
     and a.attributed_membership_id = '2a000012-0000-4000-8000-000000000001', 'O1 grant operator';
  assert pg_temp.conflict(s) is null, 'O1 no conflict';
end $b$;

-- O2  claim = grant operator (online operator switched to offline selling): verified, no conflict.
do $b$ declare s uuid := 'a0000000-0000-4000-8000-000000000002'; a public.offline_sale_operator_attributions; begin
  perform pg_temp.ingest(pg_temp.sale(pg_temp.grant_for('oa-g2'), s, now(), '2a000012-0000-4000-8000-000000000001'));
  a := pg_temp.attr(s);
  assert a.attribution = 'verified_unlock' and a.attributed_membership_id = '2a000012-0000-4000-8000-000000000001', 'O2 verified';
  assert pg_temp.conflict(s) is null, 'O2 no conflict';
end $b$;

-- O3  a DIFFERENT cashier (m2) unlocked with their own enrolled PIN: attributed to m2, no conflict.
do $b$ declare s uuid := 'a0000000-0000-4000-8000-000000000003'; a public.offline_sale_operator_attributions; begin
  perform pg_temp.ingest(pg_temp.sale(pg_temp.grant_for('oa-g3'), s, now(), '2a000012-0000-4000-8000-000000000002'));
  a := pg_temp.attr(s);
  assert a.attribution = 'verified_unlock' and a.attributed_membership_id = '2a000012-0000-4000-8000-000000000002'
     and a.grant_operator_membership_id = '2a000012-0000-4000-8000-000000000001', 'O3 attributed to the unlocking cashier';
  assert not a.changed_before_sync and pg_temp.conflict(s) is null, 'O3 no conflict';
end $b$;

-- O4  claim for a member with no enrollment on this device: kept as evidence, NOT trusted, conflict raised.
do $b$ declare s uuid := 'a0000000-0000-4000-8000-000000000004'; a public.offline_sale_operator_attributions; c public.pos_sync_conflicts; begin
  perform pg_temp.ingest(pg_temp.sale(pg_temp.grant_for('oa-g4'), s, now(), '2a000012-0000-4000-8000-000000000003'));
  a := pg_temp.attr(s);
  assert a.attribution = 'unverified_claim' and a.claimed_membership_id = '2a000012-0000-4000-8000-000000000003'
     and a.attributed_membership_id = '2a000012-0000-4000-8000-000000000001', 'O4 unverified claim falls back to grant operator';
  select * into c from public.pos_sync_conflicts where sync_command_id = s and dedupe_key like 'operator:%';
  assert c.reason_code = 'OFFLINE_OPERATOR_UNVERIFIED' and c.kind = 'sync_integrity' and c.status = 'open'
     and c.membership_id is null and (c.local_evidence->>'unlockedByMembershipId')::uuid = '2a000012-0000-4000-8000-000000000003'
     and c.order_id is not null, 'O4 conflict reported with the claim as evidence only';
end $b$;

-- O5  an unknown member id (e.g. another tenant's): unverified, never trusted.
do $b$ declare s uuid := 'a0000000-0000-4000-8000-000000000005'; begin
  perform pg_temp.ingest(pg_temp.sale(pg_temp.grant_for('oa-g5'), s, now(), 'ffffffff-ffff-4fff-8fff-ffffffffffff'));
  assert (pg_temp.attr(s)).attribution = 'unverified_claim' and pg_temp.conflict(s) = 'OFFLINE_OPERATOR_UNVERIFIED', 'O5 unknown member';
end $b$;

-- O6  m2 sold offline, then their PIN was reset BEFORE the till synced: attribution kept, conflict reported.
create temp table o6 as select pg_temp.grant_for('oa-g6') as g;
create temp table o6s as select pg_temp.sale((select g from o6), 'a0000000-0000-4000-8000-000000000006', clock_timestamp(),
  '2a000012-0000-4000-8000-000000000002') as cmd;
update public.staff_offline_pin_enrollments set revoked_at = clock_timestamp(), revoked_reason = 'pin_reset'
 where idempotency_key = 'oa-m2-pin';
do $b$ declare s uuid := 'a0000000-0000-4000-8000-000000000006'; a public.offline_sale_operator_attributions; begin
  perform pg_temp.ingest((select cmd from o6s));
  a := pg_temp.attr(s);
  assert a.attribution = 'verified_unlock' and a.attributed_membership_id = '2a000012-0000-4000-8000-000000000002'
     and a.changed_before_sync, 'O6 still attributed to m2 (authorised at acceptance)';
  assert pg_temp.conflict(s) = 'OFFLINE_OPERATOR_CHANGED_BEFORE_SYNC', 'O6 change before sync reported';
  assert (select server_evidence->>'enrollmentRevokedReason' from public.pos_sync_conflicts
           where sync_command_id = s and dedupe_key like 'operator:%') = 'pin_reset', 'O6 evidence names the PIN reset';
end $b$;

-- O7  after that revocation a NEW sale claiming m2 is not authorised any more: unverified.
do $b$ declare s uuid := 'a0000000-0000-4000-8000-000000000007'; begin
  perform pg_temp.ingest(pg_temp.sale(pg_temp.grant_for('oa-g7'), s, now(), '2a000012-0000-4000-8000-000000000002'));
  assert (pg_temp.attr(s)).attribution = 'unverified_claim' and pg_temp.conflict(s) = 'OFFLINE_OPERATOR_UNVERIFIED',
    'O7 revoked enrollment no longer verifies';
end $b$;

-- O8  m3 enrolled, sold offline, then was SUSPENDED before sync.
insert into public.staff_offline_pin_enrollments (tenant_id, membership_id, device_id, register_id, verifier_version,
  idempotency_key, enrolled_at)
values ('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000003',
  (select id from public.devices limit 1), '2a000005-0000-4000-8000-000000000001', 1, 'oa-m3-pin', now() - interval '1 hour');
create temp table o8s as select pg_temp.sale(pg_temp.grant_for('oa-g8'), 'a0000000-0000-4000-8000-000000000008', clock_timestamp(),
  '2a000012-0000-4000-8000-000000000003') as cmd;
update public.memberships set status = 'suspended', suspended_at = now() where id = '2a000012-0000-4000-8000-000000000003';
do $b$ declare s uuid := 'a0000000-0000-4000-8000-000000000008'; begin
  perform pg_temp.ingest((select cmd from o8s));
  assert (pg_temp.attr(s)).attribution = 'verified_unlock' and (pg_temp.attr(s)).changed_before_sync, 'O8 verified at acceptance';
  assert pg_temp.conflict(s) = 'OFFLINE_OPERATOR_CHANGED_BEFORE_SYNC', 'O8 suspension before sync reported';
  assert (select server_evidence->>'memberStatusAtSync' from public.pos_sync_conflicts
           where sync_command_id = s and dedupe_key like 'operator:%') = 'suspended', 'O8 evidence names the status';
end $b$;

-- O9  idempotent replay: no duplicate attribution or conflict; every sale was recorded (none lost).
do $b$ begin
  perform pg_temp.ingest((select cmd from o8s));
  assert (select count(*) = 1 from public.offline_sale_operator_attributions where sync_command_id = 'a0000000-0000-4000-8000-000000000008'),
    'O9 replay adds no attribution';
  assert (select count(*) = 1 from public.pos_sync_conflicts where sync_command_id = 'a0000000-0000-4000-8000-000000000008'
           and dedupe_key like 'operator:%'), 'O9 replay adds no conflict';
  assert (select count(*) = 8 from public.offline_sale_ingestions where sync_command_id::text like 'a0000000-0000-4000-8000-%'),
    'O9 all eight sales recorded';
  assert (select count(*) = 8 from public.offline_sale_operator_attributions), 'O9 exactly one attribution per sale';
end $b$;

-- O10 immutable and not exposed to client roles.
do $b$ begin
  begin
    update public.offline_sale_operator_attributions set attributed_membership_id = '2a000012-0000-4000-8000-000000000001';
    raise exception 'O10 expected attributions to be immutable';
  exception when others then
    if sqlerrm like 'O10%' then raise; end if;
  end;
  assert not has_table_privilege('authenticated', 'public.offline_sale_operator_attributions', 'select'), 'O10 not readable by clients';
end $b$;

select 'ALL_OFFLINE_OPERATOR_ATTRIBUTION_ASSERTIONS_PASSED' as result;
