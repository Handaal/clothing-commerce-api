-- Tenant-scoped workforce details. A linked login keeps its global identity unchanged.
alter table public.memberships
  add column staff_display_name text,
  add column staff_position text,
  add column staff_phone text,
  add constraint memberships_staff_display_name_valid
    check (staff_display_name is null or length(staff_display_name) between 1 and 120),
  add constraint memberships_staff_position_valid
    check (staff_position is null or length(staff_position) between 1 and 80),
  add constraint memberships_staff_phone_valid
    check (staff_phone is null or length(staff_phone) between 1 and 30);

grant create on schema staff_private to staff_writer;

create function staff_private.staff_profiles(p_tenant uuid, p_memberships uuid[])
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'membershipId', m.id, 'displayName', coalesce(m.staff_display_name, ui.display_name),
    'position', m.staff_position, 'phone', m.staff_phone
  ) order by m.id), '[]'::jsonb)
  from public.memberships m
  join public.user_identities ui on ui.id = m.user_identity_id
  where m.tenant_id = p_tenant and m.id = any(p_memberships)
$function$;

create function staff_private.set_staff_profile(
  p_tenant uuid, p_actor uuid, p_key text, p_membership uuid,
  p_name text, p_position text, p_phone text
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_position text := nullif(pg_catalog.btrim(coalesce(p_position, '')), '');
  v_phone text := nullif(pg_catalog.btrim(coalesce(p_phone, '')), '');
  v_intent jsonb;
  v_replay jsonb;
  v_response jsonb;
begin
  if p_tenant is null or p_actor is null or p_membership is null
    or pg_catalog.length(v_name) not between 1 and 120
    or pg_catalog.length(coalesce(v_position, '')) > 80
    or pg_catalog.length(coalesce(v_phone, '')) > 30 then
    raise exception using errcode = '22023', message = 'Invalid staff profile';
  end if;
  v_intent := pg_catalog.jsonb_build_object(
    'op', 'set_staff_profile', 'actor', p_actor, 'membership', p_membership,
    'name', v_name, 'position', v_position, 'phone', v_phone
  );
  v_replay := staff_private.begin_command(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  update public.memberships
  set staff_display_name = v_name, staff_position = v_position,
      staff_phone = v_phone, updated_at = pg_catalog.now()
  where tenant_id = p_tenant and id = p_membership and status <> 'deactivated';
  if not found then
    raise exception using errcode = 'ST404', message = 'Staff member not found';
  end if;
  v_response := staff_private.staff_detail_json(p_tenant, p_membership)
    || pg_catalog.jsonb_build_object(
      'displayName', v_name, 'position', v_position, 'phone', v_phone
    );
  return staff_private.finish_command(p_tenant, p_key, v_intent, v_response);
end;
$function$;

alter function staff_private.staff_profiles(uuid,uuid[]) owner to staff_writer;
alter function staff_private.set_staff_profile(uuid,uuid,text,uuid,text,text,text)
  owner to staff_writer;
revoke create on schema staff_private from staff_writer;
revoke all on function staff_private.staff_profiles(uuid,uuid[]) from public, anon, authenticated;
revoke all on function staff_private.set_staff_profile(uuid,uuid,text,uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function staff_private.staff_profiles(uuid,uuid[]) to service_role;
grant execute on function staff_private.set_staff_profile(uuid,uuid,text,uuid,text,text,text)
  to service_role;
