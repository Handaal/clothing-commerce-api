-- Phase 2O-C: offline-PIN credential store for the POS offline cashier unlock.
--
-- Clerk owns the ONLINE password/PIN and will not disclose its hash, so offline unlock needs a SEPARATE,
-- independently-settable credential held server-side. The POS offline cashier verifies a till PIN locally
-- (no connection) against a per-user verifier carried in the device's offline bootstrap. The verifier is
-- DEVICE-BOUND: the POS computes scrypt(pin, saltBytes || utf8(deviceId), ...). Because the device id is
-- folded INSIDE the one-way KDF and is only known at bootstrap time, the server cannot precompute the
-- verifier at set-time and cannot derive it from a one-way hash either. The only design that emits the
-- contract verifier WITHOUT storing plaintext is reversible encryption at rest: the PIN is sealed with
-- AES-256-GCM under a server-held key (OFFLINE_PIN_KEK, same trust tier as the service-role/Clerk secret),
-- and the bootstrap transiently decrypts it in the API process to compute the device-bound scrypt verifier.
-- A database dump alone therefore yields only ciphertext.
--
-- Authorization mirrors feat/staff-pin-login exactly: the transport requires tenant-wide `staff.manage`
-- and the RPC applies the SAME anti-escalation subset check used by `create_staff_login`/`assign_role` —
-- an actor may only set/rotate an offline PIN for a staff member whose held permissions are a subset of the
-- actor's own. Both RPCs live in `staff_private` because setting the credential and selecting the authorized
-- sellers are RBAC/identity concerns; `staff_writer` already reads every RBAC + identity table they touch.
--
-- Phase-1 scope: this is GATE-ONLY. It does not change offline sale attribution — offline sales stay
-- attributed to the grant's operator_membership_id. The roster only unlocks the local cashier UI.

create table public.staff_offline_pin_credentials (
  tenant_id uuid not null,
  membership_id uuid not null,
  -- Envelope: AES-256-GCM ciphertext of the PIN + its random IV and auth tag, plus the KEK version that
  -- sealed it (so a future key rotation can re-seal lazily without a schema change).
  key_version integer not null,
  cipher_algorithm text not null,
  ciphertext_base64 text not null,
  iv_base64 text not null,
  auth_tag_base64 text not null,
  -- scrypt cost parameters the bootstrap must emit so the POS verifier matches byte-for-byte. Stored per
  -- credential so a server-side policy change never breaks already-provisioned devices mid-flight.
  kdf_algorithm text not null,
  scrypt_n integer not null,
  scrypt_r integer not null,
  scrypt_p integer not null,
  key_length integer not null,
  salt_length integer not null,
  set_by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_offline_pin_credentials_pk primary key (tenant_id, membership_id),
  constraint staff_offline_pin_credentials_membership_fk
    foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id) on delete cascade,
  constraint staff_offline_pin_credentials_set_by_fk
    foreign key (tenant_id, set_by_membership_id) references public.memberships (tenant_id, id) on delete restrict,
  constraint staff_offline_pin_credentials_cipher_valid check (cipher_algorithm = 'aes-256-gcm'),
  constraint staff_offline_pin_credentials_kdf_valid check (kdf_algorithm = 'scrypt'),
  constraint staff_offline_pin_credentials_key_version_positive check (key_version >= 1),
  constraint staff_offline_pin_credentials_scrypt_positive
    check (scrypt_n >= 2 and scrypt_r >= 1 and scrypt_p >= 1),
  -- The POS verifier contract requires keyLength >= 16 and a salt of >= 16 bytes.
  constraint staff_offline_pin_credentials_key_length_min check (key_length >= 16),
  constraint staff_offline_pin_credentials_salt_length_min check (salt_length >= 16),
  constraint staff_offline_pin_credentials_updated_after_created check (updated_at >= created_at)
);

comment on table public.staff_offline_pin_credentials is
  'Reversibly-encrypted (AES-256-GCM, server KEK) offline-unlock PIN per staff membership; the API decrypts it transiently at bootstrap to emit a device-bound scrypt verifier. Never stores plaintext.';

-- ---- staff_writer DML + RLS on the new table -----------------------------------------------------------
-- Set + rotate are an upsert; there is no destructive delete path (a credential is live state, and the
-- writer is never granted DELETE anywhere in the staff domain).
grant select, insert, update on public.staff_offline_pin_credentials to staff_writer;
create policy staff_writer_offline_pin_write on public.staff_offline_pin_credentials
  for all to staff_writer using (true) with check (true);

-- The roster RPC resolves the register's branch + inventory location to decide who may sell there.
grant select on public.registers to staff_writer;
create policy staff_writer_registers_read on public.registers for select to staff_writer using (true);

-- True when `p_membership` holds `p_key` via an active assignment whose scope covers the given branch OR
-- inventory location. This mirrors AuthorizationService.assignmentCovers exactly: a tenant-mode scope
-- covers everything, otherwise an explicit scope must carry a matching branch/inventory_location target.
create function staff_private.covers_permission(
  p_tenant uuid, p_membership uuid, p_key text, p_branch uuid, p_location uuid
) returns boolean language sql stable security definer set search_path='' as $f$
  select exists(
    select 1
    from public.membership_role_assignments a
    join public.roles r on r.tenant_id=a.tenant_id and r.id=a.role_id and r.status='active'
    join public.access_scopes sc on sc.tenant_id=a.tenant_id and sc.id=a.access_scope_id and sc.status='active'
    join public.role_permissions rp on rp.tenant_id=a.tenant_id and rp.role_id=a.role_id
    join public.permissions p on p.id=rp.permission_id and p.status='active' and p.key=p_key
    where a.tenant_id=p_tenant and a.membership_id=p_membership
      and a.unassigned_at is null and a.assigned_at<=now()
      and (sc.scope_mode='tenant'
        or exists(select 1 from public.access_scope_targets t
             where t.tenant_id=a.tenant_id and t.access_scope_id=sc.id
               and ((p_branch is not null and t.branch_id=p_branch)
                 or (p_location is not null and t.inventory_location_id=p_location))))
  )
$f$;

-- Set or rotate a staff member's offline PIN. Idempotent on (tenant, key): a genuine retry replays the
-- stored response WITHOUT rewriting. The volatile ciphertext/iv are deliberately NOT part of the ledger
-- intent (a retry carries a fresh IV; and the ledger must never hold PIN-derived material), so the intent
-- is purely {op, actor, membership}. Anti-escalation mirrors assign_role: the target's held permission
-- keys must be a subset of the actor's own tenant-wide keys.
create function staff_private.set_offline_pin(
  p_tenant uuid, p_actor uuid, p_key text, p_membership uuid,
  p_key_version integer, p_cipher_algorithm text, p_ciphertext text, p_iv text, p_auth_tag text,
  p_scrypt_n integer, p_scrypt_r integer, p_scrypt_p integer, p_key_length integer, p_salt_length integer
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare
  v_intent jsonb; v_replay jsonb; v_status text; v_caller text[]; v_missing text[]; v_updated timestamptz; v_response jsonb;
begin
  if p_tenant is null or p_actor is null or p_membership is null
    or p_ciphertext is null or p_iv is null or p_auth_tag is null then
    raise exception using errcode='22023', message='Invalid set-offline-pin command'; end if;

  v_intent := jsonb_build_object('op','set_offline_pin','actor',p_actor,'membership',p_membership);
  v_replay := staff_private.begin_command(p_tenant,p_key,v_intent);
  if v_replay is not null then return v_replay; end if;

  -- The target must be a real, active membership in this tenant.
  select m.status into v_status from public.memberships m where m.tenant_id=p_tenant and m.id=p_membership;
  if not found then raise exception using errcode='ST404', message='Staff member not found'; end if;
  if v_status<>'active' then raise exception using errcode='ST409', message='Staff member is not active'; end if;

  -- Anti-escalation: an actor may only credential a staff member whose held permissions it already holds.
  v_caller := staff_private.tenant_permission_keys(p_tenant,p_actor);
  select coalesce(array_agg(distinct p.key),'{}') into v_missing
   from public.membership_role_assignments a
   join public.roles r on r.tenant_id=a.tenant_id and r.id=a.role_id and r.status='active'
   join public.role_permissions rp on rp.tenant_id=a.tenant_id and rp.role_id=a.role_id
   join public.permissions p on p.id=rp.permission_id and p.status='active'
   where a.tenant_id=p_tenant and a.membership_id=p_membership and a.unassigned_at is null
     and not (p.key = any(v_caller));
  if array_length(v_missing,1) is not null then
    raise exception using errcode='ST403', message='Setting this PIN would grant offline access to permissions the caller does not hold'; end if;

  insert into public.staff_offline_pin_credentials(
    tenant_id,membership_id,key_version,cipher_algorithm,ciphertext_base64,iv_base64,auth_tag_base64,
    kdf_algorithm,scrypt_n,scrypt_r,scrypt_p,key_length,salt_length,set_by_membership_id)
  values(p_tenant,p_membership,p_key_version,p_cipher_algorithm,p_ciphertext,p_iv,p_auth_tag,
    'scrypt',p_scrypt_n,p_scrypt_r,p_scrypt_p,p_key_length,p_salt_length,p_actor)
  on conflict (tenant_id,membership_id) do update set
    key_version=excluded.key_version,cipher_algorithm=excluded.cipher_algorithm,
    ciphertext_base64=excluded.ciphertext_base64,iv_base64=excluded.iv_base64,auth_tag_base64=excluded.auth_tag_base64,
    kdf_algorithm=excluded.kdf_algorithm,scrypt_n=excluded.scrypt_n,scrypt_r=excluded.scrypt_r,
    scrypt_p=excluded.scrypt_p,key_length=excluded.key_length,salt_length=excluded.salt_length,
    set_by_membership_id=excluded.set_by_membership_id,updated_at=now()
  returning updated_at into v_updated;

  v_response := jsonb_build_object('membershipId',p_membership,'keyVersion',p_key_version,'updatedAt',v_updated);
  return staff_private.finish_command(p_tenant,p_key,v_intent,v_response);
end $f$;

-- Authorized-seller roster for a register's offline bootstrap: every ACTIVE staff member who (a) has a
-- login username, (b) has an offline PIN credential, and (c) could themselves act as a valid offline
-- operator on this register — i.e. holds the full POS selling permission set scoped to the register's
-- branch (orders.create/fulfill/read, payments.capture) and inventory.issue scoped to its location. The
-- row carries the SEALED PIN material + KDF params; the API decrypts and derives the device-bound verifier.
create function staff_private.offline_sell_roster(p_tenant uuid, p_register uuid)
returns table(
  membership_id uuid, username text, display_name text,
  key_version integer, cipher_algorithm text, ciphertext_base64 text, iv_base64 text, auth_tag_base64 text,
  scrypt_n integer, scrypt_r integer, scrypt_p integer, key_length integer, salt_length integer
) language plpgsql stable security definer set search_path='' as $f$
declare v_branch uuid; v_location uuid;
begin
  select branch_id, default_inventory_location_id into v_branch, v_location
   from public.registers where tenant_id=p_tenant and id=p_register and status='active';
  if not found then raise exception using errcode='ST404', message='register not found'; end if;

  return query
   select m.id, ui.login_username, ui.display_name,
     c.key_version, c.cipher_algorithm, c.ciphertext_base64, c.iv_base64, c.auth_tag_base64,
     c.scrypt_n, c.scrypt_r, c.scrypt_p, c.key_length, c.salt_length
   from public.memberships m
   join public.user_identities ui on ui.id=m.user_identity_id
   join public.staff_offline_pin_credentials c on c.tenant_id=m.tenant_id and c.membership_id=m.id
   where m.tenant_id=p_tenant and m.status='active' and ui.login_username is not null
     and staff_private.covers_permission(p_tenant,m.id,'orders.create',v_branch,null)
     and staff_private.covers_permission(p_tenant,m.id,'orders.fulfill',v_branch,null)
     and staff_private.covers_permission(p_tenant,m.id,'orders.read',v_branch,null)
     and staff_private.covers_permission(p_tenant,m.id,'payments.capture',v_branch,null)
     and staff_private.covers_permission(p_tenant,m.id,'inventory.issue',null,v_location)
   order by m.id;
end $f$;

-- Ownership + execution grants (same pattern as the rest of the staff domain).
grant create on schema staff_private to staff_writer;
alter function staff_private.covers_permission(uuid,uuid,text,uuid,uuid) owner to staff_writer;
alter function staff_private.set_offline_pin(uuid,uuid,text,uuid,integer,text,text,text,text,integer,integer,integer,integer,integer) owner to staff_writer;
alter function staff_private.offline_sell_roster(uuid,uuid) owner to staff_writer;
revoke create on schema staff_private from staff_writer;

revoke all on function staff_private.covers_permission(uuid,uuid,text,uuid,uuid) from public, anon, authenticated;
revoke all on function staff_private.set_offline_pin(uuid,uuid,text,uuid,integer,text,text,text,text,integer,integer,integer,integer,integer) from public, anon, authenticated;
revoke all on function staff_private.offline_sell_roster(uuid,uuid) from public, anon, authenticated;
grant execute on function
  staff_private.set_offline_pin(uuid,uuid,text,uuid,integer,text,text,text,text,integer,integer,integer,integer,integer),
  staff_private.offline_sell_roster(uuid,uuid)
  to service_role;

alter table public.staff_offline_pin_credentials enable row level security;
revoke all on table public.staff_offline_pin_credentials from public;
do $block$
begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='service_role') then
  execute 'grant select on public.staff_offline_pin_credentials to service_role';
 end if;
end;
$block$;
