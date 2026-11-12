-- Phase 9 (Decision C) — offline attendance capture: APPEND-ONLY, PROVISIONAL.
--
-- Records an immutable, signed clock event (clock-in / clock-out) that a till captured while OFFLINE and
-- synced later. It mirrors the offline-sale ingestion ownership / RLS / idempotency pattern exactly, but
-- it deliberately does the LEAST the owner has approved:
--   * It stores the event in a dedicated append-only ingestion table keyed to syncCommandId.
--   * It NEVER touches public.attendance_entries, computes payroll, attributes shifts, applies grace
--     periods / rounding, or resolves clock_in/clock_out pairing. Those are open owner policy decisions
--     (roadmap §15.5 C-i and payroll). The event is received as `pending_policy` for later adjudication.
--   * Append-only cannot oversell, so there is no reconciliation branch.
-- This keeps the slice honest: a provisional, auditable, exactly-once signed event — not final payroll.

create table public.offline_attendance_ingestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  grant_id uuid not null,
  device_id uuid not null,
  credential_id uuid not null,
  register_id uuid not null,
  branch_id uuid,
  operator_membership_id uuid not null,
  local_event_id text not null,
  sync_command_id uuid not null,
  command_fingerprint text not null,
  canonical_command text not null,
  device_signature_base64 text not null,
  event_type text not null,
  -- Device-observed clock time, trusted only within the bounded grant window + 5-minute skew allowance.
  event_at timestamptz not null,
  accepted_at timestamptz not null,
  received_at timestamptz not null default now(),
  -- Always 'received' in V1 — the server acknowledges durable receipt, not payroll finality.
  sync_status text not null default 'received',
  -- Always 'pending_policy' in V1 — payroll attribution / correction rules are an open owner decision.
  adjudication_status text not null default 'pending_policy',
  created_at timestamptz not null default now(),
  constraint offline_attendance_ingestions_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_attendance_ingestions_grant_fk foreign key (tenant_id, grant_id) references public.offline_grants(tenant_id, id) on delete restrict,
  constraint offline_attendance_ingestions_device_fk foreign key (tenant_id, device_id) references public.devices(tenant_id, id) on delete restrict,
  constraint offline_attendance_ingestions_credential_fk foreign key (tenant_id, credential_id) references public.device_credentials(tenant_id, id) on delete restrict,
  constraint offline_attendance_ingestions_member_fk foreign key (tenant_id, operator_membership_id) references public.memberships(tenant_id, id) on delete restrict,
  constraint offline_attendance_ingestions_event_type check (event_type in ('clock_in', 'clock_out')),
  constraint offline_attendance_ingestions_status check (sync_status = 'received'),
  constraint offline_attendance_ingestions_adjudication check (adjudication_status = 'pending_policy'),
  constraint offline_attendance_ingestions_fingerprint check (command_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint offline_attendance_ingestions_local_not_blank check (btrim(local_event_id) <> ''),
  constraint offline_attendance_ingestions_tenant_id_unique unique (tenant_id, id),
  constraint offline_attendance_ingestions_sync_unique unique (tenant_id, sync_command_id),
  constraint offline_attendance_ingestions_local_unique unique (tenant_id, device_id, local_event_id)
);

create index offline_attendance_ingestions_member_time
  on public.offline_attendance_ingestions (tenant_id, operator_membership_id, event_at desc);

comment on table public.offline_attendance_ingestions is
  'Append-only, replay-safe signed offline clock events. Provisional (received/pending_policy); never payroll-final and never mutates attendance_entries.';
comment on column public.offline_attendance_ingestions.event_at is
  'Device-observed clock time trusted only within the bounded server-issued grant window and five-minute skew allowance.';

-- Reuse the existing offline immutability guard so a stored event can never be edited or deleted.
create trigger offline_attendance_ingestions_immutable before update or delete
  on public.offline_attendance_ingestions for each row
  execute function offline_pos_private.forbid_immutable_mutation();

-- Ingestion RPC. Idempotent by (tenant, syncCommandId) with a fingerprint equality check (exact replay
-- returns the original; changed intent under the same key → ID409). Validates grant binding, schema
-- version, acceptedAt + eventAt skew windows, and credential-validity-at-acceptance — the same authority
-- checks the offline sale makes — then appends the event. No payroll effect.
create function offline_pos_private.record_offline_attendance(
  p_tenant_id uuid, p_credential_id uuid, p_command jsonb, p_canonical text, p_fingerprint text, p_signature text
) returns table(ingestion_id uuid, sync_status text, membership_id uuid, event_type text, event_at timestamptz, received_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_attendance_ingestions%rowtype;
  v_received timestamptz := now(); v_accepted timestamptz; v_event_at timestamptz; v_sync uuid; v_ingestion uuid; v_member uuid;
begin
  v_sync := (p_command->>'syncCommandId')::uuid;
  select * into v_existing from public.offline_attendance_ingestions where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if found then
    if v_existing.command_fingerprint <> p_fingerprint then raise exception using errcode = 'ID409', message = 'offline idempotency conflict'; end if;
    return query select v_existing.id, v_existing.sync_status, v_existing.operator_membership_id, v_existing.event_type, v_existing.event_at, v_existing.received_at; return;
  end if;
  select * into v_grant from public.offline_grants where tenant_id = p_tenant_id and id = (p_command->>'grantId')::uuid;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;
  if (p_command->>'deviceId')::uuid <> v_grant.device_id or (p_command->>'registerId')::uuid <> v_grant.register_id then
    raise exception using errcode = 'OG403', message = 'grant binding mismatch';
  end if;
  if (p_command->>'schemaVersion')::integer <> v_grant.schema_version then raise exception using errcode = 'OG422', message = 'schema version unsupported'; end if;
  v_accepted := (p_command->>'acceptedAt')::timestamptz;
  if v_accepted < v_grant.issued_at - interval '5 minutes' or v_accepted > v_grant.accepted_until or v_accepted > v_received + interval '5 minutes' then
    raise exception using errcode = 'OG410', message = 'acceptedAt outside grant authority';
  end if;
  v_event_at := (p_command->>'eventAt')::timestamptz;
  -- The clock time itself must sit within the bounded authority window (anti clock-rollback / future skew).
  if v_event_at < v_grant.issued_at - interval '5 minutes' or v_event_at > v_received + interval '5 minutes' then
    raise exception using errcode = 'OG410', message = 'eventAt outside grant authority';
  end if;
  perform 1 from public.device_credentials c
    where c.tenant_id = p_tenant_id and c.id = p_credential_id and c.device_id = v_grant.device_id
      and c.valid_from <= v_accepted and (c.valid_to is null or c.valid_to >= v_accepted);
  if not found then raise exception using errcode = 'OS401', message = 'credential not valid at acceptance'; end if;
  -- Membership existence is enforced by offline_attendance_ingestions_member_fk (same approach as
  -- issue_grant's operator FK), so no separate RLS-sensitive read of public.memberships is needed.
  v_member := (p_command->>'operatorMembershipId')::uuid;
  insert into public.offline_attendance_ingestions(
    tenant_id, grant_id, device_id, credential_id, register_id, branch_id, operator_membership_id,
    local_event_id, sync_command_id, command_fingerprint, canonical_command, device_signature_base64,
    event_type, event_at, accepted_at)
  values(p_tenant_id, v_grant.id, v_grant.device_id, p_credential_id, v_grant.register_id, v_grant.branch_id, v_member,
    p_command->>'localEventId', v_sync, p_fingerprint, p_canonical, p_signature,
    p_command->>'eventType', v_event_at, v_accepted) returning id into v_ingestion;
  return query select v_ingestion, 'received'::text, v_member, p_command->>'eventType', v_event_at, v_received;
exception when unique_violation then
  select * into v_existing from public.offline_attendance_ingestions where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if not found or v_existing.command_fingerprint <> p_fingerprint then raise exception using errcode = 'ID409', message = 'offline idempotency conflict'; end if;
  return query select v_existing.id, v_existing.sync_status, v_existing.operator_membership_id, v_existing.event_type, v_existing.event_at, v_existing.received_at;
end;
$function$;

-- Ownership + least-privilege, mirroring the offline-sale / offline-customer-payment writer model.
-- Ownership transfer requires the target role to hold CREATE on each object's schema; the base offline
-- migration grants then revokes this, so re-grant for the duration of these alters and revoke again below
-- (mirrors 20260906120000_create_offline_pos.sql and 20261030150000_offline_customer_payments.sql).
grant create on schema public, offline_pos_private to offline_pos_writer;
alter table public.offline_attendance_ingestions owner to offline_pos_writer;
alter function offline_pos_private.record_offline_attendance(uuid,uuid,jsonb,text,text,text) owner to offline_pos_writer;
revoke create on schema public, offline_pos_private from offline_pos_writer;

alter table public.offline_attendance_ingestions enable row level security;
-- The SECURITY DEFINER RPC runs as offline_pos_writer (table owner); the explicit all-access policy mirrors
-- offline_writer_payment_ingestions so inserts/reads are permitted while RLS stays enabled for every other role.
create policy offline_writer_attendance_ingestions on public.offline_attendance_ingestions
  for all to offline_pos_writer using (true) with check (true);
revoke all on table public.offline_attendance_ingestions from public;
revoke all on function offline_pos_private.record_offline_attendance(uuid,uuid,jsonb,text,text,text) from public;

do $b$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='anon') then
    execute 'revoke all on table public.offline_attendance_ingestions from anon';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname='authenticated') then
    execute 'revoke all on table public.offline_attendance_ingestions from authenticated';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname='service_role') then
    execute 'grant select on public.offline_attendance_ingestions to service_role';
    execute 'grant execute on function offline_pos_private.record_offline_attendance(uuid,uuid,jsonb,text,text,text) to service_role';
  end if;
end $b$;
