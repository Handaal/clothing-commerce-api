-- Disposable fixture only; migrations never assign staff permissions to roles.
-- Makes the base actor (membership 2a000012-…-01, role 2a000013-…-01 via the tenant-wide scope
-- 2a000014-…-01) a tenant-wide staff administrator, and seeds linkable identities plus a subset role
-- and an escalated role for the anti-escalation proof.
insert into public.permissions(key,description)
values ('reports.read','Fixture-only permission deliberately outside the base actor authority')
on conflict(key) do nothing;

insert into public.role_permissions(tenant_id,role_id,permission_id)
select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000013-0000-4000-8000-000000000001'::uuid,id
from public.permissions where key in ('staff.read','staff.manage') on conflict do nothing;

-- Linkable identities with no tenant membership yet: one active, one deactivated.
insert into public.user_identities(id,status,display_name,primary_email,deactivated_at)
values
 ('2a000030-0000-4000-8000-000000000001','active','Dana Newhire','dana@example.test',null),
 ('2a000030-0000-4000-8000-000000000002','deactivated','Removed Person','gone@example.test',now())
on conflict(id) do nothing;

-- Two ACTIVE identities that share the exact same (normalized) email. primary_email is not unique, so an
-- exact-email lookup must return BOTH (0..N contract), in deterministic id order, preferring neither.
-- Stored with case/whitespace variation to prove normalization collapses them to one match set.
insert into public.user_identities(id,status,display_name,primary_email,deactivated_at)
values
 ('2a000030-0000-4000-8000-000000000003','active','Sam Alpha','shared@example.test',null),
 ('2a000030-0000-4000-8000-000000000004','active','Sam Beta',' SHARED@Example.test ',null)
on conflict(id) do nothing;

-- Subset role (assignable by the actor) and escalated role (must be blocked by anti-escalation).
insert into public.roles(id,tenant_id,name,status,is_protected)
values
 ('2a000031-0000-4000-8000-000000000001','2a000001-0000-4000-8000-000000000001','Staff Reader','active',false),
 ('2a000031-0000-4000-8000-000000000002','2a000001-0000-4000-8000-000000000001','Privileged','active',false)
on conflict(id) do nothing;
insert into public.role_permissions(tenant_id,role_id,permission_id)
select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000031-0000-4000-8000-000000000001'::uuid,id
from public.permissions where key in ('staff.read') on conflict do nothing;
insert into public.role_permissions(tenant_id,role_id,permission_id)
select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000031-0000-4000-8000-000000000002'::uuid,id
from public.permissions where key in ('staff.read','reports.read') on conflict do nothing;

-- Assignment-catalog fixtures ---------------------------------------------------------------------
-- An archived role and an archived scope: both are rejected by assign_role, so neither may appear in a
-- catalog. A permissionless role is a trivial subset and MUST appear.
insert into public.roles(id,tenant_id,name,status,is_protected,archived_at)
values
 ('2a000031-0000-4000-8000-000000000003','2a000001-0000-4000-8000-000000000001','Retired Role','archived',false,now()),
 ('2a000031-0000-4000-8000-000000000004','2a000001-0000-4000-8000-000000000001','Empty Role','active',false,null)
on conflict(id) do nothing;

insert into public.access_scopes(id,tenant_id,name,scope_mode,status,archived_at)
values ('2a000014-0000-4000-8000-000000000009','2a000001-0000-4000-8000-000000000001','Retired Scope','tenant','archived',now())
on conflict(id) do nothing;

-- Foreign-tenant role and explicit scope with its own branch target. Nothing here may ever surface in a
-- catalog read for the base tenant, and the foreign scope's target must stay bound to the foreign tenant.
insert into public.branches(id,tenant_id,code,display_name,timezone,status)
values ('2a000003-0000-4000-8000-0000000000f1','2a000001-0000-4000-8000-000000000002','foreign-branch','Foreign Branch','UTC','active')
on conflict(id) do nothing;

insert into public.roles(id,tenant_id,name,status,is_protected)
values ('2a000031-0000-4000-8000-0000000000f1','2a000001-0000-4000-8000-000000000002','Foreign Role','active',false)
on conflict(id) do nothing;

insert into public.access_scopes(id,tenant_id,name,scope_mode,status)
values ('2a000014-0000-4000-8000-0000000000f1','2a000001-0000-4000-8000-000000000002','Foreign Scope','explicit','active')
on conflict(id) do nothing;

insert into public.access_scope_targets(id,tenant_id,access_scope_id,brand_id,branch_id)
values ('2a000015-0000-4000-8000-0000000000f1','2a000001-0000-4000-8000-000000000002','2a000014-0000-4000-8000-0000000000f1',null,'2a000003-0000-4000-8000-0000000000f1')
on conflict(id) do nothing;
