\set ON_ERROR_STOP on
begin;

-- Assertion helpers for the assignment-catalog projections (session-temporary; the transaction rolls
-- back regardless). Membership is checked by the human-meaningful name so a fixture id change cannot
-- silently weaken the proof; sortedness is checked on `cursorKey`, the normalized name the server
-- actually orders and pages by.
create function pg_temp.catalog_has(p jsonb, p_field text, p_value text) returns boolean
language sql immutable as $h$
 select exists(select 1 from jsonb_array_elements(p) e where e->>p_field = p_value)
$h$;

create function pg_temp.catalog_sorted(p jsonb) returns boolean language sql immutable as $h$
 select coalesce((select bool_and(previous is null or previous < current_key) from (
   select e->>'cursorKey' as current_key,
          lag(e->>'cursorKey') over (order by ordinality) as previous
   from jsonb_array_elements(p) with ordinality as rows(e, ordinality)) ordered), true)
$h$;

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
 mem2 uuid:='2a000012-0000-4000-8000-000000000002';    -- second base membership (not yet an admin)
 role_admin uuid:='2a000013-0000-4000-8000-000000000001'; -- actor's own role (carries staff.manage)
 created jsonb; d jsonb; cat jsonb; cat2 jsonb; m uuid; asg uuid;
begin
 -- Runtime J: Add-Staff identity resolution by EXACT email (a confirmation lookup, not a directory).
 -- (A) exact email -> the active, non-member identity is returned with the minimal projection.
 assert jsonb_array_length(staff_private.find_eligible_identities_by_email(t,'dana@example.test'))=1,'J.A exact email resolves the eligible identity';
 assert (staff_private.find_eligible_identities_by_email(t,'dana@example.test')->0->>'identityId')=newid::text,'J.A eligible projection identity id';
 assert (staff_private.find_eligible_identities_by_email(t,'dana@example.test')->0->>'primaryEmail')='dana@example.test','J.A eligible projection email';
 -- (B) case variation / surrounding whitespace follows normalized exact-match behavior.
 assert jsonb_array_length(staff_private.find_eligible_identities_by_email(t,'  DANA@Example.TEST  '))=1,'J.B email normalized (case-insensitive, trimmed)';
 -- (C) a partial email is not a match (no substring semantics).
 assert jsonb_array_length(staff_private.find_eligible_identities_by_email(t,'dana@'))=0,'J.C partial email does not match';
 assert jsonb_array_length(staff_private.find_eligible_identities_by_email(t,'dana'))=0,'J.C bare local-part does not match';
 -- (D) display-name search is unsupported (the display name is not an email).
 assert jsonb_array_length(staff_private.find_eligible_identities_by_email(t,'Dana Newhire'))=0,'J.D display-name lookup unsupported';
 -- (E) an inactive (deactivated) identity is indistinguishable from an unknown email: both empty.
 assert jsonb_array_length(staff_private.find_eligible_identities_by_email(t,'gone@example.test'))=0,'J.E inactive identity yields empty (enumeration-resistant)';
 assert jsonb_array_length(staff_private.find_eligible_identities_by_email(t,'nobody@example.test'))=0,'J.E unknown email yields the same empty result';
 -- No wildcard/substring injection surface: a LIKE metacharacter is treated as a literal email.
 assert jsonb_array_length(staff_private.find_eligible_identities_by_email(t,'%'))=0,'J literal email, no wildcard injection';
 -- (N>1) primary_email is not unique: two ACTIVE non-member identities share the exact normalized email.
 -- The lookup returns BOTH (0..N contract), in deterministic identity-id-ascending order, preferring
 -- neither. Case/whitespace variation on either the query or the stored value collapses to the same set.
 d:=staff_private.find_eligible_identities_by_email(t,'shared@example.test');
 assert jsonb_array_length(d)=2,'J.N exact-email lookup returns every matching identity (no server-side collapse)';
 assert (d->0->>'identityId')='2a000030-0000-4000-8000-000000000003','J.N deterministic order: id ascending (first)';
 assert (d->1->>'identityId')='2a000030-0000-4000-8000-000000000004','J.N deterministic order: id ascending (second); neither silently preferred';
 assert staff_private.find_eligible_identities_by_email(t,'  SHARED@Example.TEST  ')=d,'J.N query normalization yields the identical match set';

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

 -- J (cont.): (F/H) once linked, the exact-email lookup returns no eligible identity for THIS tenant —
 -- indistinguishable from an unknown/inactive email. (G) exclusion is strictly per-tenant: the same email
 -- still resolves for a foreign tenant where the identity is not yet a member, and the minimal projection
 -- carries no tenant/membership field, so no cross-tenant membership relationship is ever revealed.
 assert jsonb_array_length(staff_private.find_eligible_identities_by_email(t,'dana@example.test'))=0,'J.F/H linked identity no longer eligible for this tenant';
 d:=staff_private.find_eligible_identities_by_email(ft,'dana@example.test');
 assert jsonb_array_length(d)=1,'J.G exclusion is per-tenant; still eligible for a foreign tenant';
 assert (d->0->>'identityId')=newid::text,'J.G foreign-tenant lookup resolves the same identity';
 assert not (d->0 ? 'tenantId') and not (d->0 ? 'membershipId'),'J.G projection leaks no tenant/membership linkage';

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

 -- Assignment catalogs (Phase 2O completion): the canonical selectable Role / AccessScope sets.
 -- A. authorized staff manager sees eligible CURRENT-TENANT roles.
 cat:=staff_private.list_assignable_roles(t,a,null,101);
 assert jsonb_array_length(cat)>=3,'A the manager has several assignable roles to choose from';
 assert pg_temp.catalog_has(cat,'roleName','Staff Reader'),'A subset role is offered to the manager';
 assert pg_temp.catalog_has(cat,'roleName','Empty Role'),'A permissionless role is a trivial subset and is offered';
 assert (select e->'permissionKeys'=jsonb_build_array('staff.read') from jsonb_array_elements(cat) e
   where e->>'roleName'='Staff Reader'),'A role carries its active permission keys for the picker';
 -- B. a role carrying a permission the caller does NOT hold is absent -- and the write still refuses it,
 -- so the catalog filter is a convenience and never the authorization boundary.
 assert not pg_temp.catalog_has(cat,'roleName','Privileged'),'B escalating role absent from the assignable catalog';
 begin perform staff_private.assign_role(t,a,'catalog-escalate',mem2,privileged,sc,null); raise exception 'expected escalation block';
 exception when sqlstate 'ST403' then null; end;
 -- An archived role is rejected by assign_role, so it is never offered.
 assert not pg_temp.catalog_has(cat,'roleName','Retired Role'),'archived role absent from the assignable catalog';
 -- C. no foreign-tenant role ever appears, in either direction.
 assert not pg_temp.catalog_has(cat,'roleName','Foreign Role'),'C foreign-tenant role absent';
 assert not pg_temp.catalog_has(staff_private.list_assignable_roles(ft,a,null,101),'roleName','Staff Reader'),'C base-tenant role absent from a foreign-tenant read';
 -- Ordering is deterministic (role name ascending) and the keyset cursor continues from it.
 assert pg_temp.catalog_sorted(cat),'role catalog is ordered by name ascending';
 assert staff_private.list_assignable_roles(t,a,null,101)=cat,'repeated role catalog read is stable';
 cat2:=staff_private.list_assignable_roles(t,a,null,2);
 assert jsonb_array_length(cat2)=2,'role catalog honours the page limit';
 assert cat2->0=cat->0 and cat2->1=cat->1,'first role page matches the head of the full ordering';
 cat2:=staff_private.list_assignable_roles(t,a,cat2->1->>'cursorKey',101);
 assert (cat2->0->>'roleName')=(cat->2->>'roleName'),'role keyset cursor resumes after the last row';
 assert not pg_temp.catalog_has(cat2,'roleName',cat->0->>'roleName'),'role keyset cursor never repeats a delivered row';

 -- D. current-tenant scopes are visible with their mode and explicit target summaries.
 cat:=staff_private.list_assignable_scopes(t,null,101);
 assert jsonb_array_length(cat)=4,'D every active current-tenant scope is offered';
 assert pg_temp.catalog_sorted(cat),'scope catalog is ordered by name ascending';
 assert (select e->>'scopeMode'='tenant' and e->'targets'='[]'::jsonb from jsonb_array_elements(cat) e
   where e->>'scopeName'='POS Tenant'),'D tenant-mode scope has no targets by construction';
 -- E. no foreign-tenant scope appears, in either direction.
 assert not pg_temp.catalog_has(cat,'scopeName','Foreign Scope'),'E foreign-tenant scope absent';
 assert not pg_temp.catalog_has(cat,'scopeName','Retired Scope'),'archived scope absent from the assignable catalog';
 -- F. explicit target summaries name the real record and belong only to the scope's own tenant.
 assert (select e->'targets'=jsonb_build_array(jsonb_build_object(
     'kind','branch','id','2a000003-0000-4000-8000-000000000001','name','Main Branch'))
   from jsonb_array_elements(cat) e where e->>'scopeName'='Main Branch'),'F explicit branch target projects its real display name';
 assert (select e->'targets'->0->>'name'='Other Location' and e->'targets'->0->>'kind'='inventory_location'
   from jsonb_array_elements(cat) e where e->>'scopeName'='Other Location'),'F explicit inventory-location target projects its real display name';
 cat2:=staff_private.list_assignable_scopes(ft,null,101);
 assert jsonb_array_length(cat2)=1 and (cat2->0->>'scopeName')='Foreign Scope','E/F foreign tenant sees only its own scope';
 assert (cat2->0->'targets'->0->>'id')='2a000003-0000-4000-8000-0000000000f1'
   and (cat2->0->'targets'->0->>'name')='Foreign Branch','F foreign scope targets stay bound to the foreign tenant';

 -- Historical actor references survive every operation above.
 assert (select status='active' from public.memberships where id=a),'actor membership intact';
 assert (select count(*)=1 from public.membership_role_assignments where id=admin_assignment and unassigned_at is null),'actor admin assignment intact';

 -- Last-admin, two-admin case: with a second tenant-wide staff.manage admin present, the original admin
 -- MAY step down. Promote mem2 with the actor's own admin role (subset check passes: equal permission set).
 perform staff_private.assign_role(t,a,'promote-2',mem2,role_admin,sc,null);
 d:=staff_private.set_staff_status(t,a,'stepdown',a,'deactivated','handover');
 assert d->>'status'='deactivated','admin may step down while another admin satisfies the invariant';
 assert (select status='active' from public.memberships where id=mem2),'the remaining admin is still active';
end $b$;
reset role;
select 'ALL_STAFF_PERSISTENCE_ASSERTIONS_PASSED';
rollback;
