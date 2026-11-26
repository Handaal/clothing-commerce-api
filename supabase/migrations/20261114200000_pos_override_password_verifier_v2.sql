-- ADR-042 §6.3 (revised) — POS OVERRIDE PASSWORD VERIFIER v2: NO RECOVERABLE COPY ON THE SERVER.
--
-- Security review finding (2026-11-14): 20261114165000_pos_override_passwords.sql stored each admin's override
-- password as an AES-256-GCM envelope under the server KEK and decrypted it at every bootstrap to mint device
-- verifiers. Whoever holds the KEK and a database copy can recover every plaintext password. The owner rule is
-- that the server must not be able to recover user plaintext, so that design must never be activated.
--
-- v2 (forward-only, additive; the 165000 migration is not edited):
--   * the server stores only a slow salted one-way verifier: scrypt(password, salt) + salt + cost params;
--   * at bootstrap the API derives a device-, admin- and version-bound tag
--       HMAC-SHA256(key = verifier, "pos-override-v2" ‖ deviceId ‖ membershipId ‖ verifierVersion)
--     and sends salt + params + tag; the till re-derives it from the typed password (main process only);
--   * no ciphertext column may hold a value any more (CHECK), and the sealed-material write path is dropped.
--
-- Rotation: every sealed (v1) credential is invalidated here — material wiped, verifier_version bumped so any
-- till still holding a v1 verifier stops matching at its next bootstrap. There is no conversion path because
-- converting would require decrypting the plaintext. Qualifying admins re-enter their override password once
-- (online, PIN re-auth). The feature was never activated in production, so no production till is affected.

alter table public.staff_pos_override_credentials
  add column verifier_algorithm text,
  add column verifier_salt_base64 text,
  add column verifier_hash_base64 text;

-- Invalidate every v1 (KEK-sealed) credential: wipe the recoverable material, bump the version.
update public.staff_pos_override_credentials c
   set key_version = null, cipher_algorithm = null, ciphertext_base64 = null, iv_base64 = null,
       auth_tag_base64 = null, cleared_at = coalesce(c.cleared_at, now()),
       verifier_version = c.verifier_version + 1, updated_at = now()
 where c.ciphertext_base64 is not null or c.cleared_at is null;

alter table public.staff_pos_override_credentials
  drop constraint staff_pos_override_credentials_state;
alter table public.staff_pos_override_credentials
  add constraint staff_pos_override_credentials_state check (
    -- No recoverable material ever again, live or cleared.
    key_version is null and cipher_algorithm is null and ciphertext_base64 is null
    and iv_base64 is null and auth_tag_base64 is null
    and (
      (cleared_at is null and verifier_algorithm = 'scrypt-hmac-sha256-v2'
        and verifier_salt_base64 is not null and verifier_hash_base64 is not null)
      or (cleared_at is not null and verifier_algorithm is null and verifier_salt_base64 is null
        and verifier_hash_base64 is null)));
alter table public.staff_pos_override_credentials
  drop constraint staff_pos_override_credentials_scrypt;
-- Admin credential: at least the PIN's work factor (N >= 2^14), 16-byte salt and 32-byte output.
alter table public.staff_pos_override_credentials
  add constraint staff_pos_override_credentials_scrypt check (scrypt_n >= 16384 and scrypt_r >= 8
    and scrypt_p >= 1 and key_length >= 32 and salt_length >= 16);
comment on table public.staff_pos_override_credentials is
  'ADR-042 D-6: per-admin POS override password as a one-way scrypt verifier (v2). No plaintext and no recoverable (encrypted) copy; tills receive only a device/admin/version-bound HMAC tag of the verifier.';

-- The sealed-material write path is removed.
drop function staff_private.set_pos_override_password(uuid, uuid, text, integer, text, text, text, text, integer, integer, integer, integer, integer);

grant create on schema staff_private to staff_writer;

-- Set or change MY OWN override password (self only). The API re-authenticated the caller with their PIN,
-- checked the password policy, and derived the verifier; plaintext never reaches the database.
create function staff_private.set_pos_override_password_v2(
  p_tenant uuid, p_actor uuid, p_key text, p_salt_base64 text, p_hash_base64 text,
  p_scrypt_n integer, p_scrypt_r integer, p_scrypt_p integer, p_key_length integer, p_salt_length integer
) returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_status text; v_row public.staff_pos_override_credentials%rowtype; v_response jsonb;
begin
  if p_tenant is null or p_actor is null or p_salt_base64 is null or p_hash_base64 is null then
    raise exception using errcode = '22023', message = 'Invalid set-override-password command';
  end if;
  v_intent := jsonb_build_object('op', 'set_pos_override_password_v2', 'actor', p_actor);
  v_replay := staff_private.begin_command(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  select m.status into v_status from public.memberships m where m.tenant_id = p_tenant and m.id = p_actor;
  if not found then raise exception using errcode = 'ST404', message = 'Staff member not found'; end if;
  if v_status <> 'active' then raise exception using errcode = 'ST409', message = 'Staff member is not active'; end if;
  if not (staff_private.holds_permission_anywhere(p_tenant, p_actor, 'promotions.manage')
          or staff_private.holds_permission_anywhere(p_tenant, p_actor, 'payments.refund')) then
    raise exception using errcode = 'ST403', message = 'Only accounts that can redeem vouchers or refunds with admin credentials can set an override password';
  end if;

  insert into public.staff_pos_override_credentials as c (
    tenant_id, membership_id, verifier_algorithm, verifier_salt_base64, verifier_hash_base64,
    scrypt_n, scrypt_r, scrypt_p, key_length, salt_length, set_by_membership_id)
  values (p_tenant, p_actor, 'scrypt-hmac-sha256-v2', p_salt_base64, p_hash_base64,
    p_scrypt_n, p_scrypt_r, p_scrypt_p, p_key_length, p_salt_length, p_actor)
  on conflict (tenant_id, membership_id) do update set
    verifier_algorithm = excluded.verifier_algorithm, verifier_salt_base64 = excluded.verifier_salt_base64,
    verifier_hash_base64 = excluded.verifier_hash_base64, scrypt_n = excluded.scrypt_n,
    scrypt_r = excluded.scrypt_r, scrypt_p = excluded.scrypt_p, key_length = excluded.key_length,
    salt_length = excluded.salt_length, set_by_membership_id = excluded.set_by_membership_id,
    key_version = null, cipher_algorithm = null, ciphertext_base64 = null, iv_base64 = null,
    auth_tag_base64 = null, cleared_at = null, verifier_version = c.verifier_version + 1, updated_at = now()
  returning * into v_row;

  v_response := jsonb_build_object('membershipId', p_actor, 'verifierVersion', v_row.verifier_version,
                                   'updatedAt', v_row.updated_at);
  return staff_private.finish_command(p_tenant, p_key, v_intent, v_response);
end $f$;

-- Clearing also wipes the v2 verifier.
create or replace function staff_private.clear_pos_override_password(p_tenant uuid, p_actor uuid, p_key text, p_membership uuid)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_row public.staff_pos_override_credentials%rowtype; v_response jsonb;
begin
  v_intent := jsonb_build_object('op', 'clear_pos_override_password', 'actor', p_actor, 'membership', p_membership);
  v_replay := staff_private.begin_command(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;
  update public.staff_pos_override_credentials c
     set verifier_algorithm = null, verifier_salt_base64 = null, verifier_hash_base64 = null,
         key_version = null, cipher_algorithm = null, ciphertext_base64 = null, iv_base64 = null,
         auth_tag_base64 = null, cleared_at = now(), set_by_membership_id = p_actor,
         verifier_version = c.verifier_version + 1, updated_at = now()
   where c.tenant_id = p_tenant and c.membership_id = p_membership and c.cleared_at is null
  returning * into v_row;
  if not found then
    raise exception using errcode = 'ST404', message = 'No override password is set for this staff member';
  end if;
  v_response := jsonb_build_object('membershipId', p_membership, 'verifierVersion', v_row.verifier_version,
                                   'updatedAt', v_row.updated_at, 'cleared', true);
  return staff_private.finish_command(p_tenant, p_key, v_intent, v_response);
end $f$;

-- Qualifying admins for a register's bootstrap now return the one-way verifier only (no sealed material).
drop function staff_private.pos_override_roster(uuid, uuid);
create function staff_private.pos_override_roster(p_tenant uuid, p_register uuid)
returns table(
  membership_id uuid, username text, display_name text, permissions text[], verifier_version integer,
  verifier_algorithm text, verifier_salt_base64 text, verifier_hash_base64 text,
  scrypt_n integer, scrypt_r integer, scrypt_p integer, key_length integer
) language plpgsql stable security definer set search_path = '' as $f$
declare v_branch uuid;
begin
  select r.branch_id into v_branch from public.registers r
   where r.tenant_id = p_tenant and r.id = p_register and r.status = 'active';
  if not found then raise exception using errcode = 'ST404', message = 'register not found'; end if;
  return query
    select q.id, q.login_username, q.display_name, q.perms, q.verifier_version,
           q.verifier_algorithm, q.verifier_salt_base64, q.verifier_hash_base64,
           q.scrypt_n, q.scrypt_r, q.scrypt_p, q.key_length
      from (
        select m.id, ui.login_username, ui.display_name, c.*,
               array(select k from unnest(staff_private.override_permission_keys()) k
                      where staff_private.covers_permission(p_tenant, m.id, k, v_branch, null) order by k) as perms
          from public.memberships m
          join public.user_identities ui on ui.id = m.user_identity_id
          join public.staff_pos_override_credentials c on c.tenant_id = m.tenant_id and c.membership_id = m.id
         where m.tenant_id = p_tenant and m.status = 'active' and ui.login_username is not null
           and c.cleared_at is null and c.verifier_algorithm = 'scrypt-hmac-sha256-v2'
      ) q
     where cardinality(q.perms) > 0
     order by q.id;
end $f$;

alter function staff_private.set_pos_override_password_v2(uuid, uuid, text, text, text, integer, integer, integer, integer, integer) owner to staff_writer;
alter function staff_private.clear_pos_override_password(uuid, uuid, text, uuid) owner to staff_writer;
alter function staff_private.pos_override_roster(uuid, uuid) owner to staff_writer;
revoke create on schema staff_private from staff_writer;
revoke all on function staff_private.set_pos_override_password_v2(uuid, uuid, text, text, text, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function staff_private.clear_pos_override_password(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function staff_private.pos_override_roster(uuid, uuid) from public, anon, authenticated;

do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      staff_private.set_pos_override_password_v2(uuid, uuid, text, text, text, integer, integer, integer, integer, integer),
      staff_private.clear_pos_override_password(uuid, uuid, text, uuid),
      staff_private.pos_override_roster(uuid, uuid)
    to service_role;
  end if;
end $b$;
