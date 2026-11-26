-- Offline PIN v1 cleanup ON EXISTING ROWS (20261115170000 Part A), proven on a disposable database where live
-- KEK-sealed rows existed BEFORE the migration ran (phase_3k_v1_pin_rows.seed.sql). No row is decrypted.
\set ON_ERROR_STOP on
do $b$ declare v_state text; begin
  assert (select count(*) = 2 from public.staff_offline_pin_credentials), 'C1 the two pre-existing v1 rows are still present (retired, not silently dropped)';
  assert not exists (select 1 from public.staff_offline_pin_credentials
                      where retired_at is null or ciphertext_base64 is not null or iv_base64 is not null or auth_tag_base64 is not null),
    'C2 every pre-existing row is retired with ciphertext, IV and tag erased';
  assert (select bool_and(retired_reason = 'kek_sealed_model_retired') from public.staff_offline_pin_credentials), 'C3 retirement reason recorded';
  begin
    update public.staff_offline_pin_credentials set retired_at = null;
    raise exception 'C4 expected un-retiring a row to be impossible';
  exception when check_violation then null; end;
  begin
    update public.staff_offline_pin_credentials set ciphertext_base64 = 'eA==';
    raise exception 'C5 expected re-adding ciphertext to be impossible';
  exception when check_violation then null; end;
  begin
    perform staff_private.set_offline_pin('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', 'k3k-set',
      '2a000012-0000-4000-8000-000000000001', 1, 'aes-256-gcm', 'eA==', 'eA==', 'eA==', 16384, 8, 1, 32, 16);
    raise exception 'C6 expected the v1 writer to refuse';
  exception when sqlstate 'ST410' then null; end;
  begin
    perform * from staff_private.offline_sell_roster('2a000001-0000-4000-8000-000000000001', '2a000005-0000-4000-8000-000000000001');
    v_state := 'returned';
  exception when sqlstate 'ST410' then v_state := 'ST410'; end;
  assert v_state = 'ST410', 'C7 the v1 roster reader refuses (nothing can be read for minting)';
  assert not has_function_privilege('service_role', 'staff_private.offline_sell_roster(uuid,uuid)', 'execute')
     and not has_function_privilege('service_role', 'staff_private.set_offline_pin(uuid,uuid,text,uuid,integer,text,text,text,text,integer,integer,integer,integer,integer)', 'execute'),
    'C8 the API transport role cannot call either v1 function';
  assert not exists (select 1 from offline_pos_private.offline_pin_authorizations('2a000001-0000-4000-8000-000000000001',
      '2a000005-0000-4000-8000-000000000001', (select id from public.devices limit 1))),
    'C9 old v1 holders get NO offline unlock authorization until they re-enrol (v2)';
end $b$;
select 'ALL_V1_PIN_CLEANUP_ASSERTIONS_PASSED' as result;
