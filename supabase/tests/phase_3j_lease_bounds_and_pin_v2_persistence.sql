-- Offline lease/catalog bounds (operator <= 24 h, catalog <= operator) + offline PIN v2 retirement.
-- Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql + phase_2i_offline_pos.setup.sql.
\set ON_ERROR_STOP on

create function pg_temp.fp(p jsonb) returns text language sql as $f$ select encode(sha256(convert_to(p::text, 'utf8')), 'hex'); $f$;
create function pg_temp.cred(p_grant uuid) returns uuid language sql as $f$
  select c.id from public.device_credentials c join public.offline_grants g on g.device_id = c.device_id where g.id = p_grant limit 1;
$f$;
create function pg_temp.grant_for(p_key text) returns public.offline_grants language sql as $f$
  select g from offline_pos_private.issue_grant('2a000001-0000-4000-8000-000000000001', (select id from public.devices limit 1),
    '2a000005-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', p_key) g;
$f$;
create function pg_temp.sale(p_grant uuid, p_sync uuid, p_accepted timestamptz) returns jsonb language sql as $f$
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
  from public.offline_grants g where g.id = p_grant;
$f$;
create function pg_temp.ingest_code(p_sale jsonb) returns text language plpgsql as $f$
begin
  perform offline_pos_private.record_offline_sale('2a000001-0000-4000-8000-000000000001',
    pg_temp.cred((p_sale->>'grantId')::uuid), p_sale, p_sale::text, pg_temp.fp(p_sale), 'c2FsZQ==');
  return 'ok';
exception when others then return sqlstate;
end $f$;

select offline_pos_private.enroll_device('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','till-lb','Till LB','c3BraS1rZXk=',repeat('ab',32),'1.0.0','win32','11','lb-enroll-1');

-- L1  Reproduce the shared-dev state (lease 12 h, catalog 24 h) as a PRE-EXISTING row (the NOT VALID constraint
--     only guards new writes, so the row is planted with the constraint temporarily absent, then restored NOT VALID).
alter table public.offline_pos_policies drop constraint offline_pos_policies_lease_bounds;
update public.offline_pos_policies set operator_lease_seconds = 43200, catalog_grant_seconds = 86400
 where register_id = '2a000005-0000-4000-8000-000000000001';
alter table public.offline_pos_policies add constraint offline_pos_policies_lease_bounds
  check (operator_lease_seconds <= 86400 and catalog_grant_seconds <= operator_lease_seconds) not valid;

do $b$ declare v public.offline_grants; begin
  assert (select violation = 'catalog_window_above_operator_lease' from offline_pos_private.lease_policy_violations
           where register_id = '2a000005-0000-4000-8000-000000000001'), 'L1 12h/24h row is reported as invalid';
  v := pg_temp.grant_for('lb-grant-1');
  assert v.catalog_valid_until <= v.operator_expires_at, 'L2 an invalid row cannot authorise stale catalog: catalog clamped to lease';
  assert v.accepted_until = least(v.operator_expires_at, v.catalog_valid_until), 'L3 accepted_until never exceeds the lease';
  assert v.operator_expires_at - v.issued_at = interval '12 hours', 'L4 lease unchanged (12 h)';
end $b$;

-- L5..L9  settings validation for new writes.
do $b$ begin
  update public.offline_pos_policies set catalog_grant_seconds = 43200 where register_id = '2a000005-0000-4000-8000-000000000001';
  assert not exists (select 1 from offline_pos_private.lease_policy_violations), 'L5 corrected catalog = 12 h accepted, no violation';
  begin
    update public.offline_pos_policies set catalog_grant_seconds = 43201 where register_id = '2a000005-0000-4000-8000-000000000001';
    raise exception 'L6 expected catalog > lease to be rejected';
  exception when check_violation then null; end;
  begin
    update public.offline_pos_policies set operator_lease_seconds = 86401 where register_id = '2a000005-0000-4000-8000-000000000001';
    raise exception 'L7 expected lease > 24 h to be rejected';
  exception when check_violation then null; end;
  update public.offline_pos_policies set operator_lease_seconds = 86400, catalog_grant_seconds = 86400
   where register_id = '2a000005-0000-4000-8000-000000000001';
  assert true, 'L8 the exact hard maximum (24 h / 24 h) is accepted';
  update public.offline_pos_policies set operator_lease_seconds = 43200, catalog_grant_seconds = 43200
   where register_id = '2a000005-0000-4000-8000-000000000001';
end $b$;
alter table public.offline_pos_policies validate constraint offline_pos_policies_lease_bounds;
do $b$ begin
  assert (select convalidated from pg_constraint where conname = 'offline_pos_policies_lease_bounds'), 'L9 constraint validates once rows comply';
end $b$;

-- E1..E4  exact expiry boundary + clock skew at ingestion (acceptedAt vs the grant and the server clock).
-- A 120-second lease so the exact boundary lies inside the server's 5-minute skew window.
update public.offline_pos_policies set operator_lease_seconds = 120, catalog_grant_seconds = 120
 where register_id = '2a000005-0000-4000-8000-000000000001';
create temp table eg as select * from pg_temp.grant_for('lb-grant-2');
do $b$ declare v_until timestamptz := (select accepted_until from public.offline_grants where id = (select id from eg)); begin
  assert pg_temp.ingest_code(pg_temp.sale((select id from eg), 'e0000000-0000-4000-8000-000000000001', v_until)) = 'ok',
    'E1 acceptedAt exactly at accepted_until is accepted';
  assert pg_temp.ingest_code(pg_temp.sale((select id from eg), 'e0000000-0000-4000-8000-000000000002', v_until + interval '1 millisecond')) = 'OG410',
    'E2 one millisecond past accepted_until is refused';
  assert pg_temp.ingest_code(pg_temp.sale((select id from eg), 'e0000000-0000-4000-8000-000000000003', now() + interval '6 minutes')) = 'OG410',
    'E3 a till clock more than 5 minutes ahead of the server is refused (skew bound)';
  assert pg_temp.ingest_code(pg_temp.sale((select id from eg), 'e0000000-0000-4000-8000-000000000004',
    (select issued_at from public.offline_grants where id = (select id from eg)) - interval '6 minutes')) = 'OG410',
    'E4 acceptedAt before the grant (minus 5 minutes skew) is refused';
end $b$;

-- P1..P6  offline PIN v2: v1 retired, v2 holds no PIN material, enrollment rules.
do $b$ declare r record; begin
  assert not exists (select 1 from public.staff_offline_pin_credentials where retired_at is null or ciphertext_base64 is not null),
    'P1 no live KEK-sealed PIN material';
  begin
    insert into public.staff_offline_pin_credentials (tenant_id, membership_id, key_version, cipher_algorithm, ciphertext_base64,
      iv_base64, auth_tag_base64, kdf_algorithm, scrypt_n, scrypt_r, scrypt_p, key_length, salt_length, set_by_membership_id)
    values ('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', 1, 'aes-256-gcm', 'eA==', 'eA==', 'eA==',
      'scrypt', 16384, 8, 1, 32, 16, '2a000012-0000-4000-8000-000000000001');
    raise exception 'P2 expected a live sealed PIN to be impossible';
  exception when check_violation then null; end;
  assert not has_function_privilege('service_role', 'staff_private.set_offline_pin(uuid,uuid,text,uuid,integer,text,text,text,text,integer,integer,integer,integer,integer)', 'execute'),
    'P3 transport cannot write sealed PINs';
  assert not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'staff_offline_pin_enrollments'
      and column_name ~ '(salt|hash|cipher|pin$|secret)'), 'P4 v2 enrollment table holds no PIN-derived column';
  select * into r from offline_pos_private.enroll_offline_pin('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001',
    (select id from public.devices limit 1), '2a000005-0000-4000-8000-000000000001', 'pin-v2-a');
  assert r.verifier_version = 1, 'P5 first enrollment is version 1';
  select * into r from offline_pos_private.enroll_offline_pin('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001',
    (select id from public.devices limit 1), '2a000005-0000-4000-8000-000000000001', 'pin-v2-b');
  assert r.verifier_version = 2 and (select count(*) = 1 from public.staff_offline_pin_enrollments where revoked_at is null),
    'P6 re-enrollment supersedes (exactly one active, version 2)';
  assert (select count(*) = 1 from offline_pos_private.offline_pin_authorizations('2a000001-0000-4000-8000-000000000001',
    '2a000005-0000-4000-8000-000000000001', (select id from public.devices limit 1)) where verifier_version = 2),
    'P7 bootstrap authorises only the current version';
  begin
    update public.staff_offline_pin_enrollments set verifier_version = 9;
    raise exception 'P8 expected enrollment rows to be immutable except revocation';
  exception when sqlstate 'P0001' then null; end;
  assert offline_pos_private.revoke_offline_pin_enrollments('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', null, 'pin_forgotten') = 1,
    'P9 revocation';
  assert not exists (select 1 from offline_pos_private.offline_pin_authorizations('2a000001-0000-4000-8000-000000000001',
    '2a000005-0000-4000-8000-000000000001', (select id from public.devices limit 1))), 'P10 a revoked enrollment is never re-authorised';
end $b$;

-- S1..S3  connected sign-in failure accounting (20261115190000): a failed attempt is recorded without error and
-- 5 failures lock the username (the step-up of offline PIN enrollment relies on this lockout).
do $b$ declare r record; i integer; begin
  select * into r from staff_private.pos_login_record('lockout.probe', false);
  assert r.failed_count = 1 and r.locked_until is null, 'S1 a failed sign-in is counted (no 42702 ambiguity)';
  for i in 2..5 loop select * into r from staff_private.pos_login_record('lockout.probe', false); end loop;
  assert r.locked_until > now() and r.failed_count = 0, 'S2 the 5th failure locks the username';
  select * into r from staff_private.pos_login_record('lockout.probe', true);
  assert not exists (select 1 from public.pos_login_attempts where username = 'lockout.probe'), 'S3 success clears the counter';
end $b$;

select 'ALL_LEASE_BOUNDS_AND_PIN_V2_ASSERTIONS_PASSED' as result;
