-- Team members who never sign in still need a tenant membership for attendance and payroll.
-- Their identity deliberately has no provider binding, login username, or role assignment.
grant create on schema staff_private to staff_writer;
create function staff_private.create_staff_without_login(
  p_tenant uuid, p_actor uuid, p_key text, p_name text
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_intent jsonb;
  v_replay jsonb;
  v_identity uuid;
  v_membership uuid;
  v_response jsonb;
begin
  if p_tenant is null or p_actor is null or pg_catalog.length(v_name) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'Invalid team member';
  end if;
  v_intent := pg_catalog.jsonb_build_object('op','create_without_login','actor',p_actor,'name',v_name);
  v_replay := staff_private.begin_command(p_tenant,p_key,v_intent);
  if v_replay is not null then return v_replay; end if;

  insert into public.user_identities(status,display_name)
    values('active',v_name) returning id into v_identity;
  insert into public.memberships(tenant_id,user_identity_id,status,activated_at)
    values(p_tenant,v_identity,'active',pg_catalog.now()) returning id into v_membership;
  v_response := staff_private.staff_detail_json(p_tenant,v_membership);
  return staff_private.finish_command(p_tenant,p_key,v_intent,v_response);
end;
$function$;
alter function staff_private.create_staff_without_login(uuid,uuid,text,text) owner to staff_writer;
revoke create on schema staff_private from staff_writer;
revoke all on function staff_private.create_staff_without_login(uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function staff_private.create_staff_without_login(uuid,uuid,text,text) to service_role;
