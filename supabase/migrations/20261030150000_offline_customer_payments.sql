-- Phase D2 — offline customer paydowns.
--
-- A customer installment repayment accepted while OFFLINE (signed with the device key, bound to the
-- active grant) is synced later and applied idempotently through customers_ar_private.record_customer_payment
-- keyed to the command's syncCommandId. Mirrors the offline SALE ingest (record_offline_sale): same grant
-- binding, credential-at-acceptance, and acceptedAt-window checks, plus a dedicated ingestion ledger for
-- idempotent replay. If the paydown exceeds the server's authoritative outstanding (a stale offline view),
-- record_customer_payment raises CA409 and the command is surfaced for reconciliation rather than silently
-- clamped.

create table public.offline_payment_ingestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  grant_id uuid not null,
  device_id uuid not null,
  credential_id uuid not null,
  register_id uuid not null,
  customer_id uuid not null,
  local_payment_id text not null,
  sync_command_id uuid not null,
  command_fingerprint text not null,
  canonical_command text not null,
  device_signature_base64 text not null,
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 9007199254740991),
  server_payment_id uuid not null,
  response jsonb not null,
  accepted_at timestamptz not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, sync_command_id),
  foreign key (tenant_id, customer_id) references public.customers(tenant_id, id) on delete restrict
);
create index offline_payment_ingestions_by_grant
  on public.offline_payment_ingestions (tenant_id, grant_id);

grant execute on function customers_ar_private.record_customer_payment(uuid, uuid, uuid, text, jsonb)
  to offline_pos_writer;

create function offline_pos_private.record_offline_customer_payment(
  p_tenant_id uuid, p_credential_id uuid, p_command jsonb, p_canonical text, p_fingerprint text, p_signature text
)
returns table(ingestion_id uuid, sync_status text, payment jsonb, received_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare
  v_grant public.offline_grants%rowtype;
  v_existing public.offline_payment_ingestions%rowtype;
  v_sync uuid := (p_command->>'syncCommandId')::uuid;
  v_customer uuid := (p_command->>'customerId')::uuid;
  v_amount bigint := (p_command->>'amountMinor')::bigint;
  v_accepted timestamptz := (p_command->>'acceptedAt')::timestamptz;
  v_received timestamptz := now();
  v_payment jsonb;
  v_ingestion uuid;
begin
  select * into v_existing from public.offline_payment_ingestions
    where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if found then
    if v_existing.command_fingerprint <> p_fingerprint then
      raise exception using errcode = 'ID409', message = 'offline payment idempotency conflict';
    end if;
    return query select v_existing.id, 'synced'::text, v_existing.response, v_existing.received_at;
    return;
  end if;

  select * into v_grant from public.offline_grants where tenant_id = p_tenant_id and id = (p_command->>'grantId')::uuid;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;
  if (p_command->>'deviceId')::uuid <> v_grant.device_id or (p_command->>'registerId')::uuid <> v_grant.register_id
    or p_command->>'currency' <> v_grant.currency then
    raise exception using errcode = 'OG403', message = 'grant binding mismatch';
  end if;
  if (p_command->>'schemaVersion')::integer <> v_grant.schema_version then
    raise exception using errcode = 'OG422', message = 'schema version unsupported';
  end if;
  if v_accepted < v_grant.issued_at - interval '5 minutes' or v_accepted > v_grant.accepted_until
    or v_accepted > v_received + interval '5 minutes' then
    raise exception using errcode = 'OG410', message = 'acceptedAt outside grant authority';
  end if;
  perform 1 from public.device_credentials c
    where c.tenant_id = p_tenant_id and c.id = p_credential_id and c.device_id = v_grant.device_id
      and c.valid_from <= v_accepted and (c.valid_to is null or c.valid_to >= v_accepted);
  if not found then raise exception using errcode = 'OS401', message = 'credential not valid at acceptance'; end if;
  if v_amount is null or v_amount <= 0 then raise exception using errcode = 'OS422', message = 'invalid payment amount'; end if;
  if not exists (select 1 from public.customers where tenant_id = p_tenant_id and id = v_customer) then
    raise exception using errcode = 'OG404', message = 'customer not found';
  end if;

  -- Idempotent on syncCommandId; raises CA409 if the paydown exceeds the authoritative outstanding.
  v_payment := customers_ar_private.record_customer_payment(
    p_tenant_id, v_customer, v_grant.operator_membership_id, v_sync::text,
    pg_catalog.jsonb_build_object('amountMinor', v_amount, 'paidAt', v_accepted));

  insert into public.offline_payment_ingestions(
    tenant_id, grant_id, device_id, credential_id, register_id, customer_id, local_payment_id,
    sync_command_id, command_fingerprint, canonical_command, device_signature_base64, amount_minor,
    server_payment_id, response, accepted_at, received_at
  ) values (
    p_tenant_id, v_grant.id, v_grant.device_id, p_credential_id, v_grant.register_id, v_customer,
    p_command->>'localPaymentId', v_sync, p_fingerprint, p_canonical, p_signature, v_amount,
    (v_payment->>'id')::uuid, v_payment, v_accepted, v_received
  ) returning id into v_ingestion;

  return query select v_ingestion, 'synced'::text, v_payment, v_received;
exception when unique_violation then
  select * into v_existing from public.offline_payment_ingestions
    where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if not found or v_existing.command_fingerprint <> p_fingerprint then
    raise exception using errcode = 'ID409', message = 'offline payment idempotency conflict';
  end if;
  return query select v_existing.id, 'synced'::text, v_existing.response, v_existing.received_at;
end;
$function$;

-- Ownership transfer requires the target role to hold CREATE on each object's schema; the base
-- offline migration grants then revokes this, so re-grant for the duration of these alters and
-- revoke again below (mirrors 20260906120000_create_offline_pos.sql).
grant create on schema public, offline_pos_private to offline_pos_writer;
alter table public.offline_payment_ingestions owner to offline_pos_writer;
alter function offline_pos_private.record_offline_customer_payment(uuid, uuid, jsonb, text, text, text)
  owner to offline_pos_writer;
revoke create on schema public, offline_pos_private from offline_pos_writer;
revoke all on function offline_pos_private.record_offline_customer_payment(uuid, uuid, jsonb, text, text, text)
  from public;

alter table public.offline_payment_ingestions enable row level security;
create policy offline_writer_payment_ingestions on public.offline_payment_ingestions
  for all to offline_pos_writer using (true) with check (true);

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function offline_pos_private.record_offline_customer_payment(uuid, uuid, jsonb, text, text, text) to service_role';
    execute 'grant select on public.offline_payment_ingestions to service_role';
  end if;
end
$block$;
