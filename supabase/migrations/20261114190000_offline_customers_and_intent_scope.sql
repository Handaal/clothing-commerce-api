-- ADR-042 §8 (typed offline customer.create) and §9 (retire out-of-scope generic intent kinds).
--
-- §8 A till captures a NEW customer offline (name + phone + a client UUID). On sync the server:
--   * normalises the phone (must be E.164, the customers table rule);
--   * creates the customer with the till's UUID as its id, so an offline installment that references it
--     resolves once this command (queued first) is ingested;
--   * flags duplicate_of_customer_id when another customer already has that phone, and NEVER merges.
--   Replay of the same signed command returns the original result. Edit/merge stays online only.
-- §9 Every generic intent kind (inventory.*, suppliers.*, staff.*, settings.*, customers.*, review.*) is out of
--   scope. A received one is stored and disposed rejected / OIX_KIND_OUT_OF_SCOPE; registers can no longer
--   opt into any of them. (The intent migrations were never deployed.)

-- ---------------------------------------------------------------------------------------------------------
-- §8 offline customers
-- ---------------------------------------------------------------------------------------------------------
create table public.offline_customer_ingestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  grant_id uuid not null,
  device_id uuid not null,
  credential_id uuid not null,
  register_id uuid not null,
  sync_command_id uuid not null,
  local_customer_id uuid not null,
  customer_id uuid not null,
  duplicate_of_customer_id uuid,
  command_fingerprint text not null,
  canonical_command text not null,
  device_signature_base64 text not null,
  accepted_at timestamptz not null,
  received_at timestamptz not null default now(),
  constraint offline_customer_ingestions_grant_fk foreign key (tenant_id, grant_id) references public.offline_grants (tenant_id, id) on delete restrict,
  constraint offline_customer_ingestions_customer_fk foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete restrict,
  constraint offline_customer_ingestions_duplicate_fk foreign key (tenant_id, duplicate_of_customer_id) references public.customers (tenant_id, id) on delete restrict,
  constraint offline_customer_ingestions_fingerprint check (command_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint offline_customer_ingestions_sync_unique unique (tenant_id, sync_command_id),
  constraint offline_customer_ingestions_local_unique unique (tenant_id, local_customer_id)
);
alter table public.offline_customer_ingestions enable row level security;
revoke all on public.offline_customer_ingestions from public;
create trigger offline_customer_ingestions_immutable before update or delete on public.offline_customer_ingestions
  for each row execute function offline_pos_private.forbid_immutable_mutation();

create function offline_pos_private.record_offline_customer(
  p_tenant_id uuid, p_credential_id uuid, p_command jsonb, p_canonical text, p_fingerprint text, p_signature text
) returns table(ingestion_id uuid, customer_id uuid, duplicate_of_customer_id uuid, received_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_customer_ingestions%rowtype;
  v_sync uuid; v_local uuid; v_accepted timestamptz; v_received timestamptz := now();
  v_name text; v_phone text; v_norm text; v_duplicate uuid; v_ingestion uuid;
begin
  v_sync := (p_command->>'syncCommandId')::uuid;
  v_local := (p_command->>'localCustomerId')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('offline-customer:' || p_tenant_id::text || ':' || v_sync::text, 0));
  select * into v_existing from public.offline_customer_ingestions i where i.tenant_id = p_tenant_id and i.sync_command_id = v_sync;
  if found then
    if v_existing.command_fingerprint <> p_fingerprint then raise exception using errcode = 'ID409', message = 'offline idempotency conflict'; end if;
    return query select v_existing.id, v_existing.customer_id, v_existing.duplicate_of_customer_id, v_existing.received_at; return;
  end if;
  select * into v_grant from public.offline_grants g where g.tenant_id = p_tenant_id and g.id = (p_command->>'grantId')::uuid;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;
  if (p_command->>'deviceId')::uuid <> v_grant.device_id or (p_command->>'registerId')::uuid <> v_grant.register_id then
    raise exception using errcode = 'OG403', message = 'grant binding mismatch';
  end if;
  if (p_command->>'schemaVersion')::integer <> v_grant.schema_version then raise exception using errcode = 'OG422', message = 'schema version unsupported'; end if;
  v_accepted := (p_command->>'acceptedAt')::timestamptz;
  if v_accepted < v_grant.issued_at - interval '5 minutes' or v_accepted > v_grant.accepted_until or v_accepted > v_received + interval '5 minutes' then
    raise exception using errcode = 'OG410', message = 'acceptedAt outside grant authority';
  end if;
  perform 1 from public.device_credentials c where c.tenant_id = p_tenant_id and c.id = p_credential_id and c.device_id = v_grant.device_id
    and c.valid_from <= v_accepted and (c.valid_to is null or c.valid_to >= v_accepted);
  if not found then raise exception using errcode = 'OS401', message = 'credential not valid at acceptance'; end if;

  v_name := btrim(coalesce(p_command->>'name', ''));
  v_phone := btrim(coalesce(p_command->>'phone', ''));
  v_norm := pg_catalog.regexp_replace(v_phone, '[^+0-9]', '', 'g');
  if length(v_name) not between 1 and 200 then raise exception using errcode = 'OS422', message = 'customer name invalid'; end if;
  if v_norm !~ '^\+[1-9][0-9]{6,14}$' then raise exception using errcode = 'OS422', message = 'customer phone must be E.164'; end if;
  if exists (select 1 from public.customers c where c.tenant_id = p_tenant_id and c.id = v_local) then
    raise exception using errcode = 'ID409', message = 'customer id already used';
  end if;
  select c.id into v_duplicate from public.customers c
   where c.tenant_id = p_tenant_id and c.normalized_phone = v_norm order by c.created_at, c.id limit 1;
  insert into public.customers (id, tenant_id, name, phone) values (v_local, p_tenant_id, v_name, v_phone);
  insert into public.offline_customer_ingestions (tenant_id, grant_id, device_id, credential_id, register_id, sync_command_id,
    local_customer_id, customer_id, duplicate_of_customer_id, command_fingerprint, canonical_command, device_signature_base64,
    accepted_at, received_at)
  values (p_tenant_id, v_grant.id, v_grant.device_id, p_credential_id, v_grant.register_id, v_sync, v_local, v_local, v_duplicate,
    p_fingerprint, p_canonical, p_signature, v_accepted, v_received)
  returning id into v_ingestion;
  return query select v_ingestion, v_local, v_duplicate, v_received;
end;
$function$;

grant select, insert on public.customers to offline_pos_writer;
create policy offline_pos_writer_customers_read on public.customers for select to offline_pos_writer using (true);
create policy offline_pos_writer_customers_insert on public.customers for insert to offline_pos_writer with check (true);

grant create on schema public, offline_pos_private to offline_pos_writer;
alter table public.offline_customer_ingestions owner to offline_pos_writer;
alter function offline_pos_private.record_offline_customer(uuid, uuid, jsonb, text, text, text) owner to offline_pos_writer;
revoke create on schema public, offline_pos_private from offline_pos_writer;
revoke all on function offline_pos_private.record_offline_customer(uuid, uuid, jsonb, text, text, text) from public;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function offline_pos_private.record_offline_customer(uuid, uuid, jsonb, text, text, text) to service_role;
    grant select on public.offline_customer_ingestions to service_role;
  end if;
end $b$;

-- ---------------------------------------------------------------------------------------------------------
-- §9 retire generic intent kinds
-- ---------------------------------------------------------------------------------------------------------
update public.offline_pos_policies set offline_intent_operations = '{}' where cardinality(offline_intent_operations) > 0;
alter table public.offline_pos_policies
  add constraint offline_pos_policies_no_intent_operations check (cardinality(offline_intent_operations) = 0);

create or replace function offline_pos_private.adjudicate_intent(
  p_tenant_id uuid, p_grant public.offline_grants, p_operation text, p_payload jsonb, p_base_version text,
  p_depends uuid, p_sync uuid, p_accepted timestamptz, p_handler_policies jsonb
) returns table(disposition text, code text, detail jsonb, policy_version text)
language plpgsql security definer set search_path = '' as $function$
begin
  -- ADR-042 §9: nothing from the generic lane is applied any more. customers.create has its own typed command.
  return query select 'rejected'::text, 'OIX_KIND_OUT_OF_SCOPE'::text,
    case when p_operation = 'customers.create' then jsonb_build_object('replacement', 'offline-customers')
         else jsonb_build_object() end,
    null::text;
end;
$function$;

create or replace function offline_pos_private.record_offline_intent(
  p_tenant_id uuid, p_credential_id uuid, p_command jsonb, p_canonical text, p_fingerprint text, p_signature text
) returns table(ingestion_id uuid, sync_status text, operation text, received_at timestamptz,
  disposition text, disposition_code text, disposition_detail jsonb, policy_version text, decided_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_operation_intents%rowtype;
  v_policy public.offline_pos_policies%rowtype;
  v_received timestamptz := now(); v_accepted timestamptz; v_sync uuid; v_ingestion uuid; v_operation text;
  v_depends uuid; v_decision record;
begin
  v_sync := (p_command->>'syncCommandId')::uuid;
  -- One ingestion at a time per sync identity so a concurrent duplicate can never apply twice.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('offline-intent:' || p_tenant_id::text || ':' || v_sync::text, 0));
  select * into v_existing from public.offline_operation_intents where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if found then
    if v_existing.command_fingerprint <> p_fingerprint then raise exception using errcode = 'ID409', message = 'offline idempotency conflict'; end if;
    -- Exact replay (lost response, lost local ack): the ORIGINAL disposition, never a second effect.
    return query select v_existing.id, v_existing.sync_status, v_existing.operation, v_existing.received_at,
      case when v_existing.adjudication_status = 'pending_review' then 'needs_reconciliation' else v_existing.adjudication_status end,
      coalesce(v_existing.disposition_code, 'OIX_LEGACY_UNADJUDICATED'), v_existing.disposition_detail,
      v_existing.policy_version, coalesce(v_existing.decided_at, v_existing.received_at);
    return;
  end if;
  select * into v_grant from public.offline_grants where tenant_id = p_tenant_id and id = (p_command->>'grantId')::uuid;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;
  if (p_command->>'deviceId')::uuid <> v_grant.device_id or (p_command->>'registerId')::uuid <> v_grant.register_id
     or (p_command->>'operatorMembershipId')::uuid <> v_grant.operator_membership_id then
    raise exception using errcode = 'OG403', message = 'grant binding mismatch';
  end if;
  if (p_command->>'schemaVersion')::integer <> v_grant.schema_version then raise exception using errcode = 'OG422', message = 'schema version unsupported'; end if;
  v_accepted := (p_command->>'acceptedAt')::timestamptz;
  if v_accepted < v_grant.issued_at - interval '5 minutes' or v_accepted > v_grant.accepted_until or v_accepted > v_received + interval '5 minutes' then
    raise exception using errcode = 'OG410', message = 'acceptedAt outside grant authority';
  end if;
  perform 1 from public.device_credentials c
    where c.tenant_id = p_tenant_id and c.id = p_credential_id and c.device_id = v_grant.device_id
      and c.valid_from <= v_accepted and (c.valid_to is null or c.valid_to >= v_accepted);
  if not found then raise exception using errcode = 'OS401', message = 'credential not valid at acceptance'; end if;
  v_operation := p_command->>'operation';
  select * into v_policy from public.offline_pos_policies where tenant_id = p_tenant_id and register_id = v_grant.register_id;
  -- ADR-042 §9: every generic intent kind is out of scope. A received one is recorded and disposed
  -- rejected / OIX_KIND_OUT_OF_SCOPE (no business effect); only a disabled register still refuses outright.
  if not found or not v_policy.enabled then
    raise exception using errcode = 'OI403', message = 'offline operation not enabled';
  end if;
  v_depends := nullif(p_command->>'dependsOnSyncCommandId', '')::uuid;
  if v_depends is not null then
    perform 1 from public.offline_operation_intents d
      where d.tenant_id = p_tenant_id and d.sync_command_id = v_depends and d.device_id = v_grant.device_id;
    if not found then raise exception using errcode = 'OI424', message = 'dependency not yet received'; end if;
  end if;

  select * into v_decision from offline_pos_private.adjudicate_intent(
    p_tenant_id, v_grant, v_operation, p_command->'payload', p_command->>'baseVersion', v_depends, v_sync,
    v_accepted, v_policy.offline_intent_handler_policies);

  insert into public.offline_operation_intents(
    tenant_id, grant_id, device_id, credential_id, register_id, branch_id, inventory_location_id,
    operator_membership_id, local_intent_id, sync_command_id, command_fingerprint, canonical_command,
    device_signature_base64, operation, subject_id, base_version, depends_on_sync_command_id, payload, accepted_at,
    adjudication_status, disposition_code, disposition_detail, policy_version, decided_at)
  values(p_tenant_id, v_grant.id, v_grant.device_id, p_credential_id, v_grant.register_id, v_grant.branch_id,
    v_grant.inventory_location_id, v_grant.operator_membership_id, p_command->>'localIntentId', v_sync,
    p_fingerprint, p_canonical, p_signature, v_operation, p_command->>'subjectId', p_command->>'baseVersion',
    v_depends, p_command->'payload', v_accepted,
    v_decision.disposition, v_decision.code, v_decision.detail, v_decision.policy_version, v_received)
  returning id into v_ingestion;
  return query select v_ingestion, 'received'::text, v_operation, v_received,
    v_decision.disposition, v_decision.code, v_decision.detail, v_decision.policy_version, v_received;
end;
$function$;
