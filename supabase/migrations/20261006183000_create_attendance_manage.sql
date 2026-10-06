-- Phase 2C-D: manager-sanctioned attendance edits + mid-shift leave log.
--
-- (1) Widens the attendance-entry guard so a sanctioned manager path may UPDATE and DELETE entries
--     (the base guard hard-blocked both; clock-out already opens a brief sanctioned window). Manual
--     add/edit/delete flow through new SECURITY DEFINER RPCs that open that window. (2) Adds a leave
--     (mid-shift permission) log mirroring attendance_entries: one open leave per member, duration
--     derived on read. Additive; reuses the attendance_writer role + attendance_private schema.

-- Permit sanctioned UPDATE/DELETE (flag on). Unsanctioned writes are still rejected; direct deletes
-- outside the window remain impossible.
create or replace function attendance_private.forbid_entry_mutation()
returns trigger language plpgsql security invoker set search_path='' as $f$
begin
  if current_user <> 'attendance_writer'
    or current_setting('attendance_private.allow_write', true) is distinct from 'on' then
    raise exception using errcode='42501', message='attendance entries require a sanctioned path';
  end if;
  if tg_op='DELETE' then
    return old;
  end if;
  return new;
end $f$;

-- Manager manual add (p_id null) or edit (p_id set) of an entry. Interval validity is enforced by the
-- table check; the one-open-entry invariant is enforced by the partial unique index (→ AT409).
create function attendance_private.admin_upsert_entry(
  p_tenant_id uuid, p_membership_id uuid, p_branch_id uuid,
  p_clock_in timestamptz, p_clock_out timestamptz, p_id uuid
) returns uuid language plpgsql security definer set search_path='' as $f$
declare v_id uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode='22004', message='tenant is required';
  end if;
  perform set_config('attendance_private.allow_write','on',true);
  if p_id is null then
    if p_membership_id is null or p_clock_in is null then
      raise exception using errcode='22004', message='membership and clock-in are required';
    end if;
    insert into public.attendance_entries(tenant_id, membership_id, branch_id, clock_in, clock_out)
      values (p_tenant_id, p_membership_id, p_branch_id, p_clock_in, p_clock_out)
      returning id into v_id;
  else
    update public.attendance_entries
      set clock_in = coalesce(p_clock_in, clock_in),
          clock_out = p_clock_out,
          branch_id = coalesce(p_branch_id, branch_id),
          updated_at = now()
      where tenant_id = p_tenant_id and id = p_id
      returning id into v_id;
    if v_id is null then
      raise exception using errcode='AE404', message='attendance entry not found';
    end if;
  end if;
  perform set_config('attendance_private.allow_write','off',true);
  return v_id;
exception when unique_violation then
  raise exception using errcode='AT409', message='the member already has an open entry';
end $f$;

create function attendance_private.admin_delete_entry(p_tenant_id uuid, p_id uuid)
returns uuid language plpgsql security definer set search_path='' as $f$
declare v_id uuid;
begin
  perform set_config('attendance_private.allow_write','on',true);
  delete from public.attendance_entries where tenant_id=p_tenant_id and id=p_id returning id into v_id;
  perform set_config('attendance_private.allow_write','off',true);
  if v_id is null then
    raise exception using errcode='AE404', message='attendance entry not found';
  end if;
  return v_id;
end $f$;

-- Mid-shift leave (permission to step out). One open leave per member at a time.
create table public.staff_leave_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  membership_id uuid not null,
  branch_id uuid,
  left_at timestamptz not null default now(),
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_leave_membership_fk foreign key (tenant_id, membership_id)
    references public.memberships (tenant_id, id) on delete restrict,
  constraint staff_leave_branch_fk foreign key (tenant_id, branch_id)
    references public.branches (tenant_id, id) on delete restrict,
  constraint staff_leave_interval_valid check (returned_at is null or returned_at >= left_at),
  constraint staff_leave_tenant_id_unique unique (tenant_id, id)
);
create unique index staff_leave_one_open
  on public.staff_leave_entries (tenant_id, membership_id) where returned_at is null;
create index staff_leave_member_time
  on public.staff_leave_entries (tenant_id, membership_id, left_at desc);
comment on table public.staff_leave_entries is
  'Mid-shift leave permissions. Duration derived from left_at/returned_at on read.';

create function attendance_private.forbid_leave_mutation()
returns trigger language plpgsql security invoker set search_path='' as $f$
begin
  if current_user <> 'attendance_writer'
    or current_setting('attendance_private.allow_write', true) is distinct from 'on' then
    raise exception using errcode='42501', message='leave entries require a sanctioned path';
  end if;
  if tg_op='DELETE' then
    return old;
  end if;
  return new;
end $f$;
create trigger staff_leave_guard before update or delete on public.staff_leave_entries
  for each row execute function attendance_private.forbid_leave_mutation();

create function attendance_private.leave_start(p_tenant_id uuid, p_membership_id uuid, p_branch_id uuid)
returns uuid language plpgsql security definer set search_path='' as $f$
declare v_id uuid;
begin
  if p_tenant_id is null or p_membership_id is null then
    raise exception using errcode='22004', message='leave fields are required';
  end if;
  if exists(select 1 from public.staff_leave_entries e
    where e.tenant_id=p_tenant_id and e.membership_id=p_membership_id and e.returned_at is null) then
    raise exception using errcode='LV409', message='already on leave';
  end if;
  insert into public.staff_leave_entries(tenant_id,membership_id,branch_id)
    values(p_tenant_id,p_membership_id,p_branch_id) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception using errcode='LV409', message='already on leave';
end $f$;

create function attendance_private.leave_end(p_tenant_id uuid, p_membership_id uuid)
returns uuid language plpgsql security definer set search_path='' as $f$
declare v_id uuid;
begin
  if p_tenant_id is null or p_membership_id is null then
    raise exception using errcode='22004', message='leave fields are required';
  end if;
  select e.id into v_id from public.staff_leave_entries e
    where e.tenant_id=p_tenant_id and e.membership_id=p_membership_id and e.returned_at is null
    order by e.left_at desc limit 1;
  if v_id is null then
    raise exception using errcode='LV404', message='not on leave';
  end if;
  perform set_config('attendance_private.allow_write','on',true);
  update public.staff_leave_entries set returned_at=now(), updated_at=now()
    where tenant_id=p_tenant_id and id=v_id;
  perform set_config('attendance_private.allow_write','off',true);
  return v_id;
end $f$;

grant create on schema public to attendance_writer;
alter table public.staff_leave_entries owner to attendance_writer;
alter function attendance_private.forbid_leave_mutation() owner to attendance_writer;
alter function attendance_private.admin_upsert_entry(uuid,uuid,uuid,timestamptz,timestamptz,uuid) owner to attendance_writer;
alter function attendance_private.admin_delete_entry(uuid,uuid) owner to attendance_writer;
alter function attendance_private.leave_start(uuid,uuid,uuid) owner to attendance_writer;
alter function attendance_private.leave_end(uuid,uuid) owner to attendance_writer;
revoke create on schema public from attendance_writer;

revoke all on function attendance_private.admin_upsert_entry(uuid,uuid,uuid,timestamptz,timestamptz,uuid) from public;
revoke all on function attendance_private.admin_delete_entry(uuid,uuid) from public;
revoke all on function attendance_private.leave_start(uuid,uuid,uuid) from public;
revoke all on function attendance_private.leave_end(uuid,uuid) from public;

alter table public.staff_leave_entries enable row level security;
revoke all on table public.staff_leave_entries from public;

do $b$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on table public.staff_leave_entries from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on table public.staff_leave_entries from authenticated';
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select on table public.staff_leave_entries to service_role';
    execute 'grant execute on function attendance_private.admin_upsert_entry(uuid,uuid,uuid,timestamptz,timestamptz,uuid) to service_role';
    execute 'grant execute on function attendance_private.admin_delete_entry(uuid,uuid) to service_role';
    execute 'grant execute on function attendance_private.leave_start(uuid,uuid,uuid) to service_role';
    execute 'grant execute on function attendance_private.leave_end(uuid,uuid) to service_role';
  end if;
end $b$;
