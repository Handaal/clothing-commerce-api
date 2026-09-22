begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

-- Deny-by-default surface -------------------------------------------------------------------------
select is((select count(*) from pg_class where relname='staff_commands' and relrowsecurity),1::bigint,'staff_commands enables RLS');
select ok((select not rolcanlogin and not rolbypassrls from pg_roles where rolname='staff_writer'),'staff_writer is isolated: nologin, never bypassrls');
select is((select count(*) from public.permissions where key in ('staff.read','staff.manage')),2::bigint,'staff permissions seeded');

select ok(not has_table_privilege('anon','public.memberships','SELECT'),'anon cannot read memberships');
select ok(not has_table_privilege('authenticated','public.memberships','INSERT'),'clients cannot create memberships');
select ok(not has_table_privilege('authenticated','public.memberships','UPDATE'),'clients cannot change membership lifecycle');
select ok(not has_table_privilege('authenticated','public.membership_role_assignments','INSERT'),'clients cannot self-assign roles');
select ok(not has_table_privilege('authenticated','public.membership_role_assignments','UPDATE'),'clients cannot rewrite assignments');
select ok(not has_table_privilege('service_role','public.staff_commands','SELECT'),'command intent ledger is private to the writer');

-- Function boundary: transport may invoke entrypoints; clients and internals may not -----------------
select ok(not has_function_privilege('authenticated','staff_private.create_staff(uuid,uuid,text,uuid)','EXECUTE'),'client cannot invoke staff writer');
select ok(has_function_privilege('service_role','staff_private.list_staff(uuid,text,text,uuid,uuid,integer)','EXECUTE'),'transport can list staff');
select ok(has_function_privilege('service_role','staff_private.find_eligible_identities_by_email(uuid,text)','EXECUTE'),'transport can resolve eligible identities by email');
select ok(not has_function_privilege('authenticated','staff_private.find_eligible_identities_by_email(uuid,text)','EXECUTE'),'client cannot enumerate identities directly');
select ok(has_function_privilege('service_role','staff_private.create_staff(uuid,uuid,text,uuid)','EXECUTE'),'transport can create staff');
select ok(has_function_privilege('service_role','staff_private.assign_role(uuid,uuid,text,uuid,uuid,uuid,text)','EXECUTE'),'transport can assign roles');
select ok(has_function_privilege('service_role','staff_private.unassign_role(uuid,uuid,text,uuid,uuid,text)','EXECUTE'),'transport can unassign roles');
select ok(not has_function_privilege('service_role','staff_private.begin_command(uuid,text,jsonb)','EXECUTE'),'idempotency helper is internal only');
select ok(not has_function_privilege('service_role','staff_private.tenant_permission_keys(uuid,uuid)','EXECUTE'),'permission-set helper is internal only');

-- Writer capability is exactly enough, and never destructive -----------------------------------------
select ok(has_table_privilege('staff_writer','public.memberships','INSERT'),'writer can create memberships');
select ok(not has_table_privilege('staff_writer','public.memberships','DELETE'),'writer cannot delete memberships (history preserved)');
select ok(not has_table_privilege('staff_writer','public.membership_role_assignments','DELETE'),'writer cannot delete assignments (history preserved)');
select ok(not has_table_privilege('staff_writer','public.roles','INSERT'),'writer cannot mint roles or escalate the catalog');

-- Assignment catalogs: transport-only reads that add no authoring capability ------------------------
select ok(has_function_privilege('service_role','staff_private.list_assignable_roles(uuid,uuid,text,integer)','EXECUTE'),'transport can read the assignable role catalog');
select ok(has_function_privilege('service_role','staff_private.list_assignable_scopes(uuid,text,integer)','EXECUTE'),'transport can read the assignable scope catalog');
select ok(not has_function_privilege('authenticated','staff_private.list_assignable_roles(uuid,uuid,text,integer)','EXECUTE'),'client cannot read the role catalog directly');
select ok(not has_function_privilege('anon','staff_private.list_assignable_scopes(uuid,text,integer)','EXECUTE'),'anon cannot read the scope catalog directly');
-- Scope-target labels are read from the real records, so the writer gains SELECT there and nothing else.
select ok(has_table_privilege('staff_writer','public.warehouses','SELECT'),'writer can read scope-target records for labels');
select ok(
  not has_table_privilege('staff_writer','public.brands','INSERT')
  and not has_table_privilege('staff_writer','public.branches','UPDATE')
  and not has_table_privilege('staff_writer','public.inventory_locations','DELETE'),
  'scope-target label access is strictly read-only');
-- Role/scope/target AUTHORING remains deferred: the writer can create none of them.
select ok(
  not has_table_privilege('staff_writer','public.access_scopes','INSERT')
  and not has_table_privilege('staff_writer','public.access_scope_targets','INSERT')
  and not has_table_privilege('staff_writer','public.role_permissions','INSERT'),
  'writer cannot author scopes, scope targets or role permissions');

-- Every private entrypoint/helper is a hardened security-definer with an empty search_path.
select is((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='staff_private' and (not p.prosecdef or not p.proconfig @> array['search_path=""'])),0::bigint,'all staff_private functions are hardened');

select * from finish();
rollback;
