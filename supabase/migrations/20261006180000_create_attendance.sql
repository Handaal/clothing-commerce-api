-- Phase 2C: staff attendance (clock-in / clock-out).
--
-- Self-service time tracking for the workforce: an employee clocks in (opening an entry) and later
-- clocks out (closing it). At most one open entry per member at a time. Worked duration is derived on
-- read, never stored. This is attendance only — payroll, salaries and shift scheduling are separate,
-- later decisions. Tenant-owned and additive; no change to identity, membership or RBAC models.

do $b$ begin
  if not exists(select 1 from pg_roles where rolname='attendance_writer') then
    create role attendance_writer nologin noinherit nobypassrls;
  end if;
  execute format('grant attendance_writer to %I with set true',current_user);
end $b$;

create schema attendance_private;
revoke all on schema attendance_private from public, anon, authenticated;
grant usage on schema public, attendance_private to attendance_writer;

insert into public.permissions(key,description) values
 ('attendance.record','Clock the signed-in member in and out of their own attendance.'),
 ('attendance.read','Read workforce attendance entries and worked-hours across the tenant.')
on conflict(key) do nothing;

create table public.attendance_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  membership_id uuid not null,
  branch_id uuid,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_entries_membership_fk foreign key (tenant_id, membership_id)
    references public.memberships (tenant_id, id) on delete restrict,
  constraint attendance_entries_branch_fk foreign key (tenant_id, branch_id)
    references public.branches (tenant_id, id) on delete restrict,
  constraint attendance_entries_interval_valid check (clock_out is null or clock_out >= clock_in),
  constraint attendance_entries_updated_after_created check (updated_at >= created_at),
  constraint attendance_entries_tenant_id_unique unique (tenant_id, id)
);

-- A member may have at most one open (not-yet-clocked-out) attendance entry.
create unique index attendance_entries_one_open
  on public.attendance_entries (tenant_id, membership_id) where clock_out is null;
create index attendance_entries_member_time
  on public.attendance_entries (tenant_id, membership_id, clock_in desc);

comment on table public.attendance_entries is
  'Staff clock-in/out entries. Worked duration is derived from clock_in/clock_out on read.';

-- Entries are only mutated through the sanctioned clock-in/out functions below.
create function attendance_private.forbid_entry_mutation()
returns trigger language plpgsql security invoker set search_path='' as $f$
begin
  if current_user <> 'attendance_writer'
    or current_setting('attendance_private.allow_write', true) is distinct from 'on' then
    raise exception using errcode='42501', message='attendance entries require sanctioned clock-in/out';
  end if;
  if tg_op='DELETE' then
    raise exception using errcode='42501', message='attendance entries are not deletable';
  end if;
  return new;
end $f$;
create trigger attendance_entries_guard before update or delete on public.attendance_entries
  for each row execute function attendance_private.forbid_entry_mutation();

create function attendance_private.clock_in(p_tenant_id uuid, p_membership_id uuid, p_branch_id uuid)
returns uuid language plpgsql security definer set search_path='' as $f$
declare v_id uuid;
begin
  if p_tenant_id is null or p_membership_id is null then
    raise exception using errcode='22004', message='attendance fields are required';
  end if;
  if exists(select 1 from public.attendance_entries e
    where e.tenant_id=p_tenant_id and e.membership_id=p_membership_id and e.clock_out is null) then
    raise exception using errcode='AT409', message='already clocked in';
  end if;
  insert into public.attendance_entries(tenant_id,membership_id,branch_id)
    values(p_tenant_id,p_membership_id,p_branch_id) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception using errcode='AT409', message='already clocked in';
end $f$;

create function attendance_private.clock_out(p_tenant_id uuid, p_membership_id uuid)
returns uuid language plpgsql security definer set search_path='' as $f$
declare v_id uuid;
begin
  if p_tenant_id is null or p_membership_id is null then
    raise exception using errcode='22004', message='attendance fields are required';
  end if;
  select e.id into v_id from public.attendance_entries e
    where e.tenant_id=p_tenant_id and e.membership_id=p_membership_id and e.clock_out is null
    order by e.clock_in desc limit 1;
  if v_id is null then
    raise exception using errcode='AT404', message='not clocked in';
  end if;
  perform set_config('attendance_private.allow_write','on',true);
  update public.attendance_entries set clock_out=now(), updated_at=now()
    where tenant_id=p_tenant_id and id=v_id;
  perform set_config('attendance_private.allow_write','off',true);
  return v_id;
end $f$;

grant create on schema public, attendance_private to attendance_writer;
alter table public.attendance_entries owner to attendance_writer;
alter function attendance_private.forbid_entry_mutation() owner to attendance_writer;
alter function attendance_private.clock_in(uuid,uuid,uuid) owner to attendance_writer;
alter function attendance_private.clock_out(uuid,uuid) owner to attendance_writer;
revoke create on schema public, attendance_private from attendance_writer;

grant select on public.memberships, public.branches to attendance_writer;
create policy attendance_writer_member_read on public.memberships for select to attendance_writer using (true);
create policy attendance_writer_branch_read on public.branches for select to attendance_writer using (true);

revoke all on function attendance_private.clock_in(uuid,uuid,uuid) from public;
revoke all on function attendance_private.clock_out(uuid,uuid) from public;

alter table public.attendance_entries enable row level security;
revoke all on table public.attendance_entries from public;

do $b$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on table public.attendance_entries from anon';
    execute 'revoke all on schema attendance_private from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on table public.attendance_entries from authenticated';
    execute 'revoke all on schema attendance_private from authenticated';
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select on table public.attendance_entries to service_role';
    execute 'grant usage on schema attendance_private to service_role';
    execute 'grant execute on function attendance_private.clock_in(uuid,uuid,uuid) to service_role';
    execute 'grant execute on function attendance_private.clock_out(uuid,uuid) to service_role';
  end if;
end $b$;
