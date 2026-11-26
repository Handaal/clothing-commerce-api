-- ADR-042 §6.2–6.3 (owner D-3, D-6) — SEPARATE POS OVERRIDE PASSWORD + ONE-USE ADMIN ASSERTIONS.
--
-- A qualifying admin (holds promotions.manage or payments.refund) sets a POS override password online.
-- It is not the sign-in PIN and not the Clerk password. Storage mirrors staff_offline_pin_credentials: an
-- AES-256-GCM envelope under the server KEK, used only to mint DEVICE-BOUND scrypt verifiers at bootstrap.
-- No plaintext is ever stored. Setting or clearing bumps verifier_version, so the next bootstrap replaces the
-- till's verifier.
--
-- At bootstrap the server records which (admin, permission, verifier_version) verifiers it issued to which
-- offline grant. When a till command carries an admin assertion, the server accepts it only if:
--   * it was issued to this offline grant (device + register + lease) for that admin, permission and version;
--   * it is bound to this exact command (commandId = syncCommandId) and the expected permission;
--   * its assertionId has never been used before (single use).
-- The assertion travels inside the device-signed command, so its integrity rests on the command signature.
-- There is no approval queue: an invalid assertion never waits for anyone, it is a deterministic outcome.

-- ---------------------------------------------------------------------------------------------------------
-- Credential store (staff domain)
-- ---------------------------------------------------------------------------------------------------------
create table public.staff_pos_override_credentials (
  tenant_id uuid not null,
  membership_id uuid not null,
  key_version integer,
  cipher_algorithm text,
  ciphertext_base64 text,
  iv_base64 text,
  auth_tag_base64 text,
  kdf_algorithm text not null default 'scrypt',
  scrypt_n integer not null,
  scrypt_r integer not null,
  scrypt_p integer not null,
  key_length integer not null,
  salt_length integer not null,
  verifier_version integer not null default 1,
  set_by_membership_id uuid not null,
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_pos_override_credentials_pk primary key (tenant_id, membership_id),
  constraint staff_pos_override_credentials_membership_fk
    foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id) on delete cascade,
  constraint staff_pos_override_credentials_set_by_fk
    foreign key (tenant_id, set_by_membership_id) references public.memberships (tenant_id, id) on delete restrict,
  -- Either a live sealed envelope, or cleared (no material at all).
  constraint staff_pos_override_credentials_state check (
    (cleared_at is null and key_version >= 1 and cipher_algorithm = 'aes-256-gcm' and ciphertext_base64 is not null
      and iv_base64 is not null and auth_tag_base64 is not null)
    or (cleared_at is not null and key_version is null and cipher_algorithm is null and ciphertext_base64 is null
      and iv_base64 is null and auth_tag_base64 is null)),
  constraint staff_pos_override_credentials_kdf check (kdf_algorithm = 'scrypt'),
  constraint staff_pos_override_credentials_scrypt check (scrypt_n >= 2 and scrypt_r >= 1 and scrypt_p >= 1
    and key_length >= 16 and salt_length >= 16),
  constraint staff_pos_override_credentials_version check (verifier_version >= 1)
);
comment on table public.staff_pos_override_credentials is
  'ADR-042 D-6: per-admin POS override password, AES-256-GCM sealed under the server KEK (never plaintext); used only to mint device-bound scrypt verifiers at offline bootstrap.';
alter table public.staff_pos_override_credentials enable row level security;
revoke all on public.staff_pos_override_credentials from public;
grant select, insert, update on public.staff_pos_override_credentials to staff_writer;
create policy staff_writer_pos_override_write on public.staff_pos_override_credentials
  for all to staff_writer using (true) with check (true);

-- The override permissions an admin can satisfy (ADR-042 §6.2).
create function staff_private.override_permission_keys()
returns text[] language sql immutable set search_path = '' as $f$
  select array['promotions.manage', 'payments.refund']::text[];
$f$;

-- True when the membership holds p_key through any active assignment, whatever its scope.
create function staff_private.holds_permission_anywhere(p_tenant uuid, p_membership uuid, p_key text)
returns boolean language sql stable security definer set search_path = '' as $f$
  select exists(
    select 1
      from public.membership_role_assignments a
      join public.roles r on r.tenant_id = a.tenant_id and r.id = a.role_id and r.status = 'active'
      join public.access_scopes sc on sc.tenant_id = a.tenant_id and sc.id = a.access_scope_id and sc.status = 'active'
      join public.role_permissions rp on rp.tenant_id = a.tenant_id and rp.role_id = a.role_id
      join public.permissions p on p.id = rp.permission_id and p.status = 'active' and p.key = p_key
     where a.tenant_id = p_tenant and a.membership_id = p_membership
       and a.unassigned_at is null and a.assigned_at <= now());
$f$;

-- Set or change MY OWN override password (self only). The caller already re-authenticated with their PIN
-- and the password policy was checked in the API (the only place plaintext exists, transiently).
create function staff_private.set_pos_override_password(
  p_tenant uuid, p_actor uuid, p_key text,
  p_key_version integer, p_cipher_algorithm text, p_ciphertext text, p_iv text, p_auth_tag text,
  p_scrypt_n integer, p_scrypt_r integer, p_scrypt_p integer, p_key_length integer, p_salt_length integer
) returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_status text; v_row public.staff_pos_override_credentials%rowtype; v_response jsonb;
begin
  if p_tenant is null or p_actor is null or p_ciphertext is null or p_iv is null or p_auth_tag is null then
    raise exception using errcode = '22023', message = 'Invalid set-override-password command';
  end if;
  v_intent := jsonb_build_object('op', 'set_pos_override_password', 'actor', p_actor);
  v_replay := staff_private.begin_command(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  select m.status into v_status from public.memberships m where m.tenant_id = p_tenant and m.id = p_actor;
  if not found then raise exception using errcode = 'ST404', message = 'Staff member not found'; end if;
  if v_status <> 'active' then raise exception using errcode = 'ST409', message = 'Staff member is not active'; end if;
  if not (staff_private.holds_permission_anywhere(p_tenant, p_actor, 'promotions.manage')
          or staff_private.holds_permission_anywhere(p_tenant, p_actor, 'payments.refund')) then
    raise exception using errcode = 'ST403', message = 'Only accounts that can approve vouchers or refunds can set an override password';
  end if;

  insert into public.staff_pos_override_credentials as c (
    tenant_id, membership_id, key_version, cipher_algorithm, ciphertext_base64, iv_base64, auth_tag_base64,
    scrypt_n, scrypt_r, scrypt_p, key_length, salt_length, set_by_membership_id)
  values (p_tenant, p_actor, p_key_version, p_cipher_algorithm, p_ciphertext, p_iv, p_auth_tag,
    p_scrypt_n, p_scrypt_r, p_scrypt_p, p_key_length, p_salt_length, p_actor)
  on conflict (tenant_id, membership_id) do update set
    key_version = excluded.key_version, cipher_algorithm = excluded.cipher_algorithm,
    ciphertext_base64 = excluded.ciphertext_base64, iv_base64 = excluded.iv_base64,
    auth_tag_base64 = excluded.auth_tag_base64, scrypt_n = excluded.scrypt_n, scrypt_r = excluded.scrypt_r,
    scrypt_p = excluded.scrypt_p, key_length = excluded.key_length, salt_length = excluded.salt_length,
    set_by_membership_id = excluded.set_by_membership_id, cleared_at = null,
    verifier_version = c.verifier_version + 1, updated_at = now()
  returning * into v_row;

  v_response := jsonb_build_object('membershipId', p_actor, 'verifierVersion', v_row.verifier_version,
                                   'updatedAt', v_row.updated_at);
  return staff_private.finish_command(p_tenant, p_key, v_intent, v_response);
end $f$;

-- Clear another account's override password (staff.manage is checked by the API). Never reads or sets it.
create function staff_private.clear_pos_override_password(p_tenant uuid, p_actor uuid, p_key text, p_membership uuid)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_row public.staff_pos_override_credentials%rowtype; v_response jsonb;
begin
  v_intent := jsonb_build_object('op', 'clear_pos_override_password', 'actor', p_actor, 'membership', p_membership);
  v_replay := staff_private.begin_command(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;
  update public.staff_pos_override_credentials c
     set key_version = null, cipher_algorithm = null, ciphertext_base64 = null, iv_base64 = null,
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

-- Qualifying admins for a register's bootstrap: active, with a username, a live override password, and at
-- least one override permission covering the register's branch (tenant scope or that branch). Returns the
-- SEALED material; the API decrypts transiently to derive the device-bound verifier.
create function staff_private.pos_override_roster(p_tenant uuid, p_register uuid)
returns table(
  membership_id uuid, username text, display_name text, permissions text[], verifier_version integer,
  key_version integer, cipher_algorithm text, ciphertext_base64 text, iv_base64 text, auth_tag_base64 text,
  scrypt_n integer, scrypt_r integer, scrypt_p integer, key_length integer, salt_length integer
) language plpgsql stable security definer set search_path = '' as $f$
declare v_branch uuid;
begin
  select r.branch_id into v_branch from public.registers r
   where r.tenant_id = p_tenant and r.id = p_register and r.status = 'active';
  if not found then raise exception using errcode = 'ST404', message = 'register not found'; end if;
  return query
    select q.id, q.login_username, q.display_name, q.perms, q.verifier_version,
           q.key_version, q.cipher_algorithm, q.ciphertext_base64, q.iv_base64, q.auth_tag_base64,
           q.scrypt_n, q.scrypt_r, q.scrypt_p, q.key_length, q.salt_length
      from (
        select m.id, ui.login_username, ui.display_name, c.*,
               array(select k from unnest(staff_private.override_permission_keys()) k
                      where staff_private.covers_permission(p_tenant, m.id, k, v_branch, null) order by k) as perms
          from public.memberships m
          join public.user_identities ui on ui.id = m.user_identity_id
          join public.staff_pos_override_credentials c on c.tenant_id = m.tenant_id and c.membership_id = m.id
         where m.tenant_id = p_tenant and m.status = 'active' and ui.login_username is not null
           and c.cleared_at is null
      ) q
     where cardinality(q.perms) > 0
     order by q.id;
end $f$;

-- ---------------------------------------------------------------------------------------------------------
-- Issuance record + one-use assertions (offline POS domain)
-- ---------------------------------------------------------------------------------------------------------
create table public.offline_pos_admin_verifier_issuances (
  tenant_id uuid not null,
  offline_grant_id uuid not null,
  membership_id uuid not null,
  permission text not null,
  verifier_version integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint offline_pos_admin_verifier_issuances_pk primary key (tenant_id, offline_grant_id, membership_id, permission),
  constraint offline_pos_admin_verifier_issuances_grant_fk foreign key (tenant_id, offline_grant_id)
    references public.offline_grants (tenant_id, id) on delete restrict,
  constraint offline_pos_admin_verifier_issuances_member_fk foreign key (tenant_id, membership_id)
    references public.memberships (tenant_id, id) on delete restrict,
  constraint offline_pos_admin_verifier_issuances_permission check (permission in ('promotions.manage', 'payments.refund')),
  constraint offline_pos_admin_verifier_issuances_version check (verifier_version >= 1)
);

create table public.offline_pos_admin_assertions (
  tenant_id uuid not null,
  assertion_id uuid not null,
  offline_grant_id uuid not null,
  sync_command_id uuid not null,
  membership_id uuid not null,
  permission text not null,
  created_at timestamptz not null default now(),
  constraint offline_pos_admin_assertions_pk primary key (tenant_id, assertion_id),
  constraint offline_pos_admin_assertions_permission check (permission in ('promotions.manage', 'payments.refund'))
);

alter table public.offline_pos_admin_verifier_issuances enable row level security;
alter table public.offline_pos_admin_assertions enable row level security;
revoke all on public.offline_pos_admin_verifier_issuances, public.offline_pos_admin_assertions from public;

-- Bootstrap: record the verifiers the API minted for this offline grant. Idempotent.
create function offline_pos_private.record_admin_verifier_issuances(p_tenant_id uuid, p_offline_grant_id uuid, p_entries jsonb)
returns integer language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_grants%rowtype; v_count integer;
begin
  select * into v_grant from public.offline_grants g where g.tenant_id = p_tenant_id and g.id = p_offline_grant_id;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;
  insert into public.offline_pos_admin_verifier_issuances
    (tenant_id, offline_grant_id, membership_id, permission, verifier_version, expires_at)
  select p_tenant_id, p_offline_grant_id, (e->>'membershipId')::uuid, e->>'permission',
         (e->>'verifierVersion')::integer, v_grant.accepted_until
    from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) e
  on conflict (tenant_id, offline_grant_id, membership_id, permission) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- Ingestion: validate and consume one admin assertion for a command. Returns null when accepted, otherwise
-- a deterministic code. Never raises for a bad assertion (the caller decides the business outcome).
create function offline_pos_private.consume_admin_assertion(
  p_tenant_id uuid, p_offline_grant_id uuid, p_sync_command_id uuid, p_assertion jsonb, p_permission text
) returns text language plpgsql security definer set search_path = '' as $function$
declare v_member uuid; v_version integer; v_assertion uuid;
begin
  if p_assertion is null or jsonb_typeof(p_assertion) <> 'object' then
    return 'CREDENTIAL_MISSING';
  end if;
  begin
    v_member := (p_assertion->>'adminMembershipId')::uuid;
    v_version := (p_assertion->>'verifierVersion')::integer;
    v_assertion := (p_assertion->>'assertionId')::uuid;
  exception when others then
    return 'CREDENTIAL_INVALID';
  end;
  if v_member is null or v_version is null or v_assertion is null
     or p_assertion->>'permission' is distinct from p_permission
     or (p_assertion->>'commandId')::uuid is distinct from p_sync_command_id then
    return 'CREDENTIAL_INVALID';
  end if;
  perform 1 from public.offline_pos_admin_verifier_issuances i
   where i.tenant_id = p_tenant_id and i.offline_grant_id = p_offline_grant_id and i.membership_id = v_member
     and i.permission = p_permission and i.verifier_version = v_version;
  if not found then
    return 'CREDENTIAL_NOT_ISSUED';
  end if;
  begin
    insert into public.offline_pos_admin_assertions
      (tenant_id, assertion_id, offline_grant_id, sync_command_id, membership_id, permission)
    values (p_tenant_id, v_assertion, p_offline_grant_id, p_sync_command_id, v_member, p_permission);
  exception when unique_violation then
    return 'CREDENTIAL_REUSED';
  end;
  return null;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Ownership + grants
-- ---------------------------------------------------------------------------------------------------------
grant create on schema staff_private to staff_writer;
alter function staff_private.override_permission_keys() owner to staff_writer;
alter function staff_private.holds_permission_anywhere(uuid, uuid, text) owner to staff_writer;
alter function staff_private.set_pos_override_password(uuid, uuid, text, integer, text, text, text, text, integer, integer, integer, integer, integer) owner to staff_writer;
alter function staff_private.clear_pos_override_password(uuid, uuid, text, uuid) owner to staff_writer;
alter function staff_private.pos_override_roster(uuid, uuid) owner to staff_writer;
revoke create on schema staff_private from staff_writer;
revoke all on function staff_private.override_permission_keys() from public, anon, authenticated;
revoke all on function staff_private.holds_permission_anywhere(uuid, uuid, text) from public, anon, authenticated;
revoke all on function staff_private.set_pos_override_password(uuid, uuid, text, integer, text, text, text, text, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function staff_private.clear_pos_override_password(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function staff_private.pos_override_roster(uuid, uuid) from public, anon, authenticated;

grant create on schema public, offline_pos_private to offline_pos_writer;
alter table public.offline_pos_admin_verifier_issuances owner to offline_pos_writer;
alter table public.offline_pos_admin_assertions owner to offline_pos_writer;
alter function offline_pos_private.record_admin_verifier_issuances(uuid, uuid, jsonb) owner to offline_pos_writer;
alter function offline_pos_private.consume_admin_assertion(uuid, uuid, uuid, jsonb, text) owner to offline_pos_writer;
revoke create on schema public, offline_pos_private from offline_pos_writer;
revoke all on function offline_pos_private.record_admin_verifier_issuances(uuid, uuid, jsonb) from public;
revoke all on function offline_pos_private.consume_admin_assertion(uuid, uuid, uuid, jsonb, text) from public;

do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      staff_private.set_pos_override_password(uuid, uuid, text, integer, text, text, text, text, integer, integer, integer, integer, integer),
      staff_private.clear_pos_override_password(uuid, uuid, text, uuid),
      staff_private.pos_override_roster(uuid, uuid),
      offline_pos_private.record_admin_verifier_issuances(uuid, uuid, jsonb)
    to service_role;
    grant select on public.offline_pos_admin_verifier_issuances, public.offline_pos_admin_assertions to service_role;
  end if;
end $b$;

-- ---------------------------------------------------------------------------------------------------------
-- Production lease guard (owner D-5): operator lease <= 24 h and catalog window <= operator lease, for every
-- policy row written from now on. Existing rows are left as they are (NOT VALID) so nothing deployed breaks;
-- validate after the dev/prod rows are brought within bounds.
-- ---------------------------------------------------------------------------------------------------------
alter table public.offline_pos_policies
  add constraint offline_pos_policies_lease_bounds
  check (operator_lease_seconds <= 86400 and catalog_grant_seconds <= operator_lease_seconds) not valid;
