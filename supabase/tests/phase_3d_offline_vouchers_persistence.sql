-- ADR-042 §5/§6: voucher channel policies, reserved POS quota, offline redemption (D-2 exceptions), admin
-- assertions, override passwords, lease bound. Runs AFTER phase_2h_pos_sale.setup.sql +
-- phase_2i_offline_pos.setup.sql (legacy location: stock grants stay out of the way).
\set ON_ERROR_STOP on

create temp table g(name text primary key, id uuid);
create function pg_temp.grant_for(p_key text) returns uuid language sql as $f$
  select g.id from offline_pos_private.issue_grant('2a000001-0000-4000-8000-000000000001', (select id from public.devices limit 1),
    '2a000005-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', p_key) g;
$f$;
create function pg_temp.vg(p_grant text) returns jsonb language sql as $f$
  select promotions_private.voucher_grants_json('2a000001-0000-4000-8000-000000000001', (select id from g where name = p_grant));
$f$;
-- Offline sale of p_qty units at 2500 with an optional voucher block.
create function pg_temp.ingest(p_grant text, p_sync uuid, p_ordinal int, p_qty int, p_cumulative bigint, p_voucher jsonb)
returns text language plpgsql as $f$
declare v_grant public.offline_grants%rowtype; v_cmd jsonb; v_net bigint; v_status text;
begin
  select * into v_grant from public.offline_grants where id = (select id from g where name = p_grant);
  v_net := 2500 * p_qty - coalesce((p_voucher->>'discountTotalMinor')::bigint, 0);
  v_cmd := jsonb_build_object(
    'schemaVersion', 1, 'localSaleId', 'local-' || p_sync, 'syncCommandId', p_sync, 'grantId', v_grant.id,
    'deviceId', v_grant.device_id, 'registerId', v_grant.register_id, 'acceptedAt', now(), 'currency', v_grant.currency,
    'lines', jsonb_build_array(jsonb_build_object('variantId', '2a000007-0000-4000-8000-000000000001', 'quantity', p_qty,
      'grantedUnitPriceMinor', 2500,
      'priceId', (select v.value->>'priceId' from jsonb_array_elements(v_grant.catalog_snapshot) p(value),
                   lateral jsonb_array_elements(p.value->'variants') v(value)
                  where v.value->>'variantId' = '2a000007-0000-4000-8000-000000000001'))),
    'totalMinor', v_net, 'cashReceivedMinor', v_net, 'changeMinor', 0,
    'offlineSaleOrdinal', p_ordinal, 'cumulativeExposureMinor', p_cumulative);
  if p_voucher is not null then v_cmd := v_cmd || jsonb_build_object('voucher', p_voucher); end if;
  select r.sync_status into v_status from offline_pos_private.record_offline_sale('2a000001-0000-4000-8000-000000000001',
    (select c.id from public.device_credentials c where c.device_id = v_grant.device_id limit 1),
    v_cmd, v_cmd::text, encode(sha256(convert_to(p_sync::text, 'utf8')), 'hex'), 'c2lnbmF0dXJl') r;
  return v_status;
end;
$f$;
create function pg_temp.voucher(p_grant text, p_discount bigint, p_assertion jsonb default null) returns jsonb language sql as $f$
  select jsonb_strip_nulls(jsonb_build_object('voucherGrantId', vg->>'voucherGrantId', 'promotionId', vg->>'promotionId',
         'codeId', vg->>'codeId', 'discountTotalMinor', p_discount, 'adminAssertion', p_assertion))
    from jsonb_array_elements(pg_temp.vg(p_grant)) vg limit 1;
$f$;
create function pg_temp.pol() returns public.promotion_channel_policies language sql as $f$
  select * from public.promotion_channel_policies where promotion_id = '3d000001-0000-4000-8000-000000000001' and channel = 'pos';
$f$;

-- Fixtures: an approver role (promotions.manage + payments.refund) on member ...0002 at the register's branch.
insert into public.roles (id, tenant_id, name, status, is_protected)
values ('3d000013-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', 'Approver', 'active', false);
insert into public.role_permissions (tenant_id, role_id, permission_id)
select '2a000001-0000-4000-8000-000000000001', '3d000013-0000-4000-8000-000000000001', id
  from public.permissions where key in ('promotions.manage', 'payments.refund');
insert into public.membership_role_assignments (id, tenant_id, membership_id, role_id, access_scope_id, assigned_at)
values ('3d000016-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000002',
        '3d000013-0000-4000-8000-000000000001', '2a000014-0000-4000-8000-000000000001', now());
update public.user_identities set login_username = 'approver' where id = '2a000010-0000-4000-8000-000000000002';

-- A 10% code voucher, both channels.
insert into public.promotions (id, tenant_id, name, benefit_type, benefit_percent_bp, target_type, activation_type, status)
values ('3d000001-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', 'Ten off', 'percentage', 1000, 'order', 'code', 'active');
insert into public.promotion_codes (id, tenant_id, promotion_id, code)
values ('3d000002-0000-4000-8000-000000000001', '2a000001-0000-4000-8000-000000000001', '3d000001-0000-4000-8000-000000000001', 'SAVE10');

select offline_pos_private.enroll_device('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',
  '2a000012-0000-4000-8000-000000000001','till-1','Till 1','c3BraS1rZXk=',repeat('cd',32),'1.0.0','win32','11','vx-enroll-1');

-- 1. Missing owner caps (D-7) => nothing granted offline -------------------------------------------------
select promotions_private.upsert_channel_policy('2a000001-0000-4000-8000-000000000001','3d000001-0000-4000-8000-000000000001','pos',
  '{"usageLimit":6,"offlineEnabled":true,"offlineQuotaPerGrant":2}');
insert into g values ('g1', pg_temp.grant_for('vx-grant-1'));
do $b$ begin
  assert jsonb_array_length(promotions_private.issue_offline_voucher_grants('2a000001-0000-4000-8000-000000000001',
    (select id from g where name = 'g1'), null, null)) = 0, 'V1 no caps, no offline voucher grant (fail closed)';
  assert (pg_temp.pol()).reserved_count = 0, 'V2 nothing reserved';
end $b$;

-- 2. With caps: quota is reserved per till ------------------------------------------------------------------
select promotions_private.upsert_channel_policy('2a000001-0000-4000-8000-000000000001','3d000001-0000-4000-8000-000000000001','pos',
  '{"usageLimit":6,"offlineEnabled":true,"offlineQuotaPerGrant":2,"maxDiscountPerRedemptionMinor":1000,"maxDiscountPerGrantMinor":1500}');
insert into g values ('g2', pg_temp.grant_for('vx-grant-2'));
do $b$ declare r jsonb; begin
  r := promotions_private.issue_offline_voucher_grants('2a000001-0000-4000-8000-000000000001', (select id from g where name = 'g2'), null, null);
  assert jsonb_array_length(r) = 1 and (r->0->>'allowedCount')::int = 2 and r->0->'terms'->>'code' = 'SAVE10', 'V3 grant of 2 uses for SAVE10';
  assert (pg_temp.pol()).reserved_count = 2, 'V4 policy reserved 2';
  assert promotions_private.issue_offline_voucher_grants('2a000001-0000-4000-8000-000000000001', (select id from g where name = 'g2'), null, null)->0->>'voucherGrantId' = r->0->>'voucherGrantId', 'V5 replay is idempotent';
end $b$;

-- 3. Valid offline redemption consumes one reserved unit; the order is net -------------------------------
do $b$ begin
  assert pg_temp.ingest('g2', '3d000000-0000-4000-8000-000000000001', 1, 2, 4500, pg_temp.voucher('g2', 500)) = 'synced', 'R1 voucher sale synced';
end $b$;
do $b$ begin
  assert (pg_temp.pol()).reserved_count = 1 and (pg_temp.pol()).redeemed_count = 1, 'R2 reserved 2->1, redeemed 0->1';
  assert (select consumed_count = 1 and discount_consumed_minor = 500 from public.offline_pos_voucher_grants where offline_grant_id = (select id from g where name = 'g2')), 'R3 grant consumed 1 (500)';
  assert (select o.total_minor = 4500 and o.discount_total_minor = 500 from public.orders o join public.offline_sale_ingestions i on i.order_id = o.id where i.sync_command_id = '3d000000-0000-4000-8000-000000000001'), 'R4 order total is the net paid';
  assert (select count(*) = 1 from public.promotion_redemptions where channel = 'pos'), 'R5 one POS redemption';
end $b$;

-- 4. Discount not matching the signed terms: sale stands, exception, unit released --------------------------
do $b$ begin
  assert pg_temp.ingest('g2', '3d000000-0000-4000-8000-000000000002', 2, 2, 8900, pg_temp.voucher('g2', 600)) = 'synced', 'X1 mismatched voucher sale still synced';
end $b$;
do $b$ begin
  assert (select code = 'VX_DISCOUNT_MISMATCH' and discount_total_minor = 600 from public.offline_voucher_exceptions), 'X2 exception recorded';
  assert (select o.total_minor = 4400 from public.orders o join public.offline_sale_ingestions i on i.order_id = o.id where i.sync_command_id = '3d000000-0000-4000-8000-000000000002'), 'X3 sale stands at the price paid';
  assert (pg_temp.pol()).reserved_count = 0 and (pg_temp.pol()).redeemed_count = 1, 'X4 no quota consumed, unit released';
  assert (select count(*) = 1 from public.promotion_redemptions), 'X5 no redemption for the exception';
end $b$;

-- 5. Channel capacity: quoting and the redemption guard -------------------------------------------------------
do $b$ declare v_lines jsonb := '[{"ord":1,"variantId":"2a000007-0000-4000-8000-000000000001","productId":null,"quantity":1,"lineTotalMinor":2500}]'; begin
  assert (promotions_private.evaluate('2a000001-0000-4000-8000-000000000001','pos','USD',null,null,v_lines,'SAVE10')->>'applied')::boolean, 'Q1 quoted while POS capacity remains';
  update public.promotion_channel_policies set redeemed_count = 6 where id = (pg_temp.pol()).id;
  assert not (promotions_private.evaluate('2a000001-0000-4000-8000-000000000001','pos','USD',null,null,v_lines,'SAVE10')->>'applied')::boolean, 'Q2 not quoted when POS capacity is used up';
  begin
    insert into public.promotion_redemptions (tenant_id, promotion_id, code_id, order_id, channel, discount_total_minor)
    values ('2a000001-0000-4000-8000-000000000001','3d000001-0000-4000-8000-000000000001','3d000002-0000-4000-8000-000000000001',
            (select order_id from public.offline_sale_ingestions where sync_command_id = '3d000000-0000-4000-8000-000000000002'), 'pos', 1);
    raise exception 'Q3 expected PR409';
  exception when sqlstate 'PR409' then null; end;
  assert promotions_private.channel_has_capacity('2a000001-0000-4000-8000-000000000001','3d000001-0000-4000-8000-000000000001','3d000002-0000-4000-8000-000000000001','online'), 'Q4 online capacity is independent';
  update public.promotion_channel_policies set redeemed_count = 1 where id = (pg_temp.pol()).id;
end $b$;

-- 6. Admin credential required: missing => exception; issued + bound + single use => redeemed ---------------
select promotions_private.upsert_channel_policy('2a000001-0000-4000-8000-000000000001','3d000001-0000-4000-8000-000000000001','pos',
  '{"usageLimit":6,"offlineEnabled":true,"offlineQuotaPerGrant":2,"requiresAdminCredentials":true,"maxDiscountPerRedemptionMinor":1000,"maxDiscountPerGrantMinor":1500}');
insert into g values ('g3', pg_temp.grant_for('vx-grant-3'));
do $b$ declare r jsonb; begin
  assert (pg_temp.pol()).version = 2, 'C1 adding the credential requirement bumps the policy version';
  r := promotions_private.issue_offline_voucher_grants('2a000001-0000-4000-8000-000000000001', (select id from g where name = 'g3'),
         (select id from g where name = 'g2'), 2);
  assert (r->0->>'requiresAdminCredentials')::boolean and (r->0->>'allowedCount')::int = 2, 'C2 new grant carries the credential flag';
  assert (select status = 'closed' from public.offline_pos_voucher_grants where offline_grant_id = (select id from g where name = 'g2')), 'C3 previous voucher grant closed';
  perform offline_pos_private.record_admin_verifier_issuances('2a000001-0000-4000-8000-000000000001', (select id from g where name = 'g3'),
    '[{"membershipId":"2a000012-0000-4000-8000-000000000002","permission":"promotions.manage","verifierVersion":1}]');
end $b$;
do $b$ begin
  assert pg_temp.ingest('g3', '3d000000-0000-4000-8000-000000000003', 1, 1, 2250, pg_temp.voucher('g3', 250)) = 'synced', 'C4 sale without credential still stands';
  assert (select count(*) = 1 from public.offline_voucher_exceptions where code = 'VX_CREDENTIAL_MISSING'), 'C5 missing credential is an exception';
end $b$;
do $b$ begin
  assert pg_temp.ingest('g3', '3d000000-0000-4000-8000-000000000004', 2, 1, 4500, pg_temp.voucher('g3', 250, jsonb_build_object(
    'assertionId', '3d0000aa-0000-4000-8000-000000000001', 'adminMembershipId', '2a000012-0000-4000-8000-000000000002',
    'permission', 'promotions.manage', 'verifierVersion', 1, 'commandId', '3d000000-0000-4000-8000-000000000004'))) = 'synced', 'C6 credentialed sale synced';
  assert (select count(*) = 2 from public.promotion_redemptions), 'C7 credentialed use redeemed';
  assert offline_pos_private.consume_admin_assertion('2a000001-0000-4000-8000-000000000001', (select id from g where name = 'g3'),
    '3d000000-0000-4000-8000-000000000004', jsonb_build_object('assertionId', '3d0000aa-0000-4000-8000-000000000001',
    'adminMembershipId', '2a000012-0000-4000-8000-000000000002', 'permission', 'promotions.manage', 'verifierVersion', 1,
    'commandId', '3d000000-0000-4000-8000-000000000004'), 'promotions.manage') = 'CREDENTIAL_REUSED', 'C8 an assertion is single use';
  assert offline_pos_private.consume_admin_assertion('2a000001-0000-4000-8000-000000000001', (select id from g where name = 'g3'),
    '3d000000-0000-4000-8000-000000000009', jsonb_build_object('assertionId', '3d0000aa-0000-4000-8000-000000000002',
    'adminMembershipId', '2a000012-0000-4000-8000-000000000002', 'permission', 'promotions.manage', 'verifierVersion', 2,
    'commandId', '3d000000-0000-4000-8000-000000000009'), 'promotions.manage') = 'CREDENTIAL_NOT_ISSUED', 'C9 a stale verifier version is refused';
  assert offline_pos_private.consume_admin_assertion('2a000001-0000-4000-8000-000000000001', (select id from g where name = 'g3'),
    '3d000000-0000-4000-8000-000000000009', jsonb_build_object('assertionId', '3d0000aa-0000-4000-8000-000000000003',
    'adminMembershipId', '2a000012-0000-4000-8000-000000000002', 'permission', 'promotions.manage', 'verifierVersion', 1,
    'commandId', '3d000000-0000-4000-8000-000000000008'), 'promotions.manage') = 'CREDENTIAL_INVALID', 'C10 an assertion bound to another command is refused';
end $b$;

-- 7. Policy withdrawn after the grant ---------------------------------------------------------------------
insert into g values ('g4', pg_temp.grant_for('vx-grant-4'));
select promotions_private.issue_offline_voucher_grants('2a000001-0000-4000-8000-000000000001', (select id from g where name = 'g4'),
  (select id from g where name = 'g3'), 2);
select promotions_private.upsert_channel_policy('2a000001-0000-4000-8000-000000000001','3d000001-0000-4000-8000-000000000001','pos',
  '{"usageLimit":6,"offlineEnabled":false}');
do $b$ begin
  assert pg_temp.ingest('g4', '3d000000-0000-4000-8000-000000000005', 1, 1, 2250, pg_temp.voucher('g4', 250)) = 'synced', 'W1 sale stands';
  assert (select count(*) = 1 from public.offline_voucher_exceptions where code = 'VX_POLICY_WITHDRAWN'), 'W2 withdrawn policy is an exception';
  assert jsonb_array_length(promotions_private.issue_offline_voucher_grants('2a000001-0000-4000-8000-000000000001',
    pg_temp.grant_for('vx-grant-5'), (select id from g where name = 'g4'), 1)) = 0, 'W3 disabled voucher is no longer granted';
  assert (pg_temp.pol()).reserved_count = 0, 'W4 every reservation returned';
end $b$;

-- 8. Override passwords (verifier v2: one-way scrypt verifier only, no recoverable copy) ------------------------
do $b$ declare r jsonb; begin
  begin
    perform staff_private.set_pos_override_password_v2('2a000001-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000003','ovr-1',
      'c2FsdHNhbHRzYWx0c2FsdA==','aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=',32768,8,1,32,16);
    raise exception 'P1 expected ST403';
  exception when sqlstate 'ST403' then null; end;
  r := staff_private.set_pos_override_password_v2('2a000001-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000002','ovr-2',
      'c2FsdHNhbHRzYWx0c2FsdA==','aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=',32768,8,1,32,16);
  assert (r->>'verifierVersion')::int = 1, 'P2 first set is version 1';
  r := staff_private.set_pos_override_password_v2('2a000001-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000002','ovr-3',
      'c2FsdDJzYWx0MnNhbHQyIQ==','aGFzaDJoYXNoMmhhc2gyaGFzaDJoYXNoMmhhc2gyISE=',32768,8,1,32,16);
  assert (r->>'verifierVersion')::int = 2, 'P3 change bumps the version';
  assert (select permissions = array['payments.refund','promotions.manage'] from staff_private.pos_override_roster('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001')), 'P4 roster tags both permissions';
  assert (select verifier_algorithm = 'scrypt-hmac-sha256-v2' and verifier_hash_base64 is not null
            from staff_private.pos_override_roster('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001')),
    'P4b roster carries only the one-way v2 verifier';
  r := staff_private.clear_pos_override_password('2a000001-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000001','ovr-4','2a000012-0000-4000-8000-000000000002');
  assert (r->>'verifierVersion')::int = 3, 'P5 clear bumps the version';
  assert (select count(*) = 0 from staff_private.pos_override_roster('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001')), 'P6 cleared admin leaves the roster';
  assert (select ciphertext_base64 is null and verifier_hash_base64 is null and verifier_salt_base64 is null
            from public.staff_pos_override_credentials where membership_id = '2a000012-0000-4000-8000-000000000002'), 'P7 cleared material is gone';
  -- P8: no row may ever hold recoverable (encrypted) password material again.
  begin
    update public.staff_pos_override_credentials set ciphertext_base64 = 'Y2lwaGVy', iv_base64 = 'aXY=',
      auth_tag_base64 = 'dGFn', key_version = 1, cipher_algorithm = 'aes-256-gcm'
     where membership_id = '2a000012-0000-4000-8000-000000000002';
    raise exception 'P8 expected 23514';
  exception when sqlstate '23514' then null; end;
  -- P9: the KEK-sealed write path no longer exists.
  assert not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'staff_private' and p.proname = 'set_pos_override_password'),
    'P9 sealed set function dropped';
  -- P10: the roster exposes no sealed-material column.
  assert not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'staff_private' and p.proname = 'pos_override_roster'
                        and (p.proargnames::text like '%ciphertext%' or p.proargnames::text like '%auth_tag%')),
    'P10 roster returns no ciphertext';
  -- P11: a weak work factor is refused (admin credential: N >= 2^14, r >= 8, 32-byte output).
  begin
    perform staff_private.set_pos_override_password_v2('2a000001-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000002','ovr-5',
      'c2FsdHNhbHRzYWx0c2FsdA==','aGFzaA==',1024,1,1,16,16);
    raise exception 'P11 expected 23514';
  exception when sqlstate '23514' then null; end;
end $b$;

-- 9. Lease bound (D-5) ---------------------------------------------------------------------------------------------
do $b$ begin
  begin
    update public.offline_pos_policies set catalog_grant_seconds = 86400 where register_id = '2a000005-0000-4000-8000-000000000001';
    raise exception 'L1 expected 23514';
  exception when sqlstate '23514' then null; end;
  begin
    update public.offline_pos_policies set operator_lease_seconds = 90000, catalog_grant_seconds = 3600 where register_id = '2a000005-0000-4000-8000-000000000001';
    raise exception 'L2 expected 23514';
  exception when sqlstate '23514' then null; end;
end $b$;

-- 9b. Hard lease bound at issuance for a legacy (pre-constraint) policy row; no settings row is rewritten.
do $b$ declare v_grant public.offline_grants%rowtype; v_id uuid; begin
  -- Simulate a row written before offline_pos_policies_lease_bounds existed (disposable DB only).
  alter table public.offline_pos_policies drop constraint offline_pos_policies_lease_bounds;
  update public.offline_pos_policies set operator_lease_seconds = 172800, catalog_grant_seconds = 172800
   where register_id = '2a000005-0000-4000-8000-000000000001';
  assert exists (select 1 from offline_pos_private.lease_policy_violations
                  where register_id = '2a000005-0000-4000-8000-000000000001' and violation = 'operator_lease_above_24h'),
    'L3 the violation view lists the legacy 48 h row';
  v_id := pg_temp.grant_for('lease-clamp-1');
  select * into v_grant from public.offline_grants where id = v_id;
  assert v_grant.operator_expires_at <= v_grant.issued_at + interval '24 hours', 'L4 operator lease clamped to 24 h';
  assert v_grant.catalog_valid_until <= v_grant.operator_expires_at, 'L5 catalog never outlives the lease';
  assert v_grant.accepted_until <= v_grant.issued_at + interval '24 hours', 'L6 authority never beyond 24 h';
  -- Catalog window above the operator lease (the shared-dev shape, 12 h / 24 h): catalog clamped to 12 h.
  update public.offline_pos_policies set operator_lease_seconds = 43200, catalog_grant_seconds = 86400
   where register_id = '2a000005-0000-4000-8000-000000000001';
  assert exists (select 1 from offline_pos_private.lease_policy_violations
                  where register_id = '2a000005-0000-4000-8000-000000000001' and violation = 'catalog_window_above_operator_lease'),
    'L7 the 12 h / 24 h shape is listed';
  v_id := pg_temp.grant_for('lease-clamp-2');
  select * into v_grant from public.offline_grants where id = v_id;
  assert v_grant.catalog_valid_until = v_grant.operator_expires_at, 'L8 catalog clamped to the 12 h lease';
  assert v_grant.accepted_until = v_grant.issued_at + interval '12 hours', 'L9 authority = 12 h';
  -- A compliant row (12 h / 6 h) is untouched by the clamp.
  update public.offline_pos_policies set operator_lease_seconds = 43200, catalog_grant_seconds = 21600
   where register_id = '2a000005-0000-4000-8000-000000000001';
  v_id := pg_temp.grant_for('lease-clamp-3');
  select * into v_grant from public.offline_grants where id = v_id;
  assert v_grant.catalog_valid_until = v_grant.issued_at + interval '6 hours'
     and v_grant.operator_expires_at = v_grant.issued_at + interval '12 hours'
     and v_grant.accepted_until = v_grant.issued_at + interval '6 hours', 'L10 compliant row unchanged';
  assert not exists (select 1 from offline_pos_private.lease_policy_violations
                      where register_id = '2a000005-0000-4000-8000-000000000001'), 'L11 compliant row not listed';
  alter table public.offline_pos_policies add constraint offline_pos_policies_lease_bounds
    check (operator_lease_seconds <= 86400 and catalog_grant_seconds <= operator_lease_seconds) not valid;
  raise notice 'ALL_OFFLINE_VOUCHER_ASSERTIONS_PASSED';
end $b$;
