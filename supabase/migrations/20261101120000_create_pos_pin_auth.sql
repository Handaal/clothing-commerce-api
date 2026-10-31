-- ADR-040 Phase 1: POS-native (`pos_pin`) authentication provider.
--
-- The POS floor signs in with a short username + numeric PIN. Clerk's sign-in password policy floor (8,
-- this instance 15) is fundamentally incompatible with a 4-digit PIN, so the POS gets its OWN
-- authentication provider against the SAME database and the SAME authorization model. This is a new
-- *authentication* provider only: a provider binding `(provider='pos_pin', provider_subject=<server-minted>)`
-- reusing the existing context-resolver binding -> identity -> membership -> RBAC path. No new authorization
-- model; a tenant header / role name / service_role remains non-authoritative, exactly as before.
--
-- Three pieces live here:
--   1. staff_pos_pin_credentials — the NON-device-bound ONLINE scrypt verifier the connected login checks
--      against (constant-time, never unseals the KEK-sealed offline copy), plus the cafe-style POS UI
--      access the admin assigns (pos_role + pos_permissions). API authorization is still governed by the
--      membership's RBAC role/scope; pos_role/pos_permissions only shape the POS sidebar.
--   2. pos_login_attempts — a DURABLE per-username throttle (5 failures -> 30s lockout) so a server restart
--      is not a brute-force bypass, matching the offline roster constants.
--   3. RPCs: create_pos_login (provision), pos_login_begin + pos_login_record (the public login path), and
--      list/update/set_pin management RPCs for the admin "Team" surface.
--
-- Provisioning authorization mirrors create_staff_login exactly: tenant-wide `staff.manage` at the
-- transport plus the same anti-escalation subset check. The provider subject is SERVER-minted and never
-- client-supplied. The login path (begin/record) is pre-tenant and pre-auth by nature — the username is
-- instance-global-unique — so those two RPCs are global and executed only via service_role.

-- ---- Online verifier + POS UI access -------------------------------------------------------------------
create table public.staff_pos_pin_credentials (
  tenant_id uuid not null,
  membership_id uuid not null,
  -- Non-device-bound scrypt verifier: scrypt(pin, saltBytes, keyLength, {N,r,p}). Stored per credential so
  -- a server-side cost-parameter change never breaks already-provisioned accounts.
  salt_base64 text not null,
  hash_base64 text not null,
  scrypt_n integer not null,
  scrypt_r integer not null,
  scrypt_p integer not null,
  key_length integer not null,
  -- Cafe-style POS UI access the admin assigns. pos_role gates admin-only POS screens; pos_permissions is
  -- the set of section ids a cashier may open. These never grant API access (RBAC does) — UI shape only.
  pos_role text not null,
  pos_permissions text[] not null default '{}',
  set_by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_pos_pin_credentials_pk primary key (tenant_id, membership_id),
  constraint staff_pos_pin_credentials_membership_fk
    foreign key (tenant_id, membership_id) references public.memberships (tenant_id, id) on delete cascade,
  constraint staff_pos_pin_credentials_set_by_fk
    foreign key (tenant_id, set_by_membership_id) references public.memberships (tenant_id, id) on delete restrict,
  constraint staff_pos_pin_credentials_role_valid check (pos_role in ('admin', 'cashier')),
  constraint staff_pos_pin_credentials_scrypt_positive
    check (scrypt_n >= 2 and scrypt_r >= 1 and scrypt_p >= 1),
  constraint staff_pos_pin_credentials_key_length_min check (key_length >= 16),
  constraint staff_pos_pin_credentials_updated_after_created check (updated_at >= created_at)
);

comment on table public.staff_pos_pin_credentials is
  'Non-device-bound online scrypt PIN verifier for the connected pos_pin login, plus cafe-style POS UI access (pos_role + pos_permissions). Never stores plaintext; API authorization stays governed by the membership RBAC.';

-- ---- Durable login throttle (global, pre-tenant) -------------------------------------------------------
create table public.pos_login_attempts (
  username text primary key,
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  constraint pos_login_attempts_failed_count_nonneg check (failed_count >= 0)
);

comment on table public.pos_login_attempts is
  'Durable per-username POS login throttle (5 failures -> 30s lockout) so a restart is not a brute-force bypass. Keyed on the submitted username regardless of whether the account exists, to avoid enumeration via lockout.';

-- staff_writer owns the RPCs below, so it needs DML on the new tables it writes.
grant select, insert, update on public.staff_pos_pin_credentials to staff_writer;
grant select, insert, update, delete on public.pos_login_attempts to staff_writer;
create policy staff_writer_pos_pin_write on public.staff_pos_pin_credentials
  for all to staff_writer using (true) with check (true);
create policy staff_writer_login_attempts_write on public.pos_login_attempts
  for all to staff_writer using (true) with check (true);

-- ===== Provisioning RPC ================================================================================
-- Create the full pos_pin login graph for an already-minted server subject, in one transaction:
--   UserIdentity (email-less, login_username) -> pos_pin provider binding -> active Membership ->
--   initial Role+Scope assignment -> online PIN verifier + POS UI access.
-- Idempotent on (tenant, key). Anti-escalation mirrors create_staff_login/assign_role exactly.
create function staff_private.create_pos_login(
  p_tenant uuid, p_actor uuid, p_key text,
  p_subject text, p_username text, p_display_name text, p_role uuid, p_scope uuid,
  p_pos_role text, p_pos_permissions text[],
  p_salt text, p_hash text, p_n integer, p_r integer, p_p integer, p_key_length integer
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare
  v_intent jsonb; v_replay jsonb;
  v_subject text := btrim(coalesce(p_subject,''));
  v_username text := lower(btrim(coalesce(p_username,'')));
  v_display text := btrim(coalesce(p_display_name,''));
  v_pos_role text := btrim(coalesce(p_pos_role,''));
  v_identity uuid; v_membership uuid; v_m_status text;
  v_r public.roles; v_s public.access_scopes;
  v_caller text[]; v_missing text[]; v_response jsonb;
begin
  if p_tenant is null or p_actor is null or p_role is null or p_scope is null
    or v_subject='' or v_display='' or v_username='' or p_salt is null or p_hash is null then
    raise exception using errcode='22023', message='Invalid create-pos-login command'; end if;
  if v_username !~ '^[a-z0-9][a-z0-9._-]{1,30}$' then
    raise exception using errcode='22023', message='Invalid login username'; end if;
  if v_pos_role not in ('admin','cashier') then
    raise exception using errcode='22023', message='Invalid POS role'; end if;

  v_intent := jsonb_build_object('op','create_pos_login','actor',p_actor,'subject',v_subject,
    'username',v_username,'displayName',v_display,'roleId',p_role,'accessScopeId',p_scope,'posRole',v_pos_role);
  v_replay := staff_private.begin_command(p_tenant,p_key,v_intent);
  if v_replay is not null then return v_replay; end if;

  -- Validate role + scope and the anti-escalation subset BEFORE creating any identity rows.
  select * into v_r from public.roles where tenant_id=p_tenant and id=p_role;
  if not found then raise exception using errcode='ST404',message='Role not found'; end if;
  if v_r.status<>'active' then raise exception using errcode='ST409',message='Role is archived'; end if;
  select * into v_s from public.access_scopes where tenant_id=p_tenant and id=p_scope;
  if not found then raise exception using errcode='ST404',message='Access scope not found'; end if;
  if v_s.status<>'active' then raise exception using errcode='ST409',message='Access scope is archived'; end if;
  v_caller := staff_private.tenant_permission_keys(p_tenant,p_actor);
  select coalesce(array_agg(p.key),'{}') into v_missing
   from public.role_permissions rp join public.permissions p on p.id=rp.permission_id and p.status='active'
   where rp.tenant_id=p_tenant and rp.role_id=p_role and not (p.key=any(v_caller));
  if array_length(v_missing,1) is not null then
    raise exception using errcode='ST403',message='Assignment would grant permissions the caller does not hold'; end if;

  -- Reuse an existing live pos_pin binding for this subject (idempotent partial retry); refuse an unlinked
  -- binding rather than silently rebind; otherwise create the email-less identity + binding.
  select user_identity_id into v_identity from public.user_identity_provider_bindings
   where provider='pos_pin' and provider_subject=v_subject and unlinked_at is null;
  if v_identity is null then
    if exists(select 1 from public.user_identity_provider_bindings
        where provider='pos_pin' and provider_subject=v_subject) then
      raise exception using errcode='ST409',message='Provider subject already bound'; end if;
    insert into public.user_identities(status,display_name,login_username)
      values('active',v_display,v_username) returning id into v_identity;
    insert into public.user_identity_provider_bindings(user_identity_id,provider,provider_subject)
      values(v_identity,'pos_pin',v_subject);
  elsif (select status from public.user_identities where id=v_identity) <> 'active' then
    raise exception using errcode='ST423',message='Identity is not active';
  end if;

  -- Active membership for (tenant, identity): reuse an active one, refuse silent reactivation, else create.
  select id,status into v_membership,v_m_status from public.memberships
   where tenant_id=p_tenant and user_identity_id=v_identity;
  if v_membership is not null then
    if v_m_status<>'active' then raise exception using errcode='ST409',message='Membership is not active'; end if;
  else
    insert into public.memberships(tenant_id,user_identity_id,status,activated_at)
      values(p_tenant,v_identity,'active',now()) returning id into v_membership;
  end if;

  -- Initial assignment; the current-unique index makes a duplicate role+scope a no-op on retry.
  if not exists(select 1 from public.membership_role_assignments
      where tenant_id=p_tenant and membership_id=v_membership and role_id=p_role
        and access_scope_id=p_scope and unassigned_at is null) then
    insert into public.membership_role_assignments(tenant_id,membership_id,role_id,access_scope_id)
      values(p_tenant,v_membership,p_role,p_scope);
  end if;

  -- Online verifier + POS UI access. Upsert so a partial retry overwrites rather than duplicating.
  insert into public.staff_pos_pin_credentials(
    tenant_id,membership_id,salt_base64,hash_base64,scrypt_n,scrypt_r,scrypt_p,key_length,
    pos_role,pos_permissions,set_by_membership_id)
  values(p_tenant,v_membership,p_salt,p_hash,p_n,p_r,p_p,p_key_length,
    v_pos_role,coalesce(p_pos_permissions,'{}'),p_actor)
  on conflict (tenant_id,membership_id) do update set
    salt_base64=excluded.salt_base64,hash_base64=excluded.hash_base64,scrypt_n=excluded.scrypt_n,
    scrypt_r=excluded.scrypt_r,scrypt_p=excluded.scrypt_p,key_length=excluded.key_length,
    pos_role=excluded.pos_role,pos_permissions=excluded.pos_permissions,
    set_by_membership_id=excluded.set_by_membership_id,updated_at=now();

  v_response := staff_private.staff_detail_json(p_tenant,v_membership);
  return staff_private.finish_command(p_tenant,p_key,v_intent,v_response);
end $f$;

-- ===== Public login path (global, pre-tenant) =========================================================
-- Resolve lockout state + account + verifier for a submitted username in one row. ALWAYS returns exactly
-- one row: the lockout columns reflect pos_login_attempts (whether or not the account exists), and the
-- account/verifier columns are NULL for an unknown username so the caller can run a throwaway verify for
-- timing equalisation. Only an ACTIVE pos_pin binding + ACTIVE membership + present credential resolves.
create function staff_private.pos_login_begin(p_username text)
returns table(
  locked boolean, locked_until timestamptz, failed_count integer,
  provider_subject text, tenant_id uuid, membership_id uuid, display_name text, username text,
  pos_role text, pos_permissions text[],
  salt_base64 text, hash_base64 text, scrypt_n integer, scrypt_r integer, scrypt_p integer, key_length integer
) language plpgsql stable security definer set search_path='' as $f$
declare
  v_username text := lower(btrim(coalesce(p_username,'')));
  v_locked_until timestamptz; v_failed integer := 0;
begin
  select a.locked_until, a.failed_count into v_locked_until, v_failed
   from public.pos_login_attempts a where a.username=v_username;

  return query
   select
     (v_locked_until is not null and v_locked_until > now()) as locked,
     v_locked_until, coalesce(v_failed,0),
     b.provider_subject, m.tenant_id, m.id, ui.display_name, ui.login_username,
     c.pos_role, c.pos_permissions,
     c.salt_base64, c.hash_base64, c.scrypt_n, c.scrypt_r, c.scrypt_p, c.key_length
   from (select 1) one
   left join public.user_identities ui on ui.login_username=v_username and ui.status='active'
   left join public.user_identity_provider_bindings b
     on b.user_identity_id=ui.id and b.provider='pos_pin' and b.unlinked_at is null
   left join public.memberships m on m.user_identity_id=ui.id and m.status='active'
   left join public.staff_pos_pin_credentials c on c.tenant_id=m.tenant_id and c.membership_id=m.id
   limit 1;
end $f$;

-- Record the outcome of a login attempt and return the resulting throttle state. On success the row is
-- cleared; on failure the counter increments and, at the 5th failure, a 30s lockout is armed and the
-- counter reset so each lockout window starts fresh.
create function staff_private.pos_login_record(p_username text, p_success boolean)
returns table(locked_until timestamptz, failed_count integer)
language plpgsql security definer set search_path='' as $f$
declare
  v_username text := lower(btrim(coalesce(p_username,'')));
  v_failed integer; v_locked timestamptz;
begin
  if p_success then
    delete from public.pos_login_attempts where username=v_username;
    return query select null::timestamptz, 0;
    return;
  end if;

  insert into public.pos_login_attempts(username,failed_count,locked_until,updated_at)
    values(v_username,1,null,now())
  on conflict (username) do update set
    failed_count = public.pos_login_attempts.failed_count + 1,
    updated_at = now()
  returning failed_count, locked_until into v_failed, v_locked;

  if v_failed >= 5 then
    update public.pos_login_attempts
      set locked_until = now() + interval '30 seconds', failed_count = 0, updated_at = now()
      where username=v_username
      returning locked_until, failed_count into v_locked, v_failed;
  end if;

  return query select v_locked, v_failed;
end $f$;

-- ===== Management RPCs (tenant-scoped, staff.manage enforced at the transport) =========================
-- List every pos_pin account in the tenant for the admin "Team" surface.
create function staff_private.list_pos_logins(p_tenant uuid)
returns table(
  membership_id uuid, username text, display_name text, status text,
  pos_role text, pos_permissions text[]
) language sql stable security definer set search_path='' as $f$
  select m.id, ui.login_username, ui.display_name, m.status, c.pos_role, c.pos_permissions
   from public.staff_pos_pin_credentials c
   join public.memberships m on m.tenant_id=c.tenant_id and m.id=c.membership_id
   join public.user_identities ui on ui.id=m.user_identity_id
   where c.tenant_id=p_tenant
   order by ui.login_username
$f$;

-- Shared anti-escalation guard: raise unless every permission the target holds is also held by the actor
-- tenant-wide. Mirrors assign_role / set_offline_pin exactly.
create function staff_private.assert_covers_target(p_tenant uuid, p_actor uuid, p_membership uuid)
returns void language plpgsql stable security definer set search_path='' as $f$
declare v_caller text[]; v_missing text[];
begin
  v_caller := staff_private.tenant_permission_keys(p_tenant,p_actor);
  select coalesce(array_agg(distinct p.key),'{}') into v_missing
   from public.membership_role_assignments a
   join public.roles r on r.tenant_id=a.tenant_id and r.id=a.role_id and r.status='active'
   join public.role_permissions rp on rp.tenant_id=a.tenant_id and rp.role_id=a.role_id
   join public.permissions p on p.id=rp.permission_id and p.status='active'
   where a.tenant_id=p_tenant and a.membership_id=p_membership and a.unassigned_at is null
     and not (p.key = any(v_caller));
  if array_length(v_missing,1) is not null then
    raise exception using errcode='ST403',
      message='This change would affect permissions the caller does not hold'; end if;
end $f$;

-- Update the cafe-style POS UI access (display name + pos_role + pos_permissions) for a pos_pin account.
-- Membership lifecycle (activate/suspend/deactivate) stays with the existing set_staff_status path.
create function staff_private.update_pos_login(
  p_tenant uuid, p_actor uuid, p_key text, p_membership uuid,
  p_display_name text, p_pos_role text, p_pos_permissions text[]
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare
  v_intent jsonb; v_replay jsonb; v_pos_role text := btrim(coalesce(p_pos_role,'')); v_response jsonb;
begin
  if p_tenant is null or p_actor is null or p_membership is null then
    raise exception using errcode='22023', message='Invalid update-pos-login command'; end if;
  if v_pos_role not in ('admin','cashier') then
    raise exception using errcode='22023', message='Invalid POS role'; end if;

  v_intent := jsonb_build_object('op','update_pos_login','actor',p_actor,'membership',p_membership,
    'posRole',v_pos_role);
  v_replay := staff_private.begin_command(p_tenant,p_key,v_intent);
  if v_replay is not null then return v_replay; end if;

  if not exists(select 1 from public.staff_pos_pin_credentials
      where tenant_id=p_tenant and membership_id=p_membership) then
    raise exception using errcode='ST404', message='POS login not found'; end if;
  perform staff_private.assert_covers_target(p_tenant,p_actor,p_membership);

  update public.staff_pos_pin_credentials
    set pos_role=v_pos_role, pos_permissions=coalesce(p_pos_permissions,'{}'),
        set_by_membership_id=p_actor, updated_at=now()
    where tenant_id=p_tenant and membership_id=p_membership;

  if p_display_name is not null and btrim(p_display_name) <> '' then
    update public.user_identities ui set display_name=btrim(p_display_name)
      from public.memberships m
      where m.tenant_id=p_tenant and m.id=p_membership and ui.id=m.user_identity_id;
  end if;

  v_response := staff_private.staff_detail_json(p_tenant,p_membership);
  return staff_private.finish_command(p_tenant,p_key,v_intent,v_response);
end $f$;

-- Reset a pos_pin account's online PIN verifier (rotate the PIN). Idempotent on (tenant, key); the volatile
-- salt/hash are NOT part of the ledger intent (a retry carries fresh bytes).
create function staff_private.set_pos_login_pin(
  p_tenant uuid, p_actor uuid, p_key text, p_membership uuid,
  p_salt text, p_hash text, p_n integer, p_r integer, p_p integer, p_key_length integer
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_intent jsonb; v_replay jsonb; v_updated timestamptz;
begin
  if p_tenant is null or p_actor is null or p_membership is null or p_salt is null or p_hash is null then
    raise exception using errcode='22023', message='Invalid set-pos-login-pin command'; end if;

  v_intent := jsonb_build_object('op','set_pos_login_pin','actor',p_actor,'membership',p_membership);
  v_replay := staff_private.begin_command(p_tenant,p_key,v_intent);
  if v_replay is not null then return v_replay; end if;

  if not exists(select 1 from public.staff_pos_pin_credentials
      where tenant_id=p_tenant and membership_id=p_membership) then
    raise exception using errcode='ST404', message='POS login not found'; end if;
  perform staff_private.assert_covers_target(p_tenant,p_actor,p_membership);

  update public.staff_pos_pin_credentials
    set salt_base64=p_salt, hash_base64=p_hash, scrypt_n=p_n, scrypt_r=p_r, scrypt_p=p_p,
        key_length=p_key_length, set_by_membership_id=p_actor, updated_at=now()
    where tenant_id=p_tenant and membership_id=p_membership
    returning updated_at into v_updated;

  return staff_private.finish_command(p_tenant,p_key,v_intent,
    jsonb_build_object('membershipId',p_membership,'updatedAt',v_updated));
end $f$;

-- ---- Ownership + execution grants (same pattern as the rest of the staff domain) -----------------------
grant create on schema staff_private to staff_writer;
alter function staff_private.create_pos_login(uuid,uuid,text,text,text,text,uuid,uuid,text,text[],text,text,integer,integer,integer,integer) owner to staff_writer;
alter function staff_private.pos_login_begin(text) owner to staff_writer;
alter function staff_private.pos_login_record(text,boolean) owner to staff_writer;
alter function staff_private.list_pos_logins(uuid) owner to staff_writer;
alter function staff_private.assert_covers_target(uuid,uuid,uuid) owner to staff_writer;
alter function staff_private.update_pos_login(uuid,uuid,text,uuid,text,text,text[]) owner to staff_writer;
alter function staff_private.set_pos_login_pin(uuid,uuid,text,uuid,text,text,integer,integer,integer,integer) owner to staff_writer;
revoke create on schema staff_private from staff_writer;

revoke all on function staff_private.create_pos_login(uuid,uuid,text,text,text,text,uuid,uuid,text,text[],text,text,integer,integer,integer,integer) from public, anon, authenticated;
revoke all on function staff_private.pos_login_begin(text) from public, anon, authenticated;
revoke all on function staff_private.pos_login_record(text,boolean) from public, anon, authenticated;
revoke all on function staff_private.list_pos_logins(uuid) from public, anon, authenticated;
revoke all on function staff_private.assert_covers_target(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function staff_private.update_pos_login(uuid,uuid,text,uuid,text,text,text[]) from public, anon, authenticated;
revoke all on function staff_private.set_pos_login_pin(uuid,uuid,text,uuid,text,text,integer,integer,integer,integer) from public, anon, authenticated;
grant execute on function
  staff_private.create_pos_login(uuid,uuid,text,text,text,text,uuid,uuid,text,text[],text,text,integer,integer,integer,integer),
  staff_private.pos_login_begin(text),
  staff_private.pos_login_record(text,boolean),
  staff_private.list_pos_logins(uuid),
  staff_private.update_pos_login(uuid,uuid,text,uuid,text,text,text[]),
  staff_private.set_pos_login_pin(uuid,uuid,text,uuid,text,text,integer,integer,integer,integer)
  to service_role;

-- RLS: the new tables are reachable only through the security-definer RPCs above (owned by staff_writer)
-- and, for completeness, directly by service_role. No authenticated policy exists by design.
alter table public.staff_pos_pin_credentials enable row level security;
alter table public.pos_login_attempts enable row level security;
revoke all on table public.staff_pos_pin_credentials from public;
revoke all on table public.pos_login_attempts from public;
do $block$
begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='service_role') then
  execute 'grant select on public.staff_pos_pin_credentials to service_role';
  execute 'grant select on public.pos_login_attempts to service_role';
 end if;
end;
$block$;
