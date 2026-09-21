-- Phase 2O: staff (membership) management over the existing identity + RBAC foundation.
--
-- This migration adds NO new identity or RBAC model. It manages the EXISTING public.memberships and
-- public.membership_role_assignments as a "Staff" projection: list/detail, membership lifecycle,
-- role+scope assignment, and unassignment. Add-staff links an already-provisioned UserIdentity (there is
-- no Clerk invitation integration; external invite delivery is deferred). All writes are idempotent,
-- serialized per (tenant, key), and enforce two V1 safety invariants in-transaction:
--   * anti-escalation: a caller may only assign a role whose active permission set is a subset of the
--     caller's own current tenant-wide active permissions;
--   * last-staff-admin lockout: an operation may never leave a tenant with zero active memberships that
--     hold staff.manage tenant-wide.
-- Historical actor references (orders, receipts, returns, etc.) are never rewritten: lifecycle changes
-- and unassignment are status/timestamp transitions, never deletes.

do $b$ begin
  if not exists(select 1 from pg_roles where rolname='staff_writer') then
    create role staff_writer nologin noinherit nobypassrls;
  end if;
  execute format('grant staff_writer to %I with set true',current_user);
end $b$;

create schema staff_private;
revoke all on schema staff_private from public, anon, authenticated;
grant usage on schema public, staff_private to staff_writer;

insert into public.permissions(key,description) values
 ('staff.read','Read tenant staff memberships, roles, scopes and lifecycle status.'),
 ('staff.manage','Add, activate/suspend/revoke, and assign roles/scopes to tenant staff memberships.')
on conflict(key) do nothing;

-- Idempotency ledger for every staff write. Same (tenant,key) + identical intent replays the stored
-- response; a different intent under the same key is a deterministic conflict.
create table public.staff_commands (
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 normalized_key text not null check(length(normalized_key) between 1 and 200),
 intent jsonb not null, response jsonb not null, created_at timestamptz not null default now(),
 primary key(tenant_id,normalized_key)
);
alter table public.staff_commands enable row level security;
revoke all on public.staff_commands from public, anon, authenticated, service_role;

-- staff_writer is the security-definer owner of the RPCs below. It gets explicit DML on the foundational
-- tables it manages plus SELECT on the read-only RBAC tables, via role-targeted policies (never bypassrls
-- and never table ownership). Every query filters by the proof-supplied tenant id, so a `using(true)`
-- policy is safe: tenant isolation comes from the WHERE clause, exactly as in the suppliers domain.
grant select, insert, update on public.memberships to staff_writer;
grant select, insert, update on public.membership_role_assignments to staff_writer;
grant select on public.user_identities, public.roles, public.permissions, public.role_permissions,
 public.access_scopes, public.access_scope_targets to staff_writer;
alter table public.staff_commands owner to staff_writer;

create policy staff_writer_membership_read on public.memberships for select to staff_writer using(true);
create policy staff_writer_membership_write on public.memberships for update to staff_writer using(true) with check(true);
create policy staff_writer_membership_insert on public.memberships for insert to staff_writer with check(true);
create policy staff_writer_assignment_read on public.membership_role_assignments for select to staff_writer using(true);
create policy staff_writer_assignment_write on public.membership_role_assignments for update to staff_writer using(true) with check(true);
create policy staff_writer_assignment_insert on public.membership_role_assignments for insert to staff_writer with check(true);
create policy staff_writer_identity_read on public.user_identities for select to staff_writer using(true);
create policy staff_writer_role_read on public.roles for select to staff_writer using(true);
create policy staff_writer_role_permission_read on public.role_permissions for select to staff_writer using(true);
-- The global permission catalog also has RLS enabled; the escalation subset check, admin-count and
-- detail projection all read it, so the writer needs an explicit read policy (grant alone is not enough).
create policy staff_writer_permission_read on public.permissions for select to staff_writer using(true);
create policy staff_writer_scope_read on public.access_scopes for select to staff_writer using(true);
create policy staff_writer_scope_target_read on public.access_scope_targets for select to staff_writer using(true);

-- ---- Shared read helpers -------------------------------------------------------------------------

-- Active tenant-wide permission keys currently effective for a membership. Mirrors the application
-- context resolver: assignment current (unassigned_at null, assigned_at <= now), role active, scope
-- active AND mode 'tenant', permission active. This is the single source of truth for both the
-- anti-escalation subset check and the last-staff-admin predicate.
create function staff_private.tenant_permission_keys(p_tenant uuid,p_membership uuid) returns text[]
language sql stable security definer set search_path='' as $f$
 select coalesce(array_agg(distinct p.key),'{}')
 from public.membership_role_assignments a
 join public.roles r on r.tenant_id=a.tenant_id and r.id=a.role_id and r.status='active'
 join public.access_scopes sc on sc.tenant_id=a.tenant_id and sc.id=a.access_scope_id
   and sc.status='active' and sc.scope_mode='tenant'
 join public.role_permissions rp on rp.tenant_id=a.tenant_id and rp.role_id=a.role_id
 join public.permissions p on p.id=rp.permission_id and p.status='active'
 where a.tenant_id=p_tenant and a.membership_id=p_membership
   and a.unassigned_at is null and a.assigned_at<=now()
$f$;

-- Count of active memberships that currently hold staff.manage tenant-wide. Used as the last-admin
-- backstop: every lifecycle/unassign write recomputes this AFTER its change and rolls back on zero.
create function staff_private.staff_admin_count(p_tenant uuid) returns integer
language sql stable security definer set search_path='' as $f$
 select count(*)::integer from public.memberships m
 where m.tenant_id=p_tenant and m.status='active'
   and 'staff.manage'=any(staff_private.tenant_permission_keys(p_tenant,m.id))
$f$;

-- Full detail projection for a single membership: identity fields, status, and current assignments with
-- their role, scope (mode + explicit brand/branch/warehouse/inventory_location targets) and permissions.
create function staff_private.staff_detail_json(p_tenant uuid,p_membership uuid) returns jsonb
language sql stable security definer set search_path='' as $f$
 select case when m.id is null then null else jsonb_build_object(
  'membershipId',m.id,'identityId',m.user_identity_id,'tenantId',m.tenant_id,
  'displayName',ui.display_name,'email',ui.primary_email,'status',m.status,
  'invitedAt',m.invited_at,'activatedAt',m.activated_at,'suspendedAt',m.suspended_at,
  'deactivatedAt',m.deactivated_at,'createdAt',m.created_at,'updatedAt',m.updated_at,
  'roles',(select coalesce(jsonb_agg(distinct jsonb_build_object('roleId',r.id,'roleName',r.name,'isProtected',r.is_protected) ),'[]'::jsonb)
    from public.membership_role_assignments a
    join public.roles r on r.tenant_id=a.tenant_id and r.id=a.role_id
    where a.tenant_id=p_tenant and a.membership_id=m.id and a.unassigned_at is null),
  'assignments',(select coalesce(jsonb_agg(jsonb_build_object(
      'assignmentId',a.id,'roleId',r.id,'roleName',r.name,'isProtectedRole',r.is_protected,
      'accessScopeId',sc.id,'scopeName',sc.name,'scopeMode',sc.scope_mode,'assignedAt',a.assigned_at,
      'targets',(select coalesce(jsonb_agg(jsonb_build_object('kind',
          case when t.brand_id is not null then 'brand' when t.branch_id is not null then 'branch'
               when t.warehouse_id is not null then 'warehouse' else 'inventory_location' end,
          'id',coalesce(t.brand_id,t.branch_id,t.warehouse_id,t.inventory_location_id)) order by t.id),'[]'::jsonb)
        from public.access_scope_targets t where t.tenant_id=a.tenant_id and t.access_scope_id=sc.id),
      'permissionKeys',(select coalesce(jsonb_agg(p.key order by p.key),'[]'::jsonb)
        from public.role_permissions rp join public.permissions p on p.id=rp.permission_id and p.status='active'
        where rp.tenant_id=a.tenant_id and rp.role_id=r.id)
    ) order by a.assigned_at desc,a.id),'[]'::jsonb)
    from public.membership_role_assignments a
    join public.roles r on r.tenant_id=a.tenant_id and r.id=a.role_id
    join public.access_scopes sc on sc.tenant_id=a.tenant_id and sc.id=a.access_scope_id
    where a.tenant_id=p_tenant and a.membership_id=m.id and a.unassigned_at is null)
 ) end
 from public.memberships m
 left join public.user_identities ui on ui.id=m.user_identity_id
 where m.tenant_id=p_tenant and m.id=p_membership
$f$;

-- Bounded, keyset-paginated staff list. Search matches identity display name/email (position(), never
-- interpolated LIKE); optional status and role filters; stable order by membership id.
create function staff_private.list_staff(p_tenant uuid,p_search text,p_status text,p_role uuid,p_after uuid,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $f$
begin
 if p_limit is null or p_limit not between 1 and 101
   or (p_status is not null and p_status not in ('invited','active','suspended','deactivated'))
   or length(p_search)>200 then raise exception using errcode='22023',message='Invalid staff query'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object(
    'membershipId',s.id,'identityId',s.user_identity_id,'tenantId',s.tenant_id,
    'displayName',s.display_name,'email',s.primary_email,'status',s.status,
    'createdAt',s.created_at,'updatedAt',s.updated_at,
    'roles',(select coalesce(jsonb_agg(distinct jsonb_build_object('roleId',r.id,'roleName',r.name,'isProtected',r.is_protected)),'[]'::jsonb)
      from public.membership_role_assignments a
      join public.roles r on r.tenant_id=a.tenant_id and r.id=a.role_id
      where a.tenant_id=p_tenant and a.membership_id=s.id and a.unassigned_at is null)
  ) order by s.id),'[]'::jsonb) from (
   select m.*,ui.display_name,ui.primary_email from public.memberships m
   join public.user_identities ui on ui.id=m.user_identity_id
   where m.tenant_id=p_tenant and (p_status is null or m.status=p_status)
     and (p_after is null or m.id>p_after)
     and (p_search is null or position(lower(p_search) in lower(coalesce(ui.display_name,'')))>0
        or position(lower(p_search) in lower(coalesce(ui.primary_email,'')))>0)
     and (p_role is null or exists(select 1 from public.membership_role_assignments a
        where a.tenant_id=p_tenant and a.membership_id=m.id and a.role_id=p_role and a.unassigned_at is null))
   order by m.id limit p_limit) s);
end $f$;

-- ---- Idempotent write helpers --------------------------------------------------------------------

-- Resolve/replay the shared idempotency ledger. Returns the stored response on exact replay, raises
-- ID409 on a conflicting intent under the same key, or NULL to proceed. Advisory lock serializes the key.
create function staff_private.begin_command(p_tenant uuid,p_key text,p_intent jsonb) returns jsonb
language plpgsql security definer set search_path='' as $f$
declare v_key text:=lower(btrim(p_key)); v_old public.staff_commands;
begin
 if p_tenant is null or p_key is null or length(v_key) not between 1 and 200 then
   raise exception using errcode='22023',message='Invalid staff command key'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff:'||p_tenant::text||':'||v_key,0));
 select * into v_old from public.staff_commands where tenant_id=p_tenant and normalized_key=v_key;
 if found then
  if v_old.intent is distinct from p_intent then raise exception using errcode='ID409',message='Staff intent conflict'; end if;
  return v_old.response;
 end if;
 return null;
end $f$;

create function staff_private.finish_command(p_tenant uuid,p_key text,p_intent jsonb,p_response jsonb) returns jsonb
language plpgsql security definer set search_path='' as $f$
begin
 insert into public.staff_commands(tenant_id,normalized_key,intent,response)
  values(p_tenant,lower(btrim(p_key)),p_intent,p_response);
 return p_response;
end $f$;

-- Create a Membership for an already-provisioned, active UserIdentity. The new membership is 'active'
-- (immediately usable — there is no external invitation/acceptance flow). One membership per (tenant,
-- identity) is enforced by the existing unique constraint (23505 -> already a member).
create function staff_private.create_staff(p_tenant uuid,p_actor uuid,p_key text,p_identity uuid)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_intent jsonb; v_replay jsonb; v_identity public.user_identities; v_membership uuid; v_response jsonb;
begin
 if p_tenant is null or p_actor is null or p_identity is null then
   raise exception using errcode='22023',message='Invalid create staff command'; end if;
 v_intent:=jsonb_build_object('op','create','actor',p_actor,'identityId',p_identity);
 v_replay:=staff_private.begin_command(p_tenant,p_key,v_intent);
 if v_replay is not null then return v_replay; end if;
 select * into v_identity from public.user_identities where id=p_identity;
 if not found then raise exception using errcode='ST404',message='Identity not found'; end if;
 if v_identity.status<>'active' then raise exception using errcode='ST423',message='Identity is not active'; end if;
 insert into public.memberships(tenant_id,user_identity_id,status,activated_at)
  values(p_tenant,p_identity,'active',now()) returning id into v_membership;
 v_response:=staff_private.staff_detail_json(p_tenant,v_membership);
 return staff_private.finish_command(p_tenant,p_key,v_intent,v_response);
end $f$;

-- Membership lifecycle transition. Allowed: active<->suspended, {invited,active,suspended}->deactivated,
-- invited->active. 'deactivated' (revoked) is terminal. The row is locked; after applying the change the
-- last-staff-admin backstop recomputes and rolls back a change that would strand the tenant.
create function staff_private.set_staff_status(p_tenant uuid,p_actor uuid,p_key text,p_membership uuid,p_status text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_intent jsonb; v_replay jsonb; v_row public.memberships; v_response jsonb;
begin
 if p_tenant is null or p_actor is null or p_membership is null
   or p_status not in ('active','suspended','deactivated')
   or (p_reason is not null and length(btrim(p_reason)) not between 1 and 500) then
   raise exception using errcode='22023',message='Invalid status command'; end if;
 v_intent:=jsonb_build_object('op','status','actor',p_actor,'membershipId',p_membership,'status',p_status,'reason',p_reason);
 v_replay:=staff_private.begin_command(p_tenant,p_key,v_intent);
 if v_replay is not null then return v_replay; end if;
 select * into v_row from public.memberships where tenant_id=p_tenant and id=p_membership for update;
 if not found then raise exception using errcode='ST404',message='Membership not found'; end if;
 if v_row.status='deactivated' then raise exception using errcode='ST409',message='Membership is revoked'; end if;
 if v_row.status=p_status then raise exception using errcode='ST409',message='Membership already in status'; end if;
 update public.memberships set
   status=p_status,
   activated_at=case when p_status='active' then coalesce(activated_at,now()) else activated_at end,
   suspended_at=case when p_status='suspended' then now() else null end,
   deactivated_at=case when p_status='deactivated' then now() else null end,
   deactivation_reason=case when p_status='deactivated' then p_reason else null end,
   updated_at=clock_timestamp()
  where tenant_id=p_tenant and id=p_membership;
 if p_status in ('suspended','deactivated') and staff_private.staff_admin_count(p_tenant)=0 then
   raise exception using errcode='ST412',message='Operation would remove the last staff administrator'; end if;
 v_response:=staff_private.staff_detail_json(p_tenant,p_membership);
 return staff_private.finish_command(p_tenant,p_key,v_intent,v_response);
end $f$;

-- Assign an existing tenant Role + AccessScope to a membership. Anti-escalation: every active permission
-- carried by the role must be within the actor's own current tenant-wide permission set. A duplicate
-- active (role,scope) is a conflict (23505 via the existing current-unique index).
create function staff_private.assign_role(p_tenant uuid,p_actor uuid,p_key text,p_membership uuid,p_role uuid,p_scope uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_intent jsonb; v_replay jsonb; v_m public.memberships; v_r public.roles; v_s public.access_scopes;
 v_caller text[]; v_missing text[]; v_response jsonb;
begin
 if p_tenant is null or p_actor is null or p_membership is null or p_role is null or p_scope is null
   or (p_reason is not null and length(btrim(p_reason)) not between 1 and 500) then
   raise exception using errcode='22023',message='Invalid assignment command'; end if;
 v_intent:=jsonb_build_object('op','assign','actor',p_actor,'membershipId',p_membership,'roleId',p_role,'accessScopeId',p_scope,'reason',p_reason);
 v_replay:=staff_private.begin_command(p_tenant,p_key,v_intent);
 if v_replay is not null then return v_replay; end if;
 select * into v_m from public.memberships where tenant_id=p_tenant and id=p_membership for update;
 if not found then raise exception using errcode='ST404',message='Membership not found'; end if;
 if v_m.status='deactivated' then raise exception using errcode='ST409',message='Membership is revoked'; end if;
 select * into v_r from public.roles where tenant_id=p_tenant and id=p_role;
 if not found then raise exception using errcode='ST404',message='Role not found'; end if;
 if v_r.status<>'active' then raise exception using errcode='ST409',message='Role is archived'; end if;
 select * into v_s from public.access_scopes where tenant_id=p_tenant and id=p_scope;
 if not found then raise exception using errcode='ST404',message='Access scope not found'; end if;
 if v_s.status<>'active' then raise exception using errcode='ST409',message='Access scope is archived'; end if;
 -- Anti-escalation subset check against the actor's own tenant-wide permissions.
 v_caller:=staff_private.tenant_permission_keys(p_tenant,p_actor);
 select coalesce(array_agg(p.key),'{}') into v_missing
  from public.role_permissions rp join public.permissions p on p.id=rp.permission_id and p.status='active'
  where rp.tenant_id=p_tenant and rp.role_id=p_role and not (p.key=any(v_caller));
 if array_length(v_missing,1) is not null then
   raise exception using errcode='ST403',message='Assignment would grant permissions the caller does not hold'; end if;
 insert into public.membership_role_assignments(tenant_id,membership_id,role_id,access_scope_id,assignment_reason)
  values(p_tenant,p_membership,p_role,p_scope,p_reason);
 v_response:=staff_private.staff_detail_json(p_tenant,p_membership);
 return staff_private.finish_command(p_tenant,p_key,v_intent,v_response);
end $f$;

-- Unassign (revoke) a currently-active assignment. Preserves history (sets unassigned_at, never deletes).
-- Recomputes the last-staff-admin backstop after the change.
create function staff_private.unassign_role(p_tenant uuid,p_actor uuid,p_key text,p_membership uuid,p_assignment uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_intent jsonb; v_replay jsonb; v_a public.membership_role_assignments; v_response jsonb;
begin
 if p_tenant is null or p_actor is null or p_membership is null or p_assignment is null
   or (p_reason is not null and length(btrim(p_reason)) not between 1 and 500) then
   raise exception using errcode='22023',message='Invalid unassignment command'; end if;
 v_intent:=jsonb_build_object('op','unassign','actor',p_actor,'membershipId',p_membership,'assignmentId',p_assignment,'reason',p_reason);
 v_replay:=staff_private.begin_command(p_tenant,p_key,v_intent);
 if v_replay is not null then return v_replay; end if;
 -- Lock the owning membership so admin-count races serialize.
 perform 1 from public.memberships where tenant_id=p_tenant and id=p_membership for update;
 select * into v_a from public.membership_role_assignments
  where tenant_id=p_tenant and id=p_assignment and membership_id=p_membership;
 if not found then raise exception using errcode='ST404',message='Assignment not found'; end if;
 if v_a.unassigned_at is null then
   update public.membership_role_assignments set unassigned_at=now(),unassignment_reason=p_reason
    where tenant_id=p_tenant and id=p_assignment;
   if staff_private.staff_admin_count(p_tenant)=0 then
     raise exception using errcode='ST412',message='Operation would remove the last staff administrator'; end if;
 end if;
 v_response:=staff_private.staff_detail_json(p_tenant,p_membership);
 return staff_private.finish_command(p_tenant,p_key,v_intent,v_response);
end $f$;

-- ---- Ownership + execution grants ----------------------------------------------------------------
grant create on schema staff_private to staff_writer;
alter function staff_private.tenant_permission_keys(uuid,uuid) owner to staff_writer;
alter function staff_private.staff_admin_count(uuid) owner to staff_writer;
alter function staff_private.staff_detail_json(uuid,uuid) owner to staff_writer;
alter function staff_private.list_staff(uuid,text,text,uuid,uuid,integer) owner to staff_writer;
alter function staff_private.begin_command(uuid,text,jsonb) owner to staff_writer;
alter function staff_private.finish_command(uuid,text,jsonb,jsonb) owner to staff_writer;
alter function staff_private.create_staff(uuid,uuid,text,uuid) owner to staff_writer;
alter function staff_private.set_staff_status(uuid,uuid,text,uuid,text,text) owner to staff_writer;
alter function staff_private.assign_role(uuid,uuid,text,uuid,uuid,uuid,text) owner to staff_writer;
alter function staff_private.unassign_role(uuid,uuid,text,uuid,uuid,text) owner to staff_writer;
revoke create on schema staff_private from staff_writer;

revoke all on all functions in schema staff_private from public,anon,authenticated,service_role;
grant usage on schema staff_private to service_role;
-- Only the two list/detail readers and the four mutation entry points are callable by the transport;
-- the internal helpers (begin/finish/permission/admin-count) are not granted to service_role.
grant execute on function staff_private.list_staff(uuid,text,text,uuid,uuid,integer),
 staff_private.staff_detail_json(uuid,uuid),
 staff_private.create_staff(uuid,uuid,text,uuid),
 staff_private.set_staff_status(uuid,uuid,text,uuid,text,text),
 staff_private.assign_role(uuid,uuid,text,uuid,uuid,uuid,text),
 staff_private.unassign_role(uuid,uuid,text,uuid,uuid,text) to service_role;
