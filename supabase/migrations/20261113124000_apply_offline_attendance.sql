-- A received offline clock event is applied to canonical attendance in the same transaction.
-- Older commands still clock the grant operator; newer commands can name a team member.
alter table public.offline_attendance_ingestions
  add column target_membership_id uuid,
  add column attendance_entry_id uuid;
alter table public.offline_attendance_ingestions
  drop constraint offline_attendance_ingestions_adjudication,
  add constraint offline_attendance_ingestions_adjudication
    check (adjudication_status in ('pending_policy', 'applied')),
  add constraint offline_attendance_ingestions_target_fk
    foreign key (tenant_id, target_membership_id) references public.memberships(tenant_id, id),
  add constraint offline_attendance_ingestions_entry_fk
    foreign key (tenant_id, attendance_entry_id) references public.attendance_entries(tenant_id, id);

drop trigger offline_attendance_ingestions_immutable on public.offline_attendance_ingestions;
create trigger offline_attendance_ingestions_immutable
  before update of tenant_id, grant_id, device_id, credential_id, register_id, branch_id,
    operator_membership_id, target_membership_id, local_event_id, sync_command_id,
    command_fingerprint, canonical_command, device_signature_base64, event_type,
    event_at, accepted_at, received_at, sync_status, created_at
  or delete on public.offline_attendance_ingestions for each row
  execute function offline_pos_private.forbid_immutable_mutation();

create function attendance_private.apply_offline_event(
  p_tenant_id uuid, p_membership_id uuid, p_branch_id uuid, p_event_type text, p_event_at timestamptz
) returns uuid language plpgsql security definer set search_path='' as $f$
declare v_id uuid; v_clock_in timestamptz;
begin
  perform 1 from public.memberships m
    where m.tenant_id=p_tenant_id and m.id=p_membership_id and m.status='active';
  if not found then raise exception using errcode='AT404', message='staff member is not active'; end if;
  -- Serialize clock actions for one member, including commands from multiple registers.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || p_membership_id::text, 0));
  select e.id, e.clock_in into v_id, v_clock_in from public.attendance_entries e
    where e.tenant_id=p_tenant_id and e.membership_id=p_membership_id and e.clock_out is null
    order by e.clock_in desc limit 1;
  if p_event_type='clock_in' then
    if v_id is not null then raise exception using errcode='AT409', message='already clocked in'; end if;
    insert into public.attendance_entries(tenant_id, membership_id, branch_id, clock_in)
      values(p_tenant_id, p_membership_id, p_branch_id, p_event_at) returning id into v_id;
  elsif p_event_type='clock_out' then
    if v_id is null or p_event_at < v_clock_in then
      raise exception using errcode='AT404', message='no matching earlier clock-in';
    end if;
    perform pg_catalog.set_config('attendance_private.allow_write','on',true);
    update public.attendance_entries set clock_out=p_event_at, updated_at=now()
      where tenant_id=p_tenant_id and id=v_id;
    perform pg_catalog.set_config('attendance_private.allow_write','off',true);
  else
    raise exception using errcode='22023', message='invalid clock event';
  end if;
  return v_id;
end $f$;
grant create on schema attendance_private to attendance_writer;
alter function attendance_private.apply_offline_event(uuid,uuid,uuid,text,timestamptz) owner to attendance_writer;
revoke create on schema attendance_private from attendance_writer;
revoke all on function attendance_private.apply_offline_event(uuid,uuid,uuid,text,timestamptz) from public;
grant usage on schema attendance_private to offline_pos_writer;
grant execute on function attendance_private.apply_offline_event(uuid,uuid,uuid,text,timestamptz) to offline_pos_writer;

-- Team attribution requires the grant operator's current tenant-wide attendance.manage grant.
-- staff_writer already has the narrowly scoped RBAC read policies used by staff management.
create function staff_private.can_manage_attendance(p_tenant uuid,p_member uuid)
returns boolean language sql stable security definer set search_path='' as $f$
  select exists (
    select 1 from public.memberships m
    join public.membership_role_assignments a on a.tenant_id=m.tenant_id and a.membership_id=m.id
    join public.roles r on r.tenant_id=a.tenant_id and r.id=a.role_id
    join public.access_scopes s on s.tenant_id=a.tenant_id and s.id=a.access_scope_id
    join public.role_permissions rp on rp.tenant_id=r.tenant_id and rp.role_id=r.id
    join public.permissions p on p.id=rp.permission_id
    where m.tenant_id=p_tenant and m.id=p_member and m.status='active'
      and a.unassigned_at is null and r.status='active' and s.status='active'
      and s.scope_mode='tenant' and p.status='active' and p.key='attendance.manage'
  );
$f$;
grant create on schema staff_private to staff_writer;
alter function staff_private.can_manage_attendance(uuid,uuid) owner to staff_writer;
revoke create on schema staff_private from staff_writer;
revoke all on function staff_private.can_manage_attendance(uuid,uuid) from public;
grant usage on schema staff_private to offline_pos_writer;
grant execute on function staff_private.can_manage_attendance(uuid,uuid) to offline_pos_writer;

drop function offline_pos_private.record_offline_attendance(uuid,uuid,jsonb,text,text,text);
create function offline_pos_private.record_offline_attendance(
  p_tenant_id uuid, p_credential_id uuid, p_command jsonb, p_canonical text, p_fingerprint text, p_signature text
) returns table(ingestion_id uuid, sync_status text, adjudication_status text, membership_id uuid, event_type text, event_at timestamptz, received_at timestamptz)
language plpgsql security definer set search_path='' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_attendance_ingestions%rowtype;
  v_received timestamptz := now(); v_accepted timestamptz; v_event_at timestamptz;
  v_sync uuid; v_ingestion uuid; v_operator uuid; v_member uuid; v_entry uuid;
begin
  v_sync := (p_command->>'syncCommandId')::uuid;
  select * into v_existing from public.offline_attendance_ingestions
    where tenant_id=p_tenant_id and sync_command_id=v_sync for update;
  if found then
    if v_existing.command_fingerprint <> p_fingerprint then
      raise exception using errcode='ID409', message='offline idempotency conflict';
    end if;
    if v_existing.adjudication_status='pending_policy' then
      v_entry := attendance_private.apply_offline_event(p_tenant_id,
        coalesce(v_existing.target_membership_id,v_existing.operator_membership_id),
        v_existing.branch_id,v_existing.event_type,v_existing.event_at);
      update public.offline_attendance_ingestions set adjudication_status='applied', attendance_entry_id=v_entry
        where tenant_id=p_tenant_id and id=v_existing.id;
      v_existing.adjudication_status := 'applied';
    end if;
    return query select v_existing.id, v_existing.sync_status, v_existing.adjudication_status,
      coalesce(v_existing.target_membership_id,v_existing.operator_membership_id),
      v_existing.event_type, v_existing.event_at, v_existing.received_at;
    return;
  end if;
  select * into v_grant from public.offline_grants
    where tenant_id=p_tenant_id and id=(p_command->>'grantId')::uuid;
  if not found then raise exception using errcode='OG404', message='grant not found'; end if;
  if (p_command->>'deviceId')::uuid <> v_grant.device_id
    or (p_command->>'registerId')::uuid <> v_grant.register_id then
    raise exception using errcode='OG403', message='grant binding mismatch';
  end if;
  if (p_command->>'schemaVersion')::integer <> v_grant.schema_version then
    raise exception using errcode='OG422', message='schema version unsupported';
  end if;
  v_accepted := (p_command->>'acceptedAt')::timestamptz;
  if v_accepted < v_grant.issued_at - interval '5 minutes'
    or v_accepted > v_grant.accepted_until
    or v_accepted > v_received + interval '5 minutes' then
    raise exception using errcode='OG410', message='acceptedAt outside grant authority';
  end if;
  v_event_at := (p_command->>'eventAt')::timestamptz;
  if v_event_at < v_grant.issued_at - interval '5 minutes'
    or v_event_at > v_received + interval '5 minutes' then
    raise exception using errcode='OG410', message='eventAt outside grant authority';
  end if;
  perform 1 from public.device_credentials c
    where c.tenant_id=p_tenant_id and c.id=p_credential_id and c.device_id=v_grant.device_id
      and c.valid_from<=v_accepted and (c.valid_to is null or c.valid_to>=v_accepted);
  if not found then raise exception using errcode='OS401', message='credential not valid at acceptance'; end if;
  v_operator := (p_command->>'operatorMembershipId')::uuid;
  if v_operator <> v_grant.operator_membership_id then
    raise exception using errcode='OG403', message='operator does not match grant';
  end if;
  v_member := coalesce((p_command->>'membershipId')::uuid,v_operator);
  if v_member <> v_operator and not staff_private.can_manage_attendance(p_tenant_id,v_operator) then
    raise exception using errcode='OG403', message='team attendance permission denied';
  end if;
  -- A stale roster is checked inside apply_offline_event under attendance_writer's membership policy.
  v_entry := attendance_private.apply_offline_event(p_tenant_id,v_member,v_grant.branch_id,
    p_command->>'eventType',v_event_at);
  insert into public.offline_attendance_ingestions(
    tenant_id,grant_id,device_id,credential_id,register_id,branch_id,operator_membership_id,
    target_membership_id,local_event_id,sync_command_id,command_fingerprint,canonical_command,
    device_signature_base64,event_type,event_at,accepted_at,adjudication_status,attendance_entry_id)
  values(p_tenant_id,v_grant.id,v_grant.device_id,p_credential_id,v_grant.register_id,v_grant.branch_id,
    v_operator,v_member,p_command->>'localEventId',v_sync,p_fingerprint,p_canonical,p_signature,
    p_command->>'eventType',v_event_at,v_accepted,'applied',v_entry)
  returning id into v_ingestion;
  return query select v_ingestion,'received'::text,'applied'::text,v_member,
    p_command->>'eventType',v_event_at,v_received;
exception when unique_violation then
  select * into v_existing from public.offline_attendance_ingestions
    where tenant_id=p_tenant_id and sync_command_id=v_sync;
  if not found or v_existing.command_fingerprint <> p_fingerprint then
    raise exception using errcode='ID409', message='offline idempotency conflict';
  end if;
  return query select v_existing.id,v_existing.sync_status,v_existing.adjudication_status,
    coalesce(v_existing.target_membership_id,v_existing.operator_membership_id),
    v_existing.event_type,v_existing.event_at,v_existing.received_at;
end $function$;
grant create on schema offline_pos_private to offline_pos_writer;
alter function offline_pos_private.record_offline_attendance(uuid,uuid,jsonb,text,text,text) owner to offline_pos_writer;
revoke create on schema offline_pos_private from offline_pos_writer;
revoke all on function offline_pos_private.record_offline_attendance(uuid,uuid,jsonb,text,text,text) from public;
grant execute on function offline_pos_private.record_offline_attendance(uuid,uuid,jsonb,text,text,text) to service_role;
