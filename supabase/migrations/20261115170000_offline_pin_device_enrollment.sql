-- OFFLINE PIN v2 — RETIRE THE KEK-SEALED PIN MODEL, DEVICE-LOCAL RE-ENROLLMENT (2026-11-15).
-- Forward-only and additive. Nothing applied earlier is edited.
--
-- Why: the v1 model (20261024120000) stores every offline-unlock PIN encrypted (AES-256-GCM) under the server
-- KEK (OFFLINE_PIN_KEK) so the API can decrypt it at every bootstrap and mint a device-bound verifier. Anyone
-- holding the KEK and a database dump can recover every PIN. A local-development KEK value was exposed in a
-- transcript, so that material is treated as compromised. The old blobs are NOT decrypted and re-encrypted.
--
-- Part A  Retire v1: every KEK-sealed row is marked retired and its ciphertext/IV/tag are erased (no recoverable
--         PIN material remains). The v1 writer (set_offline_pin) and reader (offline_sell_roster) lose service_role
--         execute, so no new sealed PIN can be written and none can be read for minting.
-- Part B  v2 device enrollment: after a FRESH online (Clerk) authentication, a staff member enrols THEMSELVES on
--         one registered device. The PIN never leaves that device's trusted main process; the server stores NO
--         PIN-derived material at all — only (membership, device, register, verifier_version) and revocation.
--         Each online bootstrap re-authorises the device's active enrollments for currently-authorised sellers;
--         offline use therefore ends no later than the lease when an enrollment, membership or permission is
--         revoked. A superseded or revoked version is never re-authorised.
-- The connected pos_pin login (staff_pos_pin_credentials, one-way scrypt) and the override password (v2 one-way
-- verifier) do NOT depend on the KEK and are untouched.

-- =========================================================================================================
-- Part A — retire the KEK-sealed model
-- =========================================================================================================
alter table public.staff_offline_pin_credentials
  add column retired_at timestamptz,
  add column retired_reason text,
  alter column ciphertext_base64 drop not null,
  alter column iv_base64 drop not null,
  alter column auth_tag_base64 drop not null;
update public.staff_offline_pin_credentials
   set retired_at = now(), retired_reason = 'kek_sealed_model_retired',
       ciphertext_base64 = null, iv_base64 = null, auth_tag_base64 = null
 where retired_at is null;
alter table public.staff_offline_pin_credentials add constraint staff_offline_pin_credentials_retired
  check (retired_at is not null and ciphertext_base64 is null and iv_base64 is null and auth_tag_base64 is null);
comment on table public.staff_offline_pin_credentials is
  'RETIRED (20261115170000): KEK-sealed offline PINs. Every row is retired with its ciphertext erased; nothing writes or reads PIN material here. Superseded by staff_offline_pin_enrollments (device-local verifiers).';

do $revoke$
declare v_role text;
begin
  foreach v_role in array array['service_role', 'authenticated', 'anon'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      execute pg_catalog.format('revoke execute on function staff_private.set_offline_pin(uuid,uuid,text,uuid,integer,text,text,text,text,integer,integer,integer,integer,integer) from %I', v_role);
      execute pg_catalog.format('revoke execute on function staff_private.offline_sell_roster(uuid,uuid) from %I', v_role);
    end if;
  end loop;
end
$revoke$;

-- The v1 writer/reader now refuse explicitly (ST410) for ANY caller, instead of failing on the constraint.
create or replace function staff_private.set_offline_pin(
  p_tenant uuid, p_actor uuid, p_key text, p_membership uuid,
  p_key_version integer, p_cipher_algorithm text, p_ciphertext text, p_iv text, p_auth_tag text,
  p_scrypt_n integer, p_scrypt_r integer, p_scrypt_p integer, p_key_length integer, p_salt_length integer
) returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  raise exception using errcode = 'ST410',
    message = 'KEK-sealed offline PINs are retired; staff enrol their own offline PIN on the device (20261115170000)';
end;
$function$;
create or replace function staff_private.offline_sell_roster(p_tenant uuid, p_register uuid)
returns table(
  membership_id uuid, username text, display_name text,
  key_version integer, cipher_algorithm text, ciphertext_base64 text, iv_base64 text, auth_tag_base64 text,
  scrypt_n integer, scrypt_r integer, scrypt_p integer, key_length integer, salt_length integer
) language plpgsql stable security definer set search_path = '' as $function$
begin
  raise exception using errcode = 'ST410',
    message = 'the KEK-sealed offline PIN roster is retired (20261115170000)';
end;
$function$;

-- =========================================================================================================
-- Part B — device-local enrollment records (no PIN material)
-- =========================================================================================================
create table public.staff_offline_pin_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  membership_id uuid not null,
  device_id uuid not null,
  register_id uuid not null,
  verifier_version integer not null,
  idempotency_key text not null,
  enrolled_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text,
  constraint staff_offline_pin_enrollments_membership_fk foreign key (tenant_id, membership_id)
    references public.memberships (tenant_id, id) on delete restrict,
  constraint staff_offline_pin_enrollments_device_fk foreign key (tenant_id, device_id)
    references public.devices (tenant_id, id) on delete restrict,
  constraint staff_offline_pin_enrollments_version check (verifier_version >= 1),
  constraint staff_offline_pin_enrollments_revocation check ((revoked_at is null) = (revoked_reason is null)),
  constraint staff_offline_pin_enrollments_reason check (revoked_reason is null or revoked_reason ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint staff_offline_pin_enrollments_key check (btrim(idempotency_key) <> ''),
  constraint staff_offline_pin_enrollments_key_unique unique (tenant_id, idempotency_key),
  constraint staff_offline_pin_enrollments_version_unique unique (tenant_id, membership_id, device_id, verifier_version),
  constraint staff_offline_pin_enrollments_tenant_id_unique unique (tenant_id, id)
);
create unique index staff_offline_pin_enrollments_one_active
  on public.staff_offline_pin_enrollments (tenant_id, membership_id, device_id) where revoked_at is null;
create index staff_offline_pin_enrollments_device_idx
  on public.staff_offline_pin_enrollments (tenant_id, device_id) where revoked_at is null;
comment on table public.staff_offline_pin_enrollments is
  'Offline PIN v2: which staff member enrolled an offline-unlock PIN on which device (version, revocation). Holds NO PIN-derived material: the verifier exists only in that device''s OS-protected store.';
alter table public.staff_offline_pin_enrollments enable row level security;
revoke all on public.staff_offline_pin_enrollments from public;

-- Only revocation may change a row, once.
create function offline_pos_private.guard_offline_pin_enrollment()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'offline PIN enrollments are retained';
  end if;
  if old.revoked_at is not null
     or (new.id, new.tenant_id, new.membership_id, new.device_id, new.register_id, new.verifier_version,
         new.idempotency_key, new.enrolled_at)
        is distinct from
        (old.id, old.tenant_id, old.membership_id, old.device_id, old.register_id, old.verifier_version,
         old.idempotency_key, old.enrolled_at) then
    raise exception using errcode = 'P0001', message = 'an offline PIN enrollment may only be revoked once';
  end if;
  return new;
end;
$function$;
revoke all on function offline_pos_private.guard_offline_pin_enrollment() from public;
create trigger staff_offline_pin_enrollments_guard before update or delete on public.staff_offline_pin_enrollments
  for each row execute function offline_pos_private.guard_offline_pin_enrollment();

-- Is this membership an authorised offline seller at this register right now? (Same rule as the v1 roster.)
create function offline_pos_private.is_offline_seller(p_tenant uuid, p_membership uuid, p_register uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $function$
declare v_branch uuid; v_location uuid;
begin
  select r.branch_id, r.default_inventory_location_id into v_branch, v_location
    from public.registers r where r.tenant_id = p_tenant and r.id = p_register and r.status = 'active';
  if not found then return false; end if;
  return exists (
    select 1 from public.memberships m
      join public.user_identities ui on ui.id = m.user_identity_id
     where m.tenant_id = p_tenant and m.id = p_membership and m.status = 'active'
       and ui.login_username is not null
       and staff_private.covers_permission(p_tenant, m.id, 'orders.create', v_branch, null)
       and staff_private.covers_permission(p_tenant, m.id, 'orders.fulfill', v_branch, null)
       and staff_private.covers_permission(p_tenant, m.id, 'orders.read', v_branch, null)
       and staff_private.covers_permission(p_tenant, m.id, 'payments.capture', v_branch, null)
       and staff_private.covers_permission(p_tenant, m.id, 'inventory.issue', null, v_location));
end;
$function$;

-- Enrol the CALLER on one active device assigned to the register. Supersedes their previous active
-- enrollment on that device (new version). Idempotent per key; a key reused for another subject is refused.
create function offline_pos_private.enroll_offline_pin(
  p_tenant uuid, p_membership uuid, p_device uuid, p_register uuid, p_idempotency_key text
) returns table(enrollment_id uuid, verifier_version integer, enrolled_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare v_existing public.staff_offline_pin_enrollments%rowtype; v_version integer; v_row public.staff_offline_pin_enrollments%rowtype;
begin
  select * into v_existing from public.staff_offline_pin_enrollments e
   where e.tenant_id = p_tenant and e.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.membership_id <> p_membership or v_existing.device_id <> p_device
       or v_existing.register_id <> p_register then
      raise exception using errcode = 'ID409', message = 'idempotency key reused for another enrollment';
    end if;
    return query select v_existing.id, v_existing.verifier_version, v_existing.enrolled_at; return;
  end if;
  perform 1 from public.devices d where d.tenant_id = p_tenant and d.id = p_device and d.status = 'active';
  if not found then raise exception using errcode = 'OD410', message = 'device not active'; end if;
  perform 1 from public.register_device_assignments a
   where a.tenant_id = p_tenant and a.device_id = p_device and a.register_id = p_register and a.unassigned_at is null;
  if not found then raise exception using errcode = 'OG403', message = 'device not assigned to register'; end if;
  if not offline_pos_private.is_offline_seller(p_tenant, p_membership, p_register) then
    raise exception using errcode = 'ST403', message = 'not an offline seller at this register';
  end if;
  -- Serialise per (membership, device).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant::text || p_membership::text || p_device::text, 0));
  update public.staff_offline_pin_enrollments e set revoked_at = now(), revoked_reason = 'superseded'
   where e.tenant_id = p_tenant and e.membership_id = p_membership and e.device_id = p_device and e.revoked_at is null;
  select coalesce(max(e.verifier_version), 0) + 1 into v_version from public.staff_offline_pin_enrollments e
   where e.tenant_id = p_tenant and e.membership_id = p_membership and e.device_id = p_device;
  insert into public.staff_offline_pin_enrollments (tenant_id, membership_id, device_id, register_id,
    verifier_version, idempotency_key)
  values (p_tenant, p_membership, p_device, p_register, v_version, p_idempotency_key)
  returning * into v_row;
  return query select v_row.id, v_row.verifier_version, v_row.enrolled_at;
end;
$function$;

-- Revoke active enrollments (lost device, forgotten PIN, removed user). Either filter may be null (all).
create function offline_pos_private.revoke_offline_pin_enrollments(
  p_tenant uuid, p_membership uuid, p_device uuid, p_reason text
) returns integer language plpgsql security definer set search_path = '' as $function$
declare v_count integer;
begin
  update public.staff_offline_pin_enrollments e set revoked_at = now(), revoked_reason = p_reason
   where e.tenant_id = p_tenant and e.revoked_at is null
     and (p_membership is null or e.membership_id = p_membership)
     and (p_device is null or e.device_id = p_device);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- Bootstrap: the device's active enrollments for sellers authorised at this register NOW.
create function offline_pos_private.offline_pin_authorizations(p_tenant uuid, p_register uuid, p_device uuid)
returns table(membership_id uuid, username text, display_name text, enrollment_id uuid, verifier_version integer)
language sql stable security definer set search_path = '' as $function$
  select e.membership_id, ui.login_username, ui.display_name, e.id, e.verifier_version
    from public.staff_offline_pin_enrollments e
    join public.memberships m on m.tenant_id = e.tenant_id and m.id = e.membership_id
    join public.user_identities ui on ui.id = m.user_identity_id
   where e.tenant_id = p_tenant and e.device_id = p_device and e.revoked_at is null
     and offline_pos_private.is_offline_seller(p_tenant, e.membership_id, p_register)
   order by e.membership_id;
$function$;

revoke all on function
  offline_pos_private.is_offline_seller(uuid, uuid, uuid),
  offline_pos_private.enroll_offline_pin(uuid, uuid, uuid, uuid, text),
  offline_pos_private.revoke_offline_pin_enrollments(uuid, uuid, uuid, text),
  offline_pos_private.offline_pin_authorizations(uuid, uuid, uuid)
from public;
do $grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function
      offline_pos_private.enroll_offline_pin(uuid, uuid, uuid, uuid, text),
      offline_pos_private.revoke_offline_pin_enrollments(uuid, uuid, uuid, text),
      offline_pos_private.offline_pin_authorizations(uuid, uuid, uuid)
    to service_role;
  end if;
end
$grants$;
