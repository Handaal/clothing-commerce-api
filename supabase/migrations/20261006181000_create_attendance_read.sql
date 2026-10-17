-- Phase 2C: attendance read surface.
--
-- Read-side companion to 20261006180000_create_attendance.sql. Two SECURITY DEFINER functions project
-- attendance entries enriched with the member's identity display/email and the branch display name, and
-- derive worked minutes on read (clock_out - clock_in, never stored). `my_attendance` serves the
-- signed-in member's own history + current open entry for the POS clock button; `list_attendance` is the
-- tenant-wide, keyset-paginated management read. Both are additive and tenant-owned.

-- The projections read identity display/email; grant that select (memberships + branches were granted by
-- the base migration) and expose it to the attendance_writer role under RLS.
grant select on public.user_identities to attendance_writer;
create policy attendance_writer_identity_read on public.user_identities
  for select to attendance_writer using (true);

-- Canonical per-row projection. Keys are the camelCase names the external contract validates directly.
create function attendance_private.entry_json(e public.attendance_entries)
returns jsonb language sql stable security definer set search_path='' as $f$
  select jsonb_build_object(
    'id', e.id,
    'membershipId', e.membership_id,
    'memberDisplayName', ui.display_name,
    'memberEmail', ui.primary_email,
    'branchId', e.branch_id,
    'branchName', b.display_name,
    'clockIn', e.clock_in,
    'clockOut', e.clock_out,
    'workedMinutes', case when e.clock_out is null then null
      else floor(extract(epoch from (e.clock_out - e.clock_in)) / 60)::int end,
    'createdAt', e.created_at,
    'updatedAt', e.updated_at
  )
  from public.memberships m
  left join public.user_identities ui on ui.id = m.user_identity_id
  left join public.branches b on b.tenant_id = e.tenant_id and b.id = e.branch_id
  where m.tenant_id = e.tenant_id and m.id = e.membership_id;
$f$;

-- Single enriched entry by id, scoped to tenant. Used to render the clock-in/out response.
create function attendance_private.get_entry(p_tenant_id uuid, p_id uuid)
returns jsonb language sql stable security definer set search_path='' as $f$
  select attendance_private.entry_json(e) from public.attendance_entries e
  where e.tenant_id = p_tenant_id and e.id = p_id;
$f$;

-- The signed-in member's own attendance: their current open entry (if any) plus their most recent
-- entries, newest first. Bounded (no cursor) — the POS clock button only needs recent context.
create function attendance_private.my_attendance(p_tenant_id uuid, p_membership_id uuid, p_limit integer)
returns jsonb language sql stable security definer set search_path='' as $f$
  with recent as (
    select e.* from public.attendance_entries e
    where e.tenant_id = p_tenant_id and e.membership_id = p_membership_id
    order by e.clock_in desc, e.id desc
    limit greatest(coalesce(p_limit, 20), 1)
  )
  select jsonb_build_object(
    'openEntry', (
      select attendance_private.entry_json(e) from public.attendance_entries e
      where e.tenant_id = p_tenant_id and e.membership_id = p_membership_id and e.clock_out is null
      order by e.clock_in desc limit 1
    ),
    'entries', coalesce(
      (select jsonb_agg(attendance_private.entry_json(r) order by r.clock_in desc, r.id desc) from recent r),
      '[]'::jsonb)
  );
$f$;

-- Tenant-wide management read, keyset-paginated. The keyset is (clock_in desc, id desc): a page returns
-- rows strictly older than the cursor's (clock_in, id). Optional membership/branch filters narrow it.
create function attendance_private.list_attendance(
  p_tenant_id uuid,
  p_membership_id uuid,
  p_branch_id uuid,
  p_after_clock_in timestamptz,
  p_after_id uuid,
  p_limit integer
) returns setof jsonb language sql stable security definer set search_path='' as $f$
  select attendance_private.entry_json(e)
  from public.attendance_entries e
  where e.tenant_id = p_tenant_id
    and (p_membership_id is null or e.membership_id = p_membership_id)
    and (p_branch_id is null or e.branch_id = p_branch_id)
    and (
      p_after_clock_in is null
      or (e.clock_in, e.id) < (p_after_clock_in, p_after_id)
    )
  order by e.clock_in desc, e.id desc
  limit greatest(coalesce(p_limit, 26), 1);
$f$;

grant create on schema attendance_private to attendance_writer;
alter function attendance_private.entry_json(public.attendance_entries) owner to attendance_writer;
alter function attendance_private.get_entry(uuid, uuid) owner to attendance_writer;
alter function attendance_private.my_attendance(uuid, uuid, integer) owner to attendance_writer;
alter function attendance_private.list_attendance(uuid, uuid, uuid, timestamptz, uuid, integer)
  owner to attendance_writer;
revoke create on schema attendance_private from attendance_writer;

revoke all on function attendance_private.entry_json(public.attendance_entries) from public;
revoke all on function attendance_private.get_entry(uuid, uuid) from public;
revoke all on function attendance_private.my_attendance(uuid, uuid, integer) from public;
revoke all on function attendance_private.list_attendance(uuid, uuid, uuid, timestamptz, uuid, integer)
  from public;

do $b$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select on table public.user_identities to service_role';
    execute 'grant execute on function attendance_private.get_entry(uuid,uuid) to service_role';
    execute 'grant execute on function attendance_private.my_attendance(uuid,uuid,integer) to service_role';
    execute 'grant execute on function attendance_private.list_attendance(uuid,uuid,uuid,timestamptz,uuid,integer) to service_role';
  end if;
end $b$;
