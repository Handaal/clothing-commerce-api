-- Tenant-wide monthly payroll settlement, separate from the computed attendance/payroll report.
create table public.payroll_cycle_settings (
  tenant_id uuid primary key references public.tenants(id) on delete restrict,
  enabled boolean not null default true,
  anchor_day integer not null default 1 check (anchor_day between 1 and 28),
  updated_at timestamptz not null default now()
);
create table public.payroll_cycle_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  total_minor bigint not null check (total_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_by uuid not null,
  paid_at timestamptz not null default now(),
  notes text,
  unique (tenant_id,period_start),
  foreign key (tenant_id,paid_by) references public.memberships(tenant_id,id) on delete restrict,
  check (period_end >= period_start)
);
alter table public.payroll_cycle_settings enable row level security;
alter table public.payroll_cycle_payments enable row level security;
revoke all on public.payroll_cycle_settings,public.payroll_cycle_payments from public,anon,authenticated,service_role;

grant create on schema public, attendance_private to attendance_writer;
create function attendance_private.get_payroll_cycle_settings(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'enabled',coalesce((select enabled from public.payroll_cycle_settings where tenant_id=p_tenant),true),
    'anchorDay',coalesce((select anchor_day from public.payroll_cycle_settings where tenant_id=p_tenant),1)
  );
$function$;
create function attendance_private.set_payroll_cycle_settings(p_tenant uuid,p_enabled boolean,p_anchor integer)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if p_tenant is null or p_enabled is null or p_anchor not between 1 and 28 then
    raise exception using errcode='22023',message='Invalid payroll cycle settings';
  end if;
  insert into public.payroll_cycle_settings(tenant_id,enabled,anchor_day)
    values(p_tenant,p_enabled,p_anchor)
    on conflict (tenant_id) do update set enabled=excluded.enabled,
      anchor_day=excluded.anchor_day,updated_at=pg_catalog.now();
  return attendance_private.get_payroll_cycle_settings(p_tenant);
end;
$function$;
create function attendance_private.get_payroll_cycle_payment(p_tenant uuid,p_start date)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'id',p.id,'periodStart',p.period_start,'periodEnd',p.period_end,
    'totalMinor',p.total_minor,'currency',p.currency,'paidBy',p.paid_by,
    'paidAt',p.paid_at,'notes',p.notes
  ) from public.payroll_cycle_payments p where p.tenant_id=p_tenant and p.period_start=p_start;
$function$;
create function attendance_private.mark_payroll_cycle_paid(
  p_tenant uuid,p_start date,p_end date,p_total bigint,p_currency text,p_actor uuid,p_notes text
) returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if p_tenant is null or p_actor is null or p_start is null or p_end < p_start
    or p_total <= 0 or p_currency !~ '^[A-Z]{3}$' or pg_catalog.length(coalesce(p_notes,'')) > 500 then
    raise exception using errcode='22023',message='Invalid payroll payment';
  end if;
  insert into public.payroll_cycle_payments(tenant_id,period_start,period_end,total_minor,currency,paid_by,notes)
    values(p_tenant,p_start,p_end,p_total,p_currency,p_actor,p_notes)
    on conflict (tenant_id,period_start) do nothing;
  return attendance_private.get_payroll_cycle_payment(p_tenant,p_start);
end;
$function$;
alter table public.payroll_cycle_settings owner to attendance_writer;
alter table public.payroll_cycle_payments owner to attendance_writer;
alter function attendance_private.get_payroll_cycle_settings(uuid) owner to attendance_writer;
alter function attendance_private.set_payroll_cycle_settings(uuid,boolean,integer) owner to attendance_writer;
alter function attendance_private.get_payroll_cycle_payment(uuid,date) owner to attendance_writer;
alter function attendance_private.mark_payroll_cycle_paid(uuid,date,date,bigint,text,uuid,text) owner to attendance_writer;
revoke create on schema public, attendance_private from attendance_writer;
revoke all on function attendance_private.get_payroll_cycle_settings(uuid),
  attendance_private.set_payroll_cycle_settings(uuid,boolean,integer),
  attendance_private.get_payroll_cycle_payment(uuid,date),
  attendance_private.mark_payroll_cycle_paid(uuid,date,date,bigint,text,uuid,text)
  from public,anon,authenticated;
grant execute on function attendance_private.get_payroll_cycle_settings(uuid),
  attendance_private.set_payroll_cycle_settings(uuid,boolean,integer),
  attendance_private.get_payroll_cycle_payment(uuid,date),
  attendance_private.mark_payroll_cycle_paid(uuid,date,date,bigint,text,uuid,text)
  to service_role;
