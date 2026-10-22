-- Phase 2O-B: email-less staff LOGIN provisioning (Connected POS floor staff).
--
-- The existing staff management (20260922180000) links an ALREADY-provisioned, email-bound UserIdentity
-- as a Membership. Floor staff in a clothing boutique typically have NO email, so that add-staff flow
-- cannot onboard them. This migration adds ONE security-definer RPC that creates the whole login graph in
-- a single transaction for a staff member identified only by a display name + a login username:
--
--   UserIdentity (email-less) -> clerk provider binding -> active Membership -> initial Role+Scope assignment
--
-- It introduces NO new identity model and NO new permission: it mirrors `create_staff` + `assign_role`
-- (same idempotency ledger, same anti-escalation subset check) and reuses the EXACT graph the reviewed
-- `provision-dev-identity.sql` builds by hand. Authorization is unchanged: the transport still requires
-- tenant-wide `staff.manage`, and the resulting identity has access ONLY through the role/scope assigned
-- here. The external Clerk account itself is created out-of-band by the server transport (which holds the
-- Clerk secret); this RPC only records the already-created, server-verified provider subject. The subject
-- is NEVER client-supplied — exactly as the security model requires.
--
-- `login_username` is persisted on the identity so the POS can render its roster/PIN picker and pass the
-- username to Clerk sign-in without a round-trip to Clerk. It mirrors Clerk's instance-global username
-- uniqueness with a partial-unique index (NULL for every email/Clerk-dashboard identity, unchanged).

-- The login username lives on the platform-global identity (Clerk usernames are instance-global), nullable
-- so every pre-existing identity is untouched. Lowercased, bounded; uniqueness ignores NULLs.
alter table public.user_identities
  add column login_username text,
  add constraint user_identities_login_username_format check (
    login_username is null or login_username ~ '^[a-z0-9][a-z0-9._-]{1,30}$'
  );

create unique index user_identities_login_username_unique_idx
  on public.user_identities (login_username)
  where login_username is not null;

comment on column public.user_identities.login_username is
  'Optional instance-global login username for email-less (PIN) staff; NULL for email/Clerk-dashboard identities.';

-- staff_writer owns the login RPC below, so it needs DML on the identity + binding tables it now writes.
-- It already holds SELECT on user_identities (20260922180000). Provider bindings have NO authenticated
-- policy by design; staff_writer reaches them only through this security-definer function, filtered by the
-- server-verified subject. Every query is tenant-filtered via the proof-supplied id, so `using(true)` is
-- safe here exactly as in the rest of the staff domain.
grant insert on public.user_identities to staff_writer;
grant select, insert on public.user_identity_provider_bindings to staff_writer;

create policy staff_writer_identity_insert on public.user_identities
  for insert to staff_writer with check (true);
create policy staff_writer_binding_read on public.user_identity_provider_bindings
  for select to staff_writer using (true);
create policy staff_writer_binding_insert on public.user_identity_provider_bindings
  for insert to staff_writer with check (true);

-- Read-only replay probe. The transport calls this BEFORE creating the external Clerk account, so a
-- genuine idempotent retry (same tenant + key) returns the stored staff detail without ever creating a
-- second Clerk user. Returns NULL when the key is unused (proceed to create). It reveals only this
-- tenant's own stored response and takes no advisory lock — the authoritative replay/conflict decision
-- still happens inside create_staff_login's begin_command under the per-key lock.
create function staff_private.peek_command(p_tenant uuid, p_key text) returns jsonb
language sql stable security definer set search_path='' as $f$
 select response from public.staff_commands
 where tenant_id=p_tenant and normalized_key=lower(btrim(p_key))
$f$;

-- Create the full login graph for an email-less staff member. Idempotent on (tenant, key): a genuine retry
-- replays the stored response. The provider subject is carried in the intent, so the transport MUST reuse
-- the same Clerk user on retry (it looks the user up by its unique username); a different subject under the
-- same key is a real conflict (two different people) and the ledger rejects it. Partial-failure retries are
-- also safe below the ledger: an existing live clerk binding for the subject is reused rather than
-- duplicated, a (tenant, identity) membership is reused when already active, and the current-unique
-- assignment index collapses a duplicate role+scope. Anti-escalation mirrors assign_role exactly.
create function staff_private.create_staff_login(
  p_tenant uuid, p_actor uuid, p_key text,
  p_subject text, p_username text, p_display_name text, p_role uuid, p_scope uuid
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare
  v_intent jsonb; v_replay jsonb;
  v_subject text := btrim(coalesce(p_subject,''));
  v_username text := lower(btrim(coalesce(p_username,'')));
  v_display text := btrim(coalesce(p_display_name,''));
  v_identity uuid; v_membership uuid; v_m_status text;
  v_r public.roles; v_s public.access_scopes;
  v_caller text[]; v_missing text[]; v_response jsonb;
begin
  if p_tenant is null or p_actor is null or p_role is null or p_scope is null
    or v_subject='' or v_display='' or v_username='' then
    raise exception using errcode='22023', message='Invalid create-login command'; end if;
  if v_username !~ '^[a-z0-9][a-z0-9._-]{1,30}$' then
    raise exception using errcode='22023', message='Invalid login username'; end if;

  v_intent := jsonb_build_object('op','create_login','actor',p_actor,'subject',v_subject,
    'username',v_username,'displayName',v_display,'roleId',p_role,'accessScopeId',p_scope);
  v_replay := staff_private.begin_command(p_tenant,p_key,v_intent);
  if v_replay is not null then return v_replay; end if;

  -- Validate role + scope and the anti-escalation subset BEFORE creating any identity rows, so an
  -- unauthorized/invalid request never leaves a dangling identity behind.
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

  -- Reuse an existing live clerk binding for this subject (idempotent partial retry); refuse an unlinked
  -- binding rather than silently rebind; otherwise create the email-less identity + binding.
  select user_identity_id into v_identity from public.user_identity_provider_bindings
   where provider='clerk' and provider_subject=v_subject and unlinked_at is null;
  if v_identity is null then
    if exists(select 1 from public.user_identity_provider_bindings
        where provider='clerk' and provider_subject=v_subject) then
      raise exception using errcode='ST409',message='Provider subject already bound'; end if;
    insert into public.user_identities(status,display_name,login_username)
      values('active',v_display,v_username) returning id into v_identity;
    insert into public.user_identity_provider_bindings(user_identity_id,provider,provider_subject)
      values(v_identity,'clerk',v_subject);
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

  v_response := staff_private.staff_detail_json(p_tenant,v_membership);
  return staff_private.finish_command(p_tenant,p_key,v_intent,v_response);
end $f$;

-- Ownership + execution grants (same pattern as the rest of the staff domain).
grant create on schema staff_private to staff_writer;
alter function staff_private.peek_command(uuid,text) owner to staff_writer;
alter function staff_private.create_staff_login(uuid,uuid,text,text,text,text,uuid,uuid) owner to staff_writer;
revoke create on schema staff_private from staff_writer;

revoke all on function staff_private.peek_command(uuid,text) from public, anon, authenticated;
revoke all on function staff_private.create_staff_login(uuid,uuid,text,text,text,text,uuid,uuid)
  from public, anon, authenticated;
grant execute on function staff_private.peek_command(uuid,text),
  staff_private.create_staff_login(uuid,uuid,text,text,text,text,uuid,uuid)
  to service_role;
