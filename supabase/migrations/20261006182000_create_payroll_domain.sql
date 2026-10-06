-- Phase 2C-D: payroll/compensation domain.
--
-- Builds the tenant-owned compensation model the attendance entries feed into: a current
-- compensation row per member (monthly base + per-hour overtime rate + a normal-hours threshold),
-- dated bonus/deduction adjustments, and tenant payroll settings (normal-hours default + the
-- shift-duration divisor used to express worked hours as days). Net pay is computed on read (see the
-- payroll read migration) and never stored. Money is integer minor units. This is additive and reuses
-- the attendance_writer role + attendance_private schema created by the base attendance migration.

insert into public.permissions(key,description) values
 ('attendance.manage','Manage attendance entries, member compensation and pay adjustments.')
on conflict(key) do nothing;

-- One current compensation row per member. Mutable (upsert); historical effective-dating is deferred.
create table public.employee_compensation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  membership_id uuid not null,
  base_salary_minor bigint not null default 0,
  overtime_rate_minor bigint not null default 0,
  normal_hours numeric(8,2) not null default 0,
  currency text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_compensation_membership_fk foreign key (tenant_id, membership_id)
    references public.memberships (tenant_id, id) on delete restrict,
  constraint employee_compensation_amounts_nonneg
    check (base_salary_minor >= 0 and overtime_rate_minor >= 0 and normal_hours >= 0),
  constraint employee_compensation_currency_valid check (currency ~ '^[A-Z]{3}$'),
  constraint employee_compensation_member_unique unique (tenant_id, membership_id),
  constraint employee_compensation_tenant_id_unique unique (tenant_id, id)
);
comment on table public.employee_compensation is
  'Current monthly base + per-hour overtime rate + normal-hours threshold per member. Minor units.';

-- Dated bonus/deduction adjustments that add to / subtract from computed pay.
create table public.employee_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  membership_id uuid not null,
  type text not null,
  amount_minor bigint not null,
  reason text,
  effective_date date not null default current_date,
  hours numeric(8,2),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_adjustments_membership_fk foreign key (tenant_id, membership_id)
    references public.memberships (tenant_id, id) on delete restrict,
  constraint employee_adjustments_actor_fk foreign key (tenant_id, created_by)
    references public.memberships (tenant_id, id) on delete set null,
  constraint employee_adjustments_type_valid check (type in ('bonus','deduction')),
  constraint employee_adjustments_amount_positive check (amount_minor >= 0),
  constraint employee_adjustments_hours_nonneg check (hours is null or hours >= 0),
  constraint employee_adjustments_tenant_id_unique unique (tenant_id, id)
);
create index employee_adjustments_member_date
  on public.employee_adjustments (tenant_id, membership_id, effective_date desc);
create index employee_adjustments_tenant_date
  on public.employee_adjustments (tenant_id, effective_date desc, id desc);

-- Tenant singleton payroll settings.
create table public.payroll_settings (
  tenant_id uuid primary key references public.tenants(id) on delete restrict,
  normal_hours numeric(8,2) not null default 0,
  shift_duration_hours numeric(6,2) not null default 9,
  updated_at timestamptz not null default now(),
  constraint payroll_settings_values_valid check (normal_hours >= 0 and shift_duration_hours > 0)
);

create function attendance_private.set_compensation(
  p_tenant_id uuid, p_membership_id uuid, p_base_minor bigint,
  p_ot_rate_minor bigint, p_normal_hours numeric, p_currency text
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_row public.employee_compensation;
begin
  if p_tenant_id is null or p_membership_id is null or p_currency is null then
    raise exception using errcode='22004', message='compensation fields are required';
  end if;
  insert into public.employee_compensation
    (tenant_id, membership_id, base_salary_minor, overtime_rate_minor, normal_hours, currency)
  values (p_tenant_id, p_membership_id, coalesce(p_base_minor,0), coalesce(p_ot_rate_minor,0),
          coalesce(p_normal_hours,0), upper(p_currency))
  on conflict (tenant_id, membership_id) do update
    set base_salary_minor=excluded.base_salary_minor,
        overtime_rate_minor=excluded.overtime_rate_minor,
        normal_hours=excluded.normal_hours,
        currency=excluded.currency,
        updated_at=now()
  returning * into v_row;
  return jsonb_build_object(
    'membershipId', v_row.membership_id, 'baseSalaryMinor', v_row.base_salary_minor,
    'overtimeRateMinor', v_row.overtime_rate_minor, 'normalHours', v_row.normal_hours,
    'currency', v_row.currency, 'updatedAt', v_row.updated_at);
end $f$;

create function attendance_private.upsert_payroll_settings(
  p_tenant_id uuid, p_normal_hours numeric, p_shift_hours numeric
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_row public.payroll_settings;
begin
  if p_tenant_id is null then
    raise exception using errcode='22004', message='tenant is required';
  end if;
  insert into public.payroll_settings (tenant_id, normal_hours, shift_duration_hours)
  values (p_tenant_id, coalesce(p_normal_hours,0), coalesce(nullif(p_shift_hours,0),9))
  on conflict (tenant_id) do update
    set normal_hours=excluded.normal_hours,
        shift_duration_hours=excluded.shift_duration_hours,
        updated_at=now()
  returning * into v_row;
  return jsonb_build_object(
    'normalHours', v_row.normal_hours, 'shiftDurationHours', v_row.shift_duration_hours);
end $f$;

create function attendance_private.add_adjustment(
  p_tenant_id uuid, p_membership_id uuid, p_type text, p_amount_minor bigint,
  p_reason text, p_date date, p_hours numeric, p_actor uuid
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_row public.employee_adjustments;
begin
  if p_tenant_id is null or p_membership_id is null or p_type is null or p_amount_minor is null then
    raise exception using errcode='22004', message='adjustment fields are required';
  end if;
  insert into public.employee_adjustments
    (tenant_id, membership_id, type, amount_minor, reason, effective_date, hours, created_by)
  values (p_tenant_id, p_membership_id, p_type, p_amount_minor, p_reason,
          coalesce(p_date, current_date), p_hours, p_actor)
  returning * into v_row;
  return (
    select jsonb_build_object(
      'id', v_row.id, 'membershipId', v_row.membership_id, 'memberDisplayName', ui.display_name,
      'type', v_row.type, 'amountMinor', v_row.amount_minor, 'reason', v_row.reason,
      'effectiveDate', v_row.effective_date, 'hours', v_row.hours, 'createdAt', v_row.created_at)
    from public.memberships m
    left join public.user_identities ui on ui.id = m.user_identity_id
    where m.tenant_id = v_row.tenant_id and m.id = v_row.membership_id);
end $f$;

create function attendance_private.remove_adjustment(p_tenant_id uuid, p_id uuid)
returns uuid language plpgsql security definer set search_path='' as $f$
declare v_id uuid;
begin
  delete from public.employee_adjustments where tenant_id=p_tenant_id and id=p_id returning id into v_id;
  if v_id is null then
    raise exception using errcode='AD404', message='adjustment not found';
  end if;
  return v_id;
end $f$;

grant create on schema public to attendance_writer;
alter table public.employee_compensation owner to attendance_writer;
alter table public.employee_adjustments owner to attendance_writer;
alter table public.payroll_settings owner to attendance_writer;
alter function attendance_private.set_compensation(uuid,uuid,bigint,bigint,numeric,text) owner to attendance_writer;
alter function attendance_private.upsert_payroll_settings(uuid,numeric,numeric) owner to attendance_writer;
alter function attendance_private.add_adjustment(uuid,uuid,text,bigint,text,date,numeric,uuid) owner to attendance_writer;
alter function attendance_private.remove_adjustment(uuid,uuid) owner to attendance_writer;
revoke create on schema public from attendance_writer;

revoke all on function attendance_private.set_compensation(uuid,uuid,bigint,bigint,numeric,text) from public;
revoke all on function attendance_private.upsert_payroll_settings(uuid,numeric,numeric) from public;
revoke all on function attendance_private.add_adjustment(uuid,uuid,text,bigint,text,date,numeric,uuid) from public;
revoke all on function attendance_private.remove_adjustment(uuid,uuid) from public;

alter table public.employee_compensation enable row level security;
alter table public.employee_adjustments enable row level security;
alter table public.payroll_settings enable row level security;
revoke all on table public.employee_compensation, public.employee_adjustments, public.payroll_settings from public;

do $b$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on table public.employee_compensation, public.employee_adjustments, public.payroll_settings from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on table public.employee_compensation, public.employee_adjustments, public.payroll_settings from authenticated';
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select on table public.employee_compensation, public.employee_adjustments, public.payroll_settings to service_role';
    execute 'grant execute on function attendance_private.set_compensation(uuid,uuid,bigint,bigint,numeric,text) to service_role';
    execute 'grant execute on function attendance_private.upsert_payroll_settings(uuid,numeric,numeric) to service_role';
    execute 'grant execute on function attendance_private.add_adjustment(uuid,uuid,text,bigint,text,date,numeric,uuid) to service_role';
    execute 'grant execute on function attendance_private.remove_adjustment(uuid,uuid) to service_role';
  end if;
end $b$;
