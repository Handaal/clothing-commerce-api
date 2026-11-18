-- ADR-043 POS-native account lifecycle (migration 20261118120000) on a disposable database, AFTER
-- phase_2h_pos_sale.setup.sql + phase_2i_offline_pos.setup.sql. Real commits; the runner discards the container.
\set ON_ERROR_STOP on

-- Two POS admins (m1, m2) and one cashier (m3) in the fixture tenant, with a throwaway verifier.
insert into public.staff_pos_pin_credentials (tenant_id, membership_id, salt_base64, hash_base64, scrypt_n, scrypt_r,
  scrypt_p, key_length, pos_role, set_by_membership_id)
values
  ('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', 'c2FsdDE=', 'aGFzaDE=', 16384, 8, 1, 32, 'admin', '2a000012-0000-4000-8000-000000000001'),
  ('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000002', 'c2FsdDI=', 'aGFzaDI=', 16384, 8, 1, 32, 'admin', '2a000012-0000-4000-8000-000000000001'),
  ('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000003', 'c2FsdDM=', 'aGFzaDM=', 16384, 8, 1, 32, 'cashier', '2a000012-0000-4000-8000-000000000001');

select offline_pos_private.enroll_device('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','till-al','Till AL','c3BraS1rZXk=',repeat('cd',32),'1.0.0','win32','11','al-enroll-1');

create function pg_temp.err(p_sql text) returns text language plpgsql as $f$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $f$;

-- R1..R4  PIN reset revokes offline enrollments of THAT member only, in the same transaction.
do $b$ declare r record; v_device uuid := (select id from public.devices limit 1); begin
  perform offline_pos_private.enroll_offline_pin('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001',
    v_device, '2a000005-0000-4000-8000-000000000001', 'al-pin-1');
  assert (select count(*) = 1 from public.staff_offline_pin_enrollments
           where membership_id = '2a000012-0000-4000-8000-000000000001' and revoked_at is null), 'R0 enrolled';

  -- A non-PIN change (role/permissions) does NOT revoke.
  update public.staff_pos_pin_credentials set pos_permissions = '{orders}'
   where membership_id = '2a000012-0000-4000-8000-000000000001';
  assert (select count(*) = 1 from public.staff_offline_pin_enrollments
           where membership_id = '2a000012-0000-4000-8000-000000000001' and revoked_at is null), 'R1 non-PIN update keeps enrollment';

  -- The real reset RPC (actor covers itself).
  perform staff_private.set_pos_login_pin('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001',
    'al-reset-1', '2a000012-0000-4000-8000-000000000001', 'bmV3c2FsdA==', 'bmV3aGFzaA==', 16384, 8, 1, 32);
  assert not exists (select 1 from public.staff_offline_pin_enrollments
           where membership_id = '2a000012-0000-4000-8000-000000000001' and revoked_at is null), 'R2 PIN reset revokes';
  assert (select revoked_reason = 'pin_reset' from public.staff_offline_pin_enrollments
           where membership_id = '2a000012-0000-4000-8000-000000000001' order by verifier_version desc limit 1), 'R3 reason pin_reset';
  assert not exists (select 1 from offline_pos_private.offline_pin_authorizations('2a000001-0000-4000-8000-000000000001',
    '2a000005-0000-4000-8000-000000000001', v_device) where membership_id = '2a000012-0000-4000-8000-000000000001'),
    'R4 bootstrap no longer authorises the stale verifier';
  -- Re-enrolment after the reset works (the next online sign-in does this) and is a NEW version.
  select * into r from offline_pos_private.enroll_offline_pin('2a000001-0000-4000-8000-000000000001',
    '2a000012-0000-4000-8000-000000000001', v_device, '2a000005-0000-4000-8000-000000000001', 'al-pin-2');
  assert r.verifier_version = 2, 'R5 re-enrolment after reset is version 2';
end $b$;

-- A1..A6  last active POS admin protection.
do $b$ begin
  -- Demoting one of two admins is fine.
  perform staff_private.update_pos_login('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000002',
    'al-demote-1', '2a000012-0000-4000-8000-000000000002', null, 'cashier', '{}');
  assert (select pos_role = 'cashier' from public.staff_pos_pin_credentials
           where membership_id = '2a000012-0000-4000-8000-000000000002'), 'A1 demote one of two admins';

  -- Now m1 is the last active admin: demotion via the RPC is refused with ST414.
  assert pg_temp.err($q$select staff_private.update_pos_login('2a000001-0000-4000-8000-000000000001',
    '2a000012-0000-4000-8000-000000000001', 'al-demote-2', '2a000012-0000-4000-8000-000000000001', null, 'cashier', '{}')$q$) = 'ST414',
    'A2 demoting the last admin is refused';
  -- ...and via a direct write path too (the trigger, not the RPC, is the guarantee).
  assert pg_temp.err($q$update public.staff_pos_pin_credentials set pos_role = 'cashier'
    where membership_id = '2a000012-0000-4000-8000-000000000001'$q$) = 'ST414', 'A3 trigger guards every path';
  -- Deactivating / suspending the last admin's membership is refused.
  assert pg_temp.err($q$update public.memberships set status = 'suspended', suspended_at = now()
    where id = '2a000012-0000-4000-8000-000000000001'$q$) = 'ST414', 'A4 suspending the last admin is refused';
  -- Deactivating a cashier is unaffected.
  update public.memberships set status = 'suspended', suspended_at = now() where id = '2a000012-0000-4000-8000-000000000003';
  assert (select status = 'suspended' from public.memberships where id = '2a000012-0000-4000-8000-000000000003'),
    'A5 cashier deactivation unaffected';
  update public.memberships set status = 'active', suspended_at = null where id = '2a000012-0000-4000-8000-000000000003';
  -- Promote another admin first, then the former last admin may be demoted.
  update public.staff_pos_pin_credentials set pos_role = 'admin' where membership_id = '2a000012-0000-4000-8000-000000000003';
  update public.staff_pos_pin_credentials set pos_role = 'cashier' where membership_id = '2a000012-0000-4000-8000-000000000001';
  assert (select count(*) = 1 from public.staff_pos_pin_credentials where pos_role = 'admin'), 'A6 promote-then-demote allowed';
end $b$;

-- A7  an inactive admin does not count as "another active admin".
do $b$ begin
  update public.staff_pos_pin_credentials set pos_role = 'admin' where membership_id = '2a000012-0000-4000-8000-000000000002';
  update public.memberships set status = 'suspended', suspended_at = now() where id = '2a000012-0000-4000-8000-000000000002';
  assert pg_temp.err($q$update public.staff_pos_pin_credentials set pos_role = 'cashier'
    where membership_id = '2a000012-0000-4000-8000-000000000003'$q$) = 'ST414', 'A7 suspended admin is not a fallback admin';
end $b$;

-- A8  the guard functions are not callable by client roles.
do $b$ begin
  assert not has_function_privilege('authenticated', 'staff_private.other_active_pos_admin_exists(uuid,uuid)', 'execute'),
    'A8 helper not exposed';
end $b$;

-- L1..L2  login resolution requires an active membership: a suspended account resolves no credential.
do $b$ declare v_user text; begin
  update public.user_identities set login_username = 'al.suspended' where id = '2a000010-0000-4000-8000-000000000002';
  v_user := 'al.suspended';
  assert (select membership_id is null and hash_base64 is null from staff_private.pos_login_begin(v_user)),
    'L1 suspended member resolves no credential';
  update public.memberships set status = 'active', suspended_at = null where id = '2a000012-0000-4000-8000-000000000002';
  assert (select membership_id = '2a000012-0000-4000-8000-000000000002' from staff_private.pos_login_begin('AL.Suspended ')),
    'L2 reactivated member resolves again (username normalised)';
end $b$;

select 'ALL_POS_NATIVE_ACCOUNT_LIFECYCLE_ASSERTIONS_PASSED' as result;
