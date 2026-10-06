-- Phase 2C-D: payroll / adjustments / leave read surface.
--
-- Read-only projections for the back-office Staff view. `payroll` computes per-member pay for a date
-- range entirely in SQL from closed attendance entries + current compensation + dated adjustments +
-- tenant payroll settings — nothing is stored. Money stays in integer minor units; hours/days are
-- numeric. `list_adjustments` / `list_leaves` project dated logs with member display joined, and the
-- getters return the current compensation row / payroll settings. All reuse attendance_writer.

-- Payroll rows need the tenant default currency as a fallback; grant the read + expose under RLS.
grant select on public.tenants to attendance_writer;
create policy attendance_writer_tenant_read on public.tenants for select to attendance_writer using (true);

-- Per-member pay for [p_from, p_to] (inclusive calendar dates, matched on clock_in). A member appears
-- if they have compensation, worked a closed entry in range, or carry an adjustment in range.
create function attendance_private.payroll(p_tenant_id uuid, p_from date, p_to date)
returns setof jsonb language sql stable security definer set search_path='' as $f$
  with cand as (
    select membership_id from public.employee_compensation where tenant_id = p_tenant_id
    union
    select membership_id from public.attendance_entries
      where tenant_id = p_tenant_id and clock_out is not null
        and clock_in >= p_from and clock_in < (p_to + 1)
    union
    select membership_id from public.employee_adjustments
      where tenant_id = p_tenant_id and effective_date between p_from and p_to
  ),
  worked as (
    select membership_id, sum(extract(epoch from (clock_out - clock_in)) / 60.0) as minutes
    from public.attendance_entries
    where tenant_id = p_tenant_id and clock_out is not null
      and clock_in >= p_from and clock_in < (p_to + 1)
    group by membership_id
  ),
  adj as (
    select membership_id,
      coalesce(sum(amount_minor) filter (where type = 'bonus'), 0) as bonus_minor,
      coalesce(sum(amount_minor) filter (where type = 'deduction'), 0) as deduction_minor
    from public.employee_adjustments
    where tenant_id = p_tenant_id and effective_date between p_from and p_to
    group by membership_id
  )
  select jsonb_build_object(
    'membershipId', c.membership_id,
    'memberDisplayName', ui.display_name,
    'memberEmail', ui.primary_email,
    'workedMinutes', round(coalesce(w.minutes, 0))::int,
    'workedHours', round(coalesce(w.minutes, 0) / 60.0, 2),
    'workedDays', round((coalesce(w.minutes, 0) / 60.0) / nullif(ps.shift, 0), 1),
    'normalHours', ps.effective_normal,
    'overtimeHours', ps.overtime_hours,
    'baseSalaryMinor', coalesce(comp.base_salary_minor, 0),
    'overtimeRateMinor', coalesce(comp.overtime_rate_minor, 0),
    'overtimeAmountMinor', ps.overtime_amount_minor,
    'bonusMinor', coalesce(a.bonus_minor, 0),
    'deductionMinor', coalesce(a.deduction_minor, 0),
    'netPayMinor', coalesce(comp.base_salary_minor, 0) + ps.overtime_amount_minor
       + coalesce(a.bonus_minor, 0) - coalesce(a.deduction_minor, 0),
    'currency', coalesce(comp.currency, t.default_currency)
  )
  from cand c
  join public.memberships m on m.tenant_id = p_tenant_id and m.id = c.membership_id
  join public.tenants t on t.id = p_tenant_id
  left join public.user_identities ui on ui.id = m.user_identity_id
  left join public.employee_compensation comp
    on comp.tenant_id = p_tenant_id and comp.membership_id = c.membership_id
  left join worked w on w.membership_id = c.membership_id
  left join adj a on a.membership_id = c.membership_id
  cross join lateral (
    select
      coalesce((select shift_duration_hours from public.payroll_settings where tenant_id = p_tenant_id), 9) as shift,
      greatest(coalesce(nullif(comp.normal_hours, 0),
        (select normal_hours from public.payroll_settings where tenant_id = p_tenant_id), 0), 0) as effective_normal
  ) base
  cross join lateral (
    -- Overtime hours are rounded to 2 decimals first; the amount derives from that rounded figure so
    -- the displayed hours and the paid amount always agree (matches cafe-v2) and sub-second clock
    -- drift can never leak a stray minor unit into pay.
    select
      base.shift as shift,
      base.effective_normal as effective_normal,
      round(greatest(0, coalesce(w.minutes, 0) / 60.0 - base.effective_normal), 2) as overtime_hours
  ) oth
  cross join lateral (
    select
      oth.shift as shift,
      oth.effective_normal as effective_normal,
      oth.overtime_hours as overtime_hours,
      round(oth.overtime_hours * coalesce(comp.overtime_rate_minor, 0))::bigint as overtime_amount_minor
  ) ps
  order by coalesce(comp.base_salary_minor, 0) + ps.overtime_amount_minor
    + coalesce(a.bonus_minor, 0) - coalesce(a.deduction_minor, 0) desc,
    ui.display_name nulls last, c.membership_id;
$f$;

-- Dated bonus/deduction log, newest first.
create function attendance_private.list_adjustments(p_tenant_id uuid, p_from date, p_to date)
returns setof jsonb language sql stable security definer set search_path='' as $f$
  select jsonb_build_object(
    'id', a.id,
    'membershipId', a.membership_id,
    'memberDisplayName', ui.display_name,
    'type', a.type,
    'amountMinor', a.amount_minor,
    'reason', a.reason,
    'effectiveDate', a.effective_date,
    'hours', a.hours,
    'createdAt', a.created_at
  )
  from public.employee_adjustments a
  join public.memberships m on m.tenant_id = p_tenant_id and m.id = a.membership_id
  left join public.user_identities ui on ui.id = m.user_identity_id
  where a.tenant_id = p_tenant_id and a.effective_date between p_from and p_to
  order by a.effective_date desc, a.created_at desc, a.id desc;
$f$;

-- Mid-shift leave log for a range, newest first; duration derived on read.
create function attendance_private.list_leaves(p_tenant_id uuid, p_from date, p_to date)
returns setof jsonb language sql stable security definer set search_path='' as $f$
  select jsonb_build_object(
    'id', e.id,
    'membershipId', e.membership_id,
    'memberDisplayName', ui.display_name,
    'branchId', e.branch_id,
    'branchName', b.display_name,
    'leftAt', e.left_at,
    'returnedAt', e.returned_at,
    'minutes', case when e.returned_at is null then null
      else floor(extract(epoch from (e.returned_at - e.left_at)) / 60)::int end
  )
  from public.staff_leave_entries e
  join public.memberships m on m.tenant_id = p_tenant_id and m.id = e.membership_id
  left join public.user_identities ui on ui.id = m.user_identity_id
  left join public.branches b on b.tenant_id = p_tenant_id and b.id = e.branch_id
  where e.tenant_id = p_tenant_id and e.left_at >= p_from and e.left_at < (p_to + 1)
  order by e.left_at desc, e.id desc;
$f$;

-- Single enriched leave entry by id — used to render the leave start/end response.
create function attendance_private.get_leave_entry(p_tenant_id uuid, p_id uuid)
returns jsonb language sql stable security definer set search_path='' as $f$
  select jsonb_build_object(
    'id', e.id,
    'membershipId', e.membership_id,
    'memberDisplayName', ui.display_name,
    'branchId', e.branch_id,
    'branchName', b.display_name,
    'leftAt', e.left_at,
    'returnedAt', e.returned_at,
    'minutes', case when e.returned_at is null then null
      else floor(extract(epoch from (e.returned_at - e.left_at)) / 60)::int end
  )
  from public.staff_leave_entries e
  join public.memberships m on m.tenant_id = p_tenant_id and m.id = e.membership_id
  left join public.user_identities ui on ui.id = m.user_identity_id
  left join public.branches b on b.tenant_id = p_tenant_id and b.id = e.branch_id
  where e.tenant_id = p_tenant_id and e.id = p_id;
$f$;

create function attendance_private.get_compensation(p_tenant_id uuid, p_membership_id uuid)
returns jsonb language sql stable security definer set search_path='' as $f$
  select jsonb_build_object(
    'membershipId', comp.membership_id,
    'baseSalaryMinor', comp.base_salary_minor,
    'overtimeRateMinor', comp.overtime_rate_minor,
    'normalHours', comp.normal_hours,
    'currency', comp.currency,
    'updatedAt', comp.updated_at
  )
  from public.employee_compensation comp
  where comp.tenant_id = p_tenant_id and comp.membership_id = p_membership_id;
$f$;

create function attendance_private.get_payroll_settings(p_tenant_id uuid)
returns jsonb language sql stable security definer set search_path='' as $f$
  select jsonb_build_object(
    'normalHours', coalesce((select normal_hours from public.payroll_settings where tenant_id = p_tenant_id), 0),
    'shiftDurationHours', coalesce((select shift_duration_hours from public.payroll_settings where tenant_id = p_tenant_id), 9)
  );
$f$;

alter function attendance_private.payroll(uuid,date,date) owner to attendance_writer;
alter function attendance_private.list_adjustments(uuid,date,date) owner to attendance_writer;
alter function attendance_private.list_leaves(uuid,date,date) owner to attendance_writer;
alter function attendance_private.get_leave_entry(uuid,uuid) owner to attendance_writer;
alter function attendance_private.get_compensation(uuid,uuid) owner to attendance_writer;
alter function attendance_private.get_payroll_settings(uuid) owner to attendance_writer;

revoke all on function attendance_private.get_leave_entry(uuid,uuid) from public;
revoke all on function attendance_private.payroll(uuid,date,date) from public;
revoke all on function attendance_private.list_adjustments(uuid,date,date) from public;
revoke all on function attendance_private.list_leaves(uuid,date,date) from public;
revoke all on function attendance_private.get_compensation(uuid,uuid) from public;
revoke all on function attendance_private.get_payroll_settings(uuid) from public;

do $b$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant execute on function attendance_private.payroll(uuid,date,date) to service_role';
    execute 'grant execute on function attendance_private.list_adjustments(uuid,date,date) to service_role';
    execute 'grant execute on function attendance_private.list_leaves(uuid,date,date) to service_role';
    execute 'grant execute on function attendance_private.get_leave_entry(uuid,uuid) to service_role';
    execute 'grant execute on function attendance_private.get_compensation(uuid,uuid) to service_role';
    execute 'grant execute on function attendance_private.get_payroll_settings(uuid) to service_role';
  end if;
end $b$;
