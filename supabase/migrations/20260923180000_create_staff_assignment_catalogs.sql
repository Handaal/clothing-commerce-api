-- Phase 2O completion: canonical READ-ONLY catalogs of the authorization resources a staff manager may
-- select when assigning Role + AccessScope.
--
-- Motivation: `assign_role` consumes an EXISTING role id and an EXISTING access scope id, but nothing
-- exposed those two sets. A client was therefore forced to derive selectable options from assignments
-- other staff already hold — which breaks on a fresh tenant (no assignments to derive from), silently
-- hides valid-but-unused roles/scopes, and makes one member's options depend on another member's
-- memberships. These two functions are the canonical source instead.
--
-- This migration adds NO authoring capability: no role/scope/target creation, editing, deletion, or
-- permission editing (still deferred). It adds only SELECT projections, and `staff_writer` gains no new
-- write privilege anywhere.

-- The scope catalog projects a human-readable label for each explicit target so a manager can understand
-- what a scope actually covers. The four target tables are read-only for staff_writer; tenant isolation
-- comes from the proof-supplied tenant id in every WHERE/JOIN, identical to the rest of the domain.
grant select on public.brands, public.branches, public.warehouses, public.inventory_locations
 to staff_writer;
create policy staff_writer_brand_read on public.brands for select to staff_writer using(true);
create policy staff_writer_branch_read on public.branches for select to staff_writer using(true);
create policy staff_writer_warehouse_read on public.warehouses for select to staff_writer using(true);
create policy staff_writer_inventory_location_read on public.inventory_locations for select to staff_writer using(true);

-- Roles the caller may potentially assign, in this tenant only.
--
-- Anti-delegation: a role is listed only when every ACTIVE permission it carries is already held by the
-- actor tenant-wide — the exact predicate `assign_role` enforces, computed from the same
-- `tenant_permission_keys` source of truth, so the catalog can never suggest an assignment the write
-- would reject. The catalog is a convenience filter, NOT the authorization boundary: `assign_role`
-- re-runs the subset check independently, so knowing a role id grants nothing. A role with no active
-- permissions is trivially a subset and is listed (assigning it is likewise allowed and grants nothing).
--
-- Archived roles are excluded because `assign_role` rejects them (ST409). Ordering is by
-- `normalized_name`, which is unique per tenant, so the keyset cursor (`cursorKey`) is total and
-- deterministic across pages. No role names are matched or interpreted anywhere — selection is by id.
create function staff_private.list_assignable_roles(p_tenant uuid,p_actor uuid,p_after text,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_caller text[];
begin
 if p_tenant is null or p_actor is null or p_limit is null or p_limit not between 1 and 101
   or (p_after is not null and length(p_after)>400) then
   raise exception using errcode='22023',message='Invalid assignable role query'; end if;
 v_caller:=staff_private.tenant_permission_keys(p_tenant,p_actor);
 return (select coalesce(jsonb_agg(jsonb_build_object(
    'roleId',r.id,'roleName',r.name,'description',r.description,'isProtected',r.is_protected,
    'cursorKey',r.normalized_name,
    'permissionKeys',(select coalesce(jsonb_agg(p.key order by p.key),'[]'::jsonb)
      from public.role_permissions rp
      join public.permissions p on p.id=rp.permission_id and p.status='active'
      where rp.tenant_id=p_tenant and rp.role_id=r.id)
  ) order by r.normalized_name),'[]'::jsonb)
 from (select ro.id,ro.name,ro.normalized_name,ro.description,ro.is_protected
   from public.roles ro
   where ro.tenant_id=p_tenant and ro.status='active'
     and (p_after is null or ro.normalized_name>p_after)
     and not exists(select 1 from public.role_permissions rp
       join public.permissions p on p.id=rp.permission_id and p.status='active'
       where rp.tenant_id=p_tenant and rp.role_id=ro.id and not (p.key=any(v_caller)))
   order by ro.normalized_name limit p_limit) r);
end $f$;

-- Access scopes selectable for a Role+Scope assignment, in this tenant only.
--
-- No caller-relative filtering applies here: a scope carries no authority of its own — it only NARROWS
-- where an assigned role's permissions apply. Authority comes from the role, which is already filtered by
-- the subset rule above, so listing every active tenant scope cannot widen what a manager can grant.
--
-- Explicit scopes project their existing targets with the source `display_name` of the referenced
-- brand/branch/warehouse/inventory_location. No label is invented: the name is read from the target row,
-- and `access_scope_targets` composite FKs already pin every target to the scope's own tenant (the joins
-- re-assert `tenant_id` anyway). Tenant-mode scopes have no targets by construction.
create function staff_private.list_assignable_scopes(p_tenant uuid,p_after text,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $f$
begin
 if p_tenant is null or p_limit is null or p_limit not between 1 and 101
   or (p_after is not null and length(p_after)>400) then
   raise exception using errcode='22023',message='Invalid assignable scope query'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object(
    'accessScopeId',s.id,'scopeName',s.name,'description',s.description,'scopeMode',s.scope_mode,
    'cursorKey',s.normalized_name,
    'targets',(select coalesce(jsonb_agg(jsonb_build_object(
        'kind',case when t.brand_id is not null then 'brand'
                    when t.branch_id is not null then 'branch'
                    when t.warehouse_id is not null then 'warehouse'
                    else 'inventory_location' end,
        'id',coalesce(t.brand_id,t.branch_id,t.warehouse_id,t.inventory_location_id),
        'name',coalesce(b.display_name,br.display_name,w.display_name,il.display_name)
      ) order by t.id),'[]'::jsonb)
      from public.access_scope_targets t
      left join public.brands b on b.tenant_id=t.tenant_id and b.id=t.brand_id
      left join public.branches br on br.tenant_id=t.tenant_id and br.id=t.branch_id
      left join public.warehouses w on w.tenant_id=t.tenant_id and w.id=t.warehouse_id
      left join public.inventory_locations il on il.tenant_id=t.tenant_id and il.id=t.inventory_location_id
      where t.tenant_id=p_tenant and t.access_scope_id=s.id)
  ) order by s.normalized_name),'[]'::jsonb)
 from (select sc.id,sc.name,sc.normalized_name,sc.description,sc.scope_mode
   from public.access_scopes sc
   where sc.tenant_id=p_tenant and sc.status='active'
     and (p_after is null or sc.normalized_name>p_after)
   order by sc.normalized_name limit p_limit) s);
end $f$;

grant create on schema staff_private to staff_writer;
alter function staff_private.list_assignable_roles(uuid,uuid,text,integer) owner to staff_writer;
alter function staff_private.list_assignable_scopes(uuid,text,integer) owner to staff_writer;
revoke create on schema staff_private from staff_writer;

revoke all on function staff_private.list_assignable_roles(uuid,uuid,text,integer),
 staff_private.list_assignable_scopes(uuid,text,integer) from public,anon,authenticated,service_role;
grant execute on function staff_private.list_assignable_roles(uuid,uuid,text,integer),
 staff_private.list_assignable_scopes(uuid,text,integer) to service_role;
