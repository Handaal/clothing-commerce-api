\set ON_ERROR_STOP on
begin;
set role service_role;
do $b$
declare
 t uuid:='2a000001-0000-4000-8000-000000000001'; ft uuid:='2a000001-0000-4000-8000-000000000002';
 a uuid:='2a000012-0000-4000-8000-000000000001';  -- base actor: the only tenant-wide staff admin
 sc uuid:='2a000014-0000-4000-8000-000000000001'; -- tenant-wide scope
 reader uuid:='2a000031-0000-4000-8000-000000000001';     -- subset of actor authority
 privileged uuid:='2a000031-0000-4000-8000-000000000002'; -- carries reports.read (actor lacks it)
 newid uuid:='2a000030-0000-4000-8000-000000000001';
 goneid uuid:='2a000030-0000-4000-8000-000000000002';
 admin_assignment uuid:='2a000016-0000-4000-8000-000000000001';
 created jsonb; d jsonb; m uuid; asg uuid;
begin
 -- Create: links an existing active identity as an active membership.
 created:=staff_private.create_staff(t,a,'create-1',newid);
 m:=(created->>'membershipId')::uuid;
 assert created->>'status'='active','new membership is active';
 assert created->>'identityId'=newid::text,'linked to the requested identity';
 assert created->>'displayName'='Dana Newhire','identity fields projected';
 assert created->>'tenantId'=t::text,'tenant owned';
 -- Idempotency: exact replay (normalized key) returns the same detail; changed intent conflicts.
 assert staff_private.create_staff(t,a,'CREATE-1',newid)=created,'create exact replay';
 begin perform staff_private.create_staff(t,a,'create-1',goneid); raise exception 'expected intent conflict';
 exception when sqlstate 'ID409' then null; end;
 -- Cannot link a non-active identity, and cannot create a duplicate membership for the same identity.
 begin perform staff_private.create_staff(t,a,'inactive-link',goneid); raise exception 'expected inactive identity';
 exception when sqlstate 'ST423' then null; end;
 begin perform staff_private.create_staff(t,a,'dup-link',newid); raise exception 'expected duplicate membership';
 exception when sqlstate '23505' then null; end;

 -- List / search / tenant isolation.
 assert jsonb_array_length(staff_private.list_staff(t,'dana',null,null,null,26))=1,'case-insensitive display-name search';
 assert jsonb_array_length(staff_private.list_staff(t,null,'active',null,null,26))>=1,'status filter';
 assert jsonb_array_length(staff_private.list_staff(t,null,null,reader,null,26))=0,'role filter before assignment';
 assert jsonb_array_length(staff_private.list_staff(ft,'dana',null,null,null,26))=0,'tenant-isolated list';
 assert jsonb_array_length(staff_private.list_staff(t,'%',null,null,null,26))=0,'literal search, no wildcard injection';

 -- Role assignment: subset succeeds; escalation blocked; cross-tenant denied.
 d:=staff_private.assign_role(t,a,'assign-1',m,reader,sc,null);
 assert jsonb_array_length(d->'assignments')=1,'assignment recorded';
 asg:=(d->'assignments'->0->>'assignmentId')::uuid;
 assert d->'assignments'->0->>'roleName'='Staff Reader','role projected';
 assert d->'assignments'->0->>'scopeMode'='tenant','scope projected';
 assert staff_private.assign_role(t,a,'ASSIGN-1',m,reader,sc,null)=d,'assign exact replay';
 assert jsonb_array_length(staff_private.list_staff(t,null,null,reader,null,26))=1,'role filter after assignment';
 begin perform staff_private.assign_role(t,a,'escalate',m,privileged,sc,null); raise exception 'expected escalation block';
 exception when sqlstate 'ST403' then null; end;
 begin perform staff_private.assign_role(t,a,'foreign-role',m,'2a000031-0000-4000-8000-0000000000ff',sc,null); raise exception 'expected role not found';
 exception when sqlstate 'ST404' then null; end;
 begin perform staff_private.assign_role(t,a,'foreign-mem','2a000012-0000-4000-8000-0000000000ff',reader,sc,null); raise exception 'expected membership not found';
 exception when sqlstate 'ST404' then null; end;

 -- Unassign is history-preserving (sets unassigned_at, never deletes) and idempotent.
 d:=staff_private.unassign_role(t,a,'unassign-1',m,asg,'left the team');
 assert jsonb_array_length(d->'assignments')=0,'assignment revoked';
 assert staff_private.unassign_role(t,a,'UNASSIGN-1',m,asg,'left the team')=d,'unassign exact replay';
 assert (select count(*)=1 from public.membership_role_assignments where id=asg and unassigned_at is not null),'assignment row preserved with unassigned_at';

 -- Lifecycle on the non-admin membership: suspend -> reactivate -> revoke -> terminal.
 d:=staff_private.set_staff_status(t,a,'susp-1',m,'suspended','on leave');
 assert d->>'status'='suspended','suspended';
 d:=staff_private.set_staff_status(t,a,'react-1',m,'active',null);
 assert d->>'status'='active','reactivated';
 assert staff_private.set_staff_status(t,a,'react-1',m,'active',null)=d,'status exact replay';
 d:=staff_private.set_staff_status(t,a,'revoke-1',m,'deactivated','left company');
 assert d->>'status'='deactivated','revoked';
 begin perform staff_private.set_staff_status(t,a,'revive',m,'active',null); raise exception 'expected terminal revoked';
 exception when sqlstate 'ST409' then null; end;

 -- Last-staff-admin protection: the base actor is the tenant's only tenant-wide staff.manage member.
 begin perform staff_private.set_staff_status(t,a,'self-suspend',a,'suspended',null); raise exception 'expected last-admin block on suspend';
 exception when sqlstate 'ST412' then null; end;
 begin perform staff_private.unassign_role(t,a,'self-unassign',a,admin_assignment,null); raise exception 'expected last-admin block on unassign';
 exception when sqlstate 'ST412' then null; end;

 -- Historical actor references survive every operation above.
 assert (select status='active' from public.memberships where id=a),'actor membership intact';
 assert (select count(*)=1 from public.membership_role_assignments where id=admin_assignment and unassigned_at is null),'actor admin assignment intact';
end $b$;
reset role;
select 'ALL_STAFF_PERSISTENCE_ASSERTIONS_PASSED';
rollback;
