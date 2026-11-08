begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

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

-- Email-less login provisioning: transport may invoke it, clients may not; the replay probe is internal-safe.
select ok(has_function_privilege('service_role','staff_private.create_staff_login(uuid,uuid,text,text,text,text,uuid,uuid)','EXECUTE'),'transport can provision an email-less staff login');
select ok(not has_function_privilege('authenticated','staff_private.create_staff_login(uuid,uuid,text,text,text,text,uuid,uuid)','EXECUTE'),'client cannot provision a staff login directly');
select ok(not has_function_privilege('authenticated','staff_private.peek_command(uuid,text)','EXECUTE'),'client cannot probe the idempotency ledger directly');

-- Writer capability is exactly enough, and never destructive -----------------------------------------
select ok(has_table_privilege('staff_writer','public.memberships','INSERT'),'writer can create memberships');
select ok(not has_table_privilege('staff_writer','public.memberships','DELETE'),'writer cannot delete memberships (history preserved)');
select ok(not has_table_privilege('staff_writer','public.membership_role_assignments','DELETE'),'writer cannot delete assignments (history preserved)');
select ok(not has_table_privilege('staff_writer','public.roles','INSERT'),'writer cannot mint roles or escalate the catalog');

-- Login provisioning grants the writer exactly INSERT on the two identity tables (never UPDATE/DELETE),
-- and provider bindings remain unreadable to clients even though the writer can now read/insert them.
select ok(
  has_table_privilege('staff_writer','public.user_identities','INSERT')
  and has_table_privilege('staff_writer','public.user_identity_provider_bindings','INSERT')
  and has_table_privilege('staff_writer','public.user_identity_provider_bindings','SELECT'),
  'writer can create email-less identities and their provider bindings');
select ok(
  not has_table_privilege('staff_writer','public.user_identities','DELETE')
  and not has_table_privilege('staff_writer','public.user_identity_provider_bindings','DELETE')
  and not has_table_privilege('staff_writer','public.user_identity_provider_bindings','UPDATE'),
  'login provisioning is non-destructive: no identity/binding delete or binding rewrite');

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

-- Phase 2O-C: offline-PIN credential store. The sealed-PIN table is deny-by-default and never client-
-- reachable; the transport may set/rotate and read the roster, clients and internals may not.
select is((select count(*) from pg_class where relname='staff_offline_pin_credentials' and relrowsecurity),1::bigint,'staff_offline_pin_credentials enables RLS');
select ok(not has_table_privilege('anon','public.staff_offline_pin_credentials','SELECT'),'anon cannot read sealed offline PINs');
select ok(not has_table_privilege('authenticated','public.staff_offline_pin_credentials','SELECT'),'clients cannot read sealed offline PINs');
select ok(not has_table_privilege('authenticated','public.staff_offline_pin_credentials','INSERT'),'clients cannot set offline PINs directly');
select ok(not has_table_privilege('staff_writer','public.staff_offline_pin_credentials','DELETE'),'writer cannot delete offline PIN credentials (no destructive path)');
select ok(has_function_privilege('service_role','staff_private.set_offline_pin(uuid,uuid,text,uuid,integer,text,text,text,text,integer,integer,integer,integer,integer)','EXECUTE'),'transport can set/rotate an offline PIN');
select ok(not has_function_privilege('authenticated','staff_private.set_offline_pin(uuid,uuid,text,uuid,integer,text,text,text,text,integer,integer,integer,integer,integer)','EXECUTE'),'client cannot set an offline PIN directly');
select ok(has_function_privilege('service_role','staff_private.offline_sell_roster(uuid,uuid)','EXECUTE'),'transport can read the offline-seller roster');
select ok(not has_function_privilege('authenticated','staff_private.offline_sell_roster(uuid,uuid)','EXECUTE'),'client cannot read the offline-seller roster directly');
select ok(not has_function_privilege('service_role','staff_private.covers_permission(uuid,uuid,text,uuid,uuid)','EXECUTE'),'scope-coverage helper is internal only');

-- Every private entrypoint/helper is a hardened security-definer with an empty search_path.
select is((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='staff_private' and (not p.prosecdef or not p.proconfig @> array['search_path=""'])),0::bigint,'all staff_private functions are hardened');

select * from finish();
rollback;
