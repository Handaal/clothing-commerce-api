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

-- A second active, unique-email non-member reserved for the create-succeeds/assign-fails recovery proof
-- (Admin runtime scenario M): the membership is created for real, the initial assignment is made to fail
-- once, and only the assignment is retried — never the create — so exactly one membership results.
insert into public.user_identities(id,status,display_name,primary_email,deactivated_at)
values ('2a000030-0000-4000-8000-000000000005','active','Percy Partial','percy@example.test',null)
on conflict(id) do nothing;

-- Two more active, unique-email non-members so the Admin runtime's role/scope-assignment (F) and
-- suspend/reactivate/deactivate (I+L) scenarios each operate on their OWN dedicated member — never the
-- last tenant-wide admin, and independent of each other's ordering.
insert into public.user_identities(id,status,display_name,primary_email,deactivated_at)
values
 ('2a000030-0000-4000-8000-000000000006','active','Frankie Fixture','frankie@example.test',null),
 ('2a000030-0000-4000-8000-000000000007','active','Ingrid Fixture','ingrid@example.test',null)
on conflict(id) do nothing;

-- One more active, unique-email non-member for the Admin runtime's foreign-scope isolation proof
-- (scenario H): it is provisioned as a bare membership so the detail's add-assignment picker (fed by the
-- canonical scope catalog) can be inspected, and a direct foreign-scope assignment attempt can be made
-- against it via the real adapter seam and proven to be refused with no mutation.
insert into public.user_identities(id,status,display_name,primary_email,deactivated_at)
values ('2a000030-0000-4000-8000-000000000008','active','Harold Foreign','harold@example.test',null)
on conflict(id) do nothing;

-- A second admin-eligible identity for the Admin runtime's last-admin TWO-ADMIN proof (scenario J). It
-- carries its OWN clerk provider binding so the runtime can mint a verifiable session for it, but it is
-- seeded with NO membership and NO assignment: its tenant-wide staff.manage admin membership is created
-- at RUNTIME by scenario J only, so the SINGLE-admin phase still sees exactly one tenant-wide admin
-- (the base actor, membership 2a…12-01). After J provisions it, its session can authoritatively re-read
-- staff state to prove the removal of the original admin succeeded and this one remains effective.
insert into public.user_identities(id,status,display_name,primary_email,deactivated_at)
values ('2a000010-0000-4000-8000-000000000005','active','Blair Backup','blair@example.test',null)
on conflict(id) do nothing;
insert into public.user_identity_provider_bindings(id,user_identity_id,provider,provider_subject)
values ('2a000011-0000-4000-8000-000000000005','2a000010-0000-4000-8000-000000000005','clerk','staff-admin-2')
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
