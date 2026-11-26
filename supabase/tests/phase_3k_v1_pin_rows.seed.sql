-- Seed for "v1 PIN cleanup on existing rows": applied on a disposable database AFTER every migration BEFORE
-- 20261115170000 and BEFORE that migration runs, to reproduce the shared-dev situation (live KEK-sealed rows).
-- The ciphertext below is placeholder bytes (base64 of "x"), not derived from any PIN or key.
\set ON_ERROR_STOP on
insert into public.staff_offline_pin_credentials (tenant_id, membership_id, key_version, cipher_algorithm,
  ciphertext_base64, iv_base64, auth_tag_base64, kdf_algorithm, scrypt_n, scrypt_r, scrypt_p, key_length,
  salt_length, set_by_membership_id)
values
  ('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000001', 1, 'aes-256-gcm', 'eA==', 'eA==',
   'eA==', 'scrypt', 16384, 8, 1, 32, 16, '2a000012-0000-4000-8000-000000000001'),
  ('2a000001-0000-4000-8000-000000000001', '2a000012-0000-4000-8000-000000000002', 1, 'aes-256-gcm', 'eA==', 'eA==',
   'eA==', 'scrypt', 16384, 8, 1, 32, 16, '2a000012-0000-4000-8000-000000000001');
select 'SEEDED_V1_ROWS' as result, count(*) from public.staff_offline_pin_credentials;
