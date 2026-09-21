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
