-- Phase 5 (ADR-041 Decision A) — offline returns: server-issued return grant + signed offline return
-- ingestion with WITHHELD settlement and server-authoritative reconciliation.
--
-- Mirrors the offline-sale authority model (20260906120000_create_offline_pos.sql) exactly, and REUSES the
-- canonical connected return engine (20260919180000 + 20260924180200) rather than forking refund math:
--
--   * issue_return_grant  (ONLINE, per original order): freezes returns_private.return_eligibility — the
--     server-authoritative per-line eligible quantities + net-basis maxRefundableMinor — into an immutable,
--     device/register/location-bound, short-window grant. The till may offer ONLY grant-pre-authorized lines
--     and never computes refund money.
--   * record_offline_return (INGESTION): idempotent by (tenant, syncCommandId) + fingerprint; validates grant
--     binding / schema version / acceptedAt skew / credential-at-acceptance; asserts each signed line is within
--     the grant's frozen eligible quantity (fail-closed OG422 if it exceeds what was granted); then delegates
--     canonical creation to returns_private.accept_return(refundMode='pending') so the NET refund amount is
--     recomputed server-side. The resulting refund is always status='pending' (settlement WITHHELD offline).
--
-- Safety invariants enforced here:
--   * Settlement is NEVER performed offline — refund stays 'pending' until the existing connected
--     settle_manual_refund attestation path runs after reconnect. No cash handed, no provider capture.
--   * Canonical stock is NEVER increased at offline ingestion — every offline return line is recorded as
--     'non_restock'; the operator's intended disposition is preserved in return_provenance for a later
--     connected inspection/restock step. (Brief: "do not increase canonical stock until accepted.")
--   * Eligibility drift since grant issuance (a concurrent return elsewhere, an expired window, a disabled
--     policy) makes accept_return raise RTQTY/RT409/RT422 → caught as 'eligibility_drift_at_ingestion'
--     reconciliation with NO canonical return and NO settlement — exactly like insufficient_stock for sales.
--   * A revoked device's queued return is not silently dropped: the signed command is durably retained and a
--     'device_revoked_at_ingestion' reconciliation is opened for governed review (no canonical return created).
--
-- Owner sub-decisions (ADR-041 A-i/A-ii/A-iii) are handled with SAFE DEFAULTS, not fabricated policy:
--   * A-iii refund-only first: this migration implements refund-only; exchange (return+new-sale) is NOT here.
--   * A-i  refund budget: max_refundable_minor defaults to the TRUE canonical eligibility ceiling (no invented
--     budget). A tighter per-grant cap can be added later as an optional narrowing column.
--   * A-ii grant window: reuses the already-approved offline_pos_policies.operator_lease_seconds (an existing
--     approved bound) rather than inventing a number. A dedicated return-window column is a future narrowing.
-- The whole feature is gated by the offline_returns feature flag on the client; with it off, returns remain
-- fail-closed exactly as today. This migration is additive and forward-only.

-- offline_pos_writer gains read access to the returns engine schema so its SECURITY DEFINER ingestion RPC can
-- invoke the canonical (returns_writer-owned, SECURITY DEFINER) eligibility + acceptance functions.
grant usage on schema returns_private to offline_pos_writer;

create table public.offline_return_grants (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null unique default gen_random_uuid(),
  tenant_id uuid not null,
  device_id uuid not null,
  register_id uuid not null,
  branch_id uuid not null,
  inventory_location_id uuid not null,
  operator_membership_id uuid not null,
  order_id uuid not null,
  currency text not null,
  schema_version integer not null default 1,
  minimum_client_version text not null default '0.5.0',
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_refundable_minor bigint not null,
  eligibility_snapshot jsonb not null,
  issuance_idempotency_key text not null,
  normalized_issuance_idempotency_key text generated always as (lower(btrim(issuance_idempotency_key))) stored,
  issuance_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint offline_return_grants_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_return_grants_device_fk foreign key (tenant_id, device_id) references public.devices(tenant_id, id) on delete restrict,
  constraint offline_return_grants_register_branch_fk foreign key (tenant_id, branch_id, register_id) references public.registers(tenant_id, branch_id, id) on delete restrict,
  constraint offline_return_grants_location_fk foreign key (tenant_id, inventory_location_id) references public.inventory_locations(tenant_id, id) on delete restrict,
  constraint offline_return_grants_operator_fk foreign key (tenant_id, operator_membership_id) references public.memberships(tenant_id, id) on delete restrict,
  constraint offline_return_grants_order_fk foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete restrict,
  constraint offline_return_grants_currency check (currency ~ '^[A-Z]{3}$'),
  constraint offline_return_grants_version check (schema_version = 1 and btrim(minimum_client_version) <> ''),
  constraint offline_return_grants_window check (expires_at > issued_at),
  constraint offline_return_grants_refundable check (max_refundable_minor >= 0 and max_refundable_minor <= 9007199254740991),
  constraint offline_return_grants_snapshot_object check (jsonb_typeof(eligibility_snapshot) = 'object'),
  constraint offline_return_grants_issuance_key check (normalized_issuance_idempotency_key <> ''),
  constraint offline_return_grants_issuance_key_unique unique (tenant_id, normalized_issuance_idempotency_key),
  constraint offline_return_grants_tenant_id_unique unique (tenant_id, id)
);
create index offline_return_grants_order_idx on public.offline_return_grants(tenant_id, order_id, expires_at desc);

create table public.offline_return_ingestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  return_grant_id uuid not null,
  device_id uuid not null,
  credential_id uuid not null,
  register_id uuid not null,
  branch_id uuid not null,
  inventory_location_id uuid not null,
  order_id uuid not null,
  local_return_id text not null,
  sync_command_id uuid not null,
  command_fingerprint text not null,
  canonical_command text not null,
  device_signature_base64 text not null,
  accepted_at timestamptz not null,
  received_at timestamptz not null default now(),
  -- Canonical return + refund (pending) when accepted; null when held for reconciliation.
  return_id uuid,
  refund_id uuid,
  -- Server-computed withheld refund amount/currency, captured for exact replay without re-reading refunds.
  refund_amount_minor bigint,
  refund_currency text,
  sync_status text not null,
  return_provenance jsonb not null,
  created_at timestamptz not null default now(),
  constraint offline_return_ingestions_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_return_ingestions_grant_fk foreign key (tenant_id, return_grant_id) references public.offline_return_grants(tenant_id, id) on delete restrict,
  constraint offline_return_ingestions_device_fk foreign key (tenant_id, device_id) references public.devices(tenant_id, id) on delete restrict,
  constraint offline_return_ingestions_credential_fk foreign key (tenant_id, credential_id) references public.device_credentials(tenant_id, id) on delete restrict,
  constraint offline_return_ingestions_order_fk foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete restrict,
  constraint offline_return_ingestions_return_fk foreign key (tenant_id, return_id) references public.returns(tenant_id, id) on delete restrict,
  constraint offline_return_ingestions_refund_fk foreign key (tenant_id, refund_id) references public.refunds(tenant_id, id) on delete restrict,
  constraint offline_return_ingestions_status check (sync_status in ('synced', 'needs_reconciliation')),
  -- When synced, both canonical refs + the withheld refund amount exist; when held, none do.
  constraint offline_return_ingestions_synced_refs check ((sync_status = 'synced') = (return_id is not null and refund_id is not null)),
  constraint offline_return_ingestions_synced_refund check ((sync_status = 'synced') = (refund_amount_minor is not null and refund_currency is not null)),
  constraint offline_return_ingestions_refund_amount check (refund_amount_minor is null or refund_amount_minor between 0 and 9007199254740991),
  constraint offline_return_ingestions_fingerprint check (command_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint offline_return_ingestions_local_not_blank check (btrim(local_return_id) <> ''),
  constraint offline_return_ingestions_tenant_id_unique unique (tenant_id, id),
  constraint offline_return_ingestions_sync_unique unique (tenant_id, sync_command_id),
  constraint offline_return_ingestions_local_unique unique (tenant_id, device_id, local_return_id),
  constraint offline_return_ingestions_return_unique unique (tenant_id, return_id)
);

create table public.offline_return_reconciliations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  ingestion_id uuid not null,
  local_return_id text not null,
  order_id uuid not null,
  reason text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offline_return_reconciliations_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_return_reconciliations_ingestion_fk foreign key (tenant_id, ingestion_id) references public.offline_return_ingestions(tenant_id, id) on delete restrict,
  constraint offline_return_reconciliations_order_fk foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete restrict,
  constraint offline_return_reconciliations_reason check (reason in ('eligibility_drift_at_ingestion', 'device_revoked_at_ingestion')),
  constraint offline_return_reconciliations_status check (status = 'open'),
  constraint offline_return_reconciliations_tenant_id_unique unique (tenant_id, id),
  constraint offline_return_reconciliations_ingestion_unique unique (tenant_id, ingestion_id)
);

create table public.offline_return_reconciliation_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, reconciliation_id uuid not null,
  event_type text not null default 'opened', reason text not null, occurred_at timestamptz not null default now(),
  constraint offline_return_recon_events_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_return_recon_events_recon_fk foreign key (tenant_id, reconciliation_id) references public.offline_return_reconciliations(tenant_id, id) on delete restrict,
  constraint offline_return_recon_events_type check (event_type = 'opened')
);

-- Reuse the existing offline immutability guard so stored grants / ingestions / events can never be edited.
create trigger offline_return_grants_immutable before update or delete on public.offline_return_grants for each row execute function offline_pos_private.forbid_immutable_mutation();
create trigger offline_return_ingestions_immutable before update or delete on public.offline_return_ingestions for each row execute function offline_pos_private.forbid_immutable_mutation();
create trigger offline_return_recon_events_immutable before update or delete on public.offline_return_reconciliation_events for each row execute function offline_pos_private.forbid_immutable_mutation();

-- issue_return_grant (ONLINE): freeze server-authoritative eligibility for one order into a bounded grant.
create function offline_pos_private.issue_return_grant(
  p_tenant_id uuid, p_device_id uuid, p_register_id uuid, p_operator_membership_id uuid, p_order_id uuid, p_idempotency_key text
) returns setof public.offline_return_grants language plpgsql security definer set search_path = '' as $function$
declare v_policy public.offline_pos_policies%rowtype; v_branch uuid; v_location uuid; v_currency text;
  v_grant public.offline_return_grants%rowtype; v_now timestamptz := now(); v_eligibility jsonb; v_max bigint;
  v_fingerprint text := pg_catalog.md5(p_device_id::text || E'\n' || p_register_id::text || E'\n' || p_operator_membership_id::text || E'\n' || p_order_id::text);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text || ':return-grant:' || lower(btrim(p_idempotency_key)), 0));
  select * into v_grant from public.offline_return_grants where tenant_id = p_tenant_id and normalized_issuance_idempotency_key = lower(btrim(p_idempotency_key));
  if found then
    if v_grant.issuance_fingerprint <> v_fingerprint then raise exception using errcode = 'ID409', message = 'return grant issuance idempotency conflict'; end if;
    return next v_grant; return;
  end if;
  select branch_id, default_inventory_location_id, selling_currency into v_branch, v_location, v_currency
    from public.registers where tenant_id = p_tenant_id and id = p_register_id and status = 'active';
  if not found then raise exception using errcode = 'OD404', message = 'register not found'; end if;
  select * into v_policy from public.offline_pos_policies where tenant_id = p_tenant_id and register_id = p_register_id;
  if not found or not v_policy.enabled then raise exception using errcode = 'OP403', message = 'offline selling disabled'; end if;
  perform 1 from public.devices d join public.register_device_assignments a on a.tenant_id = d.tenant_id and a.device_id = d.id and a.unassigned_at is null
    where d.tenant_id = p_tenant_id and d.id = p_device_id and d.status = 'active' and a.register_id = p_register_id;
  if not found then raise exception using errcode = 'OD410', message = 'device unavailable'; end if;
  -- Server-authoritative eligibility (net basis, current). Refuses a grant for a non-returnable order.
  v_eligibility := returns_private.return_eligibility(p_tenant_id, p_order_id);
  if (v_eligibility->>'eligible')::boolean is not true then
    raise exception using errcode = 'RT422', message = coalesce(v_eligibility->>'reason', 'ORDER_NOT_RETURNABLE');
  end if;
  if v_eligibility->>'currency' <> v_currency then raise exception using errcode = 'RT409', message = 'order currency mismatch'; end if;
  -- A-i default: the true canonical ceiling, no invented budget.
  v_max := (v_eligibility->>'maxRefundableMinor')::bigint;
  insert into public.offline_return_grants(tenant_id, device_id, register_id, branch_id, inventory_location_id, operator_membership_id, order_id, currency,
    expires_at, max_refundable_minor, eligibility_snapshot, issuance_idempotency_key, issuance_fingerprint)
  -- A-ii default: reuse the approved offline operator lease as the return-grant window.
  values(p_tenant_id, p_device_id, p_register_id, v_branch, v_location, p_operator_membership_id, p_order_id, v_currency,
    v_now + pg_catalog.make_interval(secs => v_policy.operator_lease_seconds), v_max, v_eligibility, p_idempotency_key, v_fingerprint)
  returning * into v_grant;
  return next v_grant;
end;
$function$;

-- record_offline_return (INGESTION): idempotent, authority-bound, settlement withheld, drift → reconciliation.
create function offline_pos_private.record_offline_return(
  p_tenant_id uuid, p_credential_id uuid, p_command jsonb, p_canonical text, p_fingerprint text, p_signature text
) returns table(ingestion_id uuid, sync_status text, return_id uuid, refund_id uuid, refund_amount_minor bigint, refund_currency text, reconciliation_id uuid, received_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_return_grants%rowtype; v_existing public.offline_return_ingestions%rowtype;
  v_device_status text; v_received timestamptz := now(); v_accepted timestamptz; v_sync uuid;
  v_element jsonb; v_snap_line jsonb; v_intent_lines jsonb := '[]'; v_intent jsonb; v_detail jsonb;
  v_return uuid; v_refund uuid; v_refund_amount bigint; v_refund_currency text;
  v_ingestion uuid; v_reconciliation uuid; v_reason text; v_held boolean := false;
begin
  v_sync := (p_command->>'syncCommandId')::uuid;
  select * into v_existing from public.offline_return_ingestions where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if found then
    if v_existing.command_fingerprint <> p_fingerprint then raise exception using errcode = 'ID409', message = 'offline idempotency conflict'; end if;
    select r.id into v_reconciliation from public.offline_return_reconciliations r where r.tenant_id = p_tenant_id and r.ingestion_id = v_existing.id;
    return query select v_existing.id, v_existing.sync_status, v_existing.return_id, v_existing.refund_id, v_existing.refund_amount_minor, v_existing.refund_currency, v_reconciliation, v_existing.received_at; return;
  end if;
  select * into v_grant from public.offline_return_grants where tenant_id = p_tenant_id and id = (p_command->>'returnGrantId')::uuid;
  if not found then raise exception using errcode = 'OG404', message = 'return grant not found'; end if;
  if (p_command->>'deviceId')::uuid <> v_grant.device_id or (p_command->>'registerId')::uuid <> v_grant.register_id
     or (p_command->>'orderId')::uuid <> v_grant.order_id or p_command->>'currency' <> v_grant.currency then
    raise exception using errcode = 'OG403', message = 'return grant binding mismatch';
  end if;
  if (p_command->>'schemaVersion')::integer <> v_grant.schema_version then raise exception using errcode = 'OG422', message = 'schema version unsupported'; end if;
  v_accepted := (p_command->>'acceptedAt')::timestamptz;
  if v_accepted < v_grant.issued_at - interval '5 minutes' or v_accepted > v_grant.expires_at or v_accepted > v_received + interval '5 minutes' then
    raise exception using errcode = 'OG410', message = 'acceptedAt outside return grant authority';
  end if;
  perform 1 from public.device_credentials c where c.tenant_id = p_tenant_id and c.id = p_credential_id and c.device_id = v_grant.device_id
    and c.valid_from <= v_accepted and (c.valid_to is null or c.valid_to >= v_accepted);
  if not found then raise exception using errcode = 'OS401', message = 'credential not valid at acceptance'; end if;
  if jsonb_typeof(p_command->'lines') is distinct from 'array' or pg_catalog.jsonb_array_length(p_command->'lines') not between 1 and 100 then
    raise exception using errcode = 'OS422', message = 'offline return has no lines'; end if;
  -- Authority bound: every signed line must be within the grant's FROZEN eligible quantity. Exceeding the
  -- pre-authorized grant is a fail-closed fault (the till should never have offered it), not a reconciliation.
  for v_element in select value from pg_catalog.jsonb_array_elements(p_command->'lines') loop
    if (v_element->>'quantity') !~ '^[1-9][0-9]*$' then raise exception using errcode = 'OS422', message = 'invalid return line quantity'; end if;
    select line into v_snap_line from (
      select l.value line from pg_catalog.jsonb_array_elements(v_grant.eligibility_snapshot->'lines') l(value)
      where l.value->>'orderLineId' = v_element->>'orderLineId') q;
    if v_snap_line is null or (v_element->>'quantity')::bigint > (v_snap_line->>'eligibleQuantity')::bigint then
      raise exception using errcode = 'OG422', message = 'return line not authorized by grant';
    end if;
    -- Canonical creation forces non_restock: canonical stock is NOT posted at offline ingestion. The
    -- operator's intended disposition is preserved below in return_provenance for connected inspection.
    v_intent_lines := v_intent_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'orderLineId', v_element->>'orderLineId', 'quantity', (v_element->>'quantity')::bigint,
      'reason', v_element->>'reason', 'disposition', 'non_restock'));
  end loop;
  select d.status into v_device_status from public.devices d where d.tenant_id = p_tenant_id and d.id = v_grant.device_id;
  if v_device_status = 'revoked' then
    -- Not dropped: retain the signed command, open governed reconciliation, create no canonical return.
    v_held := true; v_reason := 'device_revoked_at_ingestion';
  else
    v_intent := pg_catalog.jsonb_build_object('refundMode', 'pending', 'lines', v_intent_lines);
    begin
      -- Delegate to the canonical return engine: server recomputes NET refund; refund is created 'pending'
      -- (settlement withheld). normalized_key = syncCommandId makes the canonical create independently replay-safe.
      v_detail := returns_private.accept_return(p_tenant_id, v_grant.order_id, v_grant.operator_membership_id, 'pos', v_sync::text, v_intent);
      v_return := (v_detail->>'id')::uuid;
      v_refund := (v_detail->'refund'->>'id')::uuid;
      v_refund_amount := (v_detail->'refund'->>'amountMinor')::bigint;
      v_refund_currency := v_detail->'refund'->>'currency';
    exception
      -- Eligibility drift since grant issuance: a concurrent return consumed the quantity, the window expired,
      -- the policy was disabled, or the refund ceiling changed. Hold for reconciliation; withhold settlement.
      when sqlstate 'RTQTY' or sqlstate 'RT409' or sqlstate 'RT422' then
        v_held := true; v_reason := 'eligibility_drift_at_ingestion';
    end;
  end if;
  insert into public.offline_return_ingestions(tenant_id, return_grant_id, device_id, credential_id, register_id, branch_id, inventory_location_id, order_id,
    local_return_id, sync_command_id, command_fingerprint, canonical_command, device_signature_base64, accepted_at, received_at, return_id, refund_id, refund_amount_minor, refund_currency, sync_status, return_provenance)
  values(p_tenant_id, v_grant.id, v_grant.device_id, p_credential_id, v_grant.register_id, v_grant.branch_id, v_grant.inventory_location_id, v_grant.order_id,
    p_command->>'localReturnId', v_sync, p_fingerprint, p_canonical, p_signature, v_accepted, v_received,
    case when v_held then null else v_return end, case when v_held then null else v_refund end,
    case when v_held then null else v_refund_amount end, case when v_held then null else v_refund_currency end,
    case when v_held then 'needs_reconciliation' else 'synced' end,
    pg_catalog.jsonb_build_object('returnGrantId', v_grant.id, 'snapshotId', v_grant.snapshot_id, 'lines', p_command->'lines', 'maxRefundableMinor', v_grant.max_refundable_minor))
  returning id into v_ingestion;
  if v_held then
    insert into public.offline_return_reconciliations(tenant_id, ingestion_id, local_return_id, order_id, reason)
    values(p_tenant_id, v_ingestion, p_command->>'localReturnId', v_grant.order_id, v_reason) returning id into v_reconciliation;
    insert into public.offline_return_reconciliation_events(tenant_id, reconciliation_id, reason) values(p_tenant_id, v_reconciliation, v_reason);
  end if;
  return query select v_ingestion, case when v_held then 'needs_reconciliation' else 'synced' end,
    case when v_held then null else v_return end, case when v_held then null else v_refund end,
    case when v_held then null else v_refund_amount end, case when v_held then null else v_refund_currency end, v_reconciliation, v_received;
exception when unique_violation then
  select * into v_existing from public.offline_return_ingestions where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if not found or v_existing.command_fingerprint <> p_fingerprint then raise exception using errcode = 'ID409', message = 'offline idempotency conflict'; end if;
  select r.id into v_reconciliation from public.offline_return_reconciliations r where r.tenant_id = p_tenant_id and r.ingestion_id = v_existing.id;
  return query select v_existing.id, v_existing.sync_status, v_existing.return_id, v_existing.refund_id, v_existing.refund_amount_minor, v_existing.refund_currency, v_reconciliation, v_existing.received_at;
end;
$function$;

-- Privileges: the ingestion RPC (owned by offline_pos_writer) invokes the returns engine's SECURITY DEFINER
-- functions (owned by returns_writer), which run with returns_writer's own rights — so only EXECUTE is needed.
grant execute on function returns_private.return_eligibility(uuid, uuid) to offline_pos_writer;
grant execute on function returns_private.accept_return(uuid, uuid, uuid, text, text, jsonb) to offline_pos_writer;
grant execute on function returns_private.return_detail(uuid, uuid) to offline_pos_writer;

grant select, insert on public.offline_return_grants, public.offline_return_ingestions,
  public.offline_return_reconciliations, public.offline_return_reconciliation_events to offline_pos_writer;

alter table public.offline_return_grants enable row level security;
alter table public.offline_return_ingestions enable row level security;
alter table public.offline_return_reconciliations enable row level security;
alter table public.offline_return_reconciliation_events enable row level security;
revoke all on table public.offline_return_grants, public.offline_return_ingestions,
  public.offline_return_reconciliations, public.offline_return_reconciliation_events from public;

-- Ownership transfer requires offline_pos_writer to hold CREATE on schema public for the duration (same
-- grant→transfer→revoke dance as 20260906120000 / 20261111120000).
grant create on schema public, offline_pos_private to offline_pos_writer;
alter table public.offline_return_grants owner to offline_pos_writer;
alter table public.offline_return_ingestions owner to offline_pos_writer;
alter table public.offline_return_reconciliations owner to offline_pos_writer;
alter table public.offline_return_reconciliation_events owner to offline_pos_writer;
alter function offline_pos_private.issue_return_grant(uuid, uuid, uuid, uuid, uuid, text) owner to offline_pos_writer;
alter function offline_pos_private.record_offline_return(uuid, uuid, jsonb, text, text, text) owner to offline_pos_writer;
revoke create on schema public, offline_pos_private from offline_pos_writer;

-- These business functions are SECURITY DEFINER; strip the default PUBLIC execute so only service_role (granted
-- below) can invoke them — matching the hardening the base offline migration applies to its own functions.
revoke all on function offline_pos_private.issue_return_grant(uuid, uuid, uuid, uuid, uuid, text) from public;
revoke all on function offline_pos_private.record_offline_return(uuid, uuid, jsonb, text, text, text) from public;

create policy offline_writer_return_grants on public.offline_return_grants for all to offline_pos_writer using (true) with check (true);
create policy offline_writer_return_ingestions on public.offline_return_ingestions for all to offline_pos_writer using (true) with check (true);
create policy offline_writer_return_reconciliations on public.offline_return_reconciliations for all to offline_pos_writer using (true) with check (true);
create policy offline_writer_return_recon_events on public.offline_return_reconciliation_events for all to offline_pos_writer using (true) with check (true);

do $b$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on public.offline_return_grants, public.offline_return_ingestions, public.offline_return_reconciliations, public.offline_return_reconciliation_events from anon';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.offline_return_grants, public.offline_return_ingestions, public.offline_return_reconciliations, public.offline_return_reconciliation_events from authenticated';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant select on public.offline_return_grants, public.offline_return_ingestions, public.offline_return_reconciliations, public.offline_return_reconciliation_events to service_role';
    execute 'grant execute on function offline_pos_private.issue_return_grant(uuid, uuid, uuid, uuid, uuid, text) to service_role';
    execute 'grant execute on function offline_pos_private.record_offline_return(uuid, uuid, jsonb, text, text, text) to service_role';
  end if;
end $b$;

comment on table public.offline_return_grants is 'Immutable server-issued per-order offline return authority; freezes return_eligibility (per-line eligible qty + net-basis ceiling); expiry blocks new acceptance but not later ingestion.';
comment on table public.offline_return_ingestions is 'Replay-safe mapping from a signed offline return command to a canonical Return + pending (withheld) Refund; needs_reconciliation when eligibility drifted or the device was revoked. No automatic retention deletion.';
