-- Offline-first all-desks program (POS roadmap §21+) — PROVISIONAL OFFLINE OPERATION INTENTS.
--
-- One shared, append-only, signed ingestion lane for desk actions that a till may RECORD while offline but
-- whose canonical effect depends on an owner policy that is still open (inventory oversell/allocation E,
-- supplier/AP authority, staff/payroll correction, settings/device governance G, review resolution). It
-- deliberately does the LEAST that is safe without inventing business policy:
--   * It stores the signed intent in a dedicated immutable table keyed to (tenant, syncCommandId), exactly
--     like offline attendance. Exact replay returns the original; changed intent under the same key → ID409.
--   * It NEVER mutates canonical stock, AP, payroll, roles, settings or devices. Every intent is received as
--     adjudication_status = 'pending_review'. Applying an intent to canonical state is a later, separately
--     authorized, policy-specific step (not part of this migration).
--   * It reuses the grant authority model: grant binding (device/register), schema version, acceptedAt
--     window, credential-valid-at-acceptance, and the tenant's per-register opt-in list
--     offline_pos_policies.offline_intent_operations (default EMPTY ⇒ every operation disabled ⇒ today's
--     online-only behaviour is preserved until an owner enables an operation).
--   * Optional dependency ordering: dependsOnSyncCommandId must reference an intent already received for the
--     same tenant + device (OI424 otherwise), so a dependent intent can never be accepted ahead of its parent.
-- Additive and forward-only: no historical migration or accepted business record is modified.

alter table public.offline_pos_policies
  add column offline_intent_operations text[] not null default '{}';

comment on column public.offline_pos_policies.offline_intent_operations is
  'Owner opt-in list of provisional offline intent operations (e.g. inventory.receive). Empty ⇒ disabled. Intents are always received pending_review and never mutate canonical state.';

create table public.offline_operation_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  grant_id uuid not null,
  device_id uuid not null,
  credential_id uuid not null,
  register_id uuid not null,
  branch_id uuid,
  inventory_location_id uuid,
  operator_membership_id uuid not null,
  local_intent_id text not null,
  sync_command_id uuid not null,
  command_fingerprint text not null,
  canonical_command text not null,
  device_signature_base64 text not null,
  operation text not null,
  subject_id text,
  base_version text,
  depends_on_sync_command_id uuid,
  payload jsonb not null,
  accepted_at timestamptz not null,
  received_at timestamptz not null default now(),
  -- Always 'received' in V1: durable server receipt, never canonical application.
  sync_status text not null default 'received',
  -- Always 'pending_review' in V1: applying an intent requires an approved, operation-specific policy.
  adjudication_status text not null default 'pending_review',
  created_at timestamptz not null default now(),
  constraint offline_operation_intents_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_operation_intents_grant_fk foreign key (tenant_id, grant_id) references public.offline_grants(tenant_id, id) on delete restrict,
  constraint offline_operation_intents_device_fk foreign key (tenant_id, device_id) references public.devices(tenant_id, id) on delete restrict,
  constraint offline_operation_intents_credential_fk foreign key (tenant_id, credential_id) references public.device_credentials(tenant_id, id) on delete restrict,
  constraint offline_operation_intents_member_fk foreign key (tenant_id, operator_membership_id) references public.memberships(tenant_id, id) on delete restrict,
  constraint offline_operation_intents_operation check (operation in (
    'inventory.receive', 'inventory.adjust', 'inventory.count',
    'suppliers.purchase_draft', 'suppliers.goods_receipt', 'suppliers.payment_intent',
    'staff.attendance_correction_request', 'staff.role_change_request',
    'settings.change_request', 'settings.device_revoke_request',
    'customers.create', 'customers.update',
    'review.resolution_request'
  )),
  constraint offline_operation_intents_status check (sync_status = 'received'),
  constraint offline_operation_intents_adjudication check (adjudication_status = 'pending_review'),
  constraint offline_operation_intents_fingerprint check (command_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint offline_operation_intents_local_not_blank check (btrim(local_intent_id) <> ''),
  constraint offline_operation_intents_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint offline_operation_intents_tenant_id_unique unique (tenant_id, id),
  constraint offline_operation_intents_sync_unique unique (tenant_id, sync_command_id),
  constraint offline_operation_intents_local_unique unique (tenant_id, device_id, local_intent_id)
);

create index offline_operation_intents_review_queue
  on public.offline_operation_intents (tenant_id, adjudication_status, operation, received_at);

comment on table public.offline_operation_intents is
  'Append-only, replay-safe signed offline operation intents. Provisional (received/pending_review); never mutates canonical stock, AP, payroll, roles, settings or devices.';

create trigger offline_operation_intents_immutable before update or delete
  on public.offline_operation_intents for each row
  execute function offline_pos_private.forbid_immutable_mutation();

-- Operations the register's policy currently opts into (read at bootstrap so the till only offers
-- enabled operations). Empty when the policy is absent or disabled.
create function offline_pos_private.get_intent_operations(p_tenant_id uuid, p_register_id uuid)
returns text[]
language sql stable security definer set search_path = '' as $function$
  select coalesce(
    (select case when p.enabled then p.offline_intent_operations else '{}'::text[] end
       from public.offline_pos_policies p
      where p.tenant_id = p_tenant_id and p.register_id = p_register_id),
    '{}'::text[]);
$function$;

create function offline_pos_private.record_offline_intent(
  p_tenant_id uuid, p_credential_id uuid, p_command jsonb, p_canonical text, p_fingerprint text, p_signature text
) returns table(ingestion_id uuid, sync_status text, operation text, received_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_operation_intents%rowtype;
  v_policy public.offline_pos_policies%rowtype;
  v_received timestamptz := now(); v_accepted timestamptz; v_sync uuid; v_ingestion uuid; v_operation text;
  v_depends uuid;
begin
  v_sync := (p_command->>'syncCommandId')::uuid;
  select * into v_existing from public.offline_operation_intents where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if found then
    if v_existing.command_fingerprint <> p_fingerprint then raise exception using errcode = 'ID409', message = 'offline idempotency conflict'; end if;
    return query select v_existing.id, v_existing.sync_status, v_existing.operation, v_existing.received_at; return;
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
  -- Owner opt-in, read live at ingestion: an operation disabled after bootstrap fails closed (OI403).
  select * into v_policy from public.offline_pos_policies where tenant_id = p_tenant_id and register_id = v_grant.register_id;
  if not found or not v_policy.enabled or not (v_operation = any(v_policy.offline_intent_operations)) then
    raise exception using errcode = 'OI403', message = 'offline operation not enabled';
  end if;
  v_depends := nullif(p_command->>'dependsOnSyncCommandId', '')::uuid;
  if v_depends is not null then
    perform 1 from public.offline_operation_intents d
      where d.tenant_id = p_tenant_id and d.sync_command_id = v_depends and d.device_id = v_grant.device_id;
    if not found then raise exception using errcode = 'OI424', message = 'dependency not yet received'; end if;
  end if;
  insert into public.offline_operation_intents(
    tenant_id, grant_id, device_id, credential_id, register_id, branch_id, inventory_location_id,
    operator_membership_id, local_intent_id, sync_command_id, command_fingerprint, canonical_command,
    device_signature_base64, operation, subject_id, base_version, depends_on_sync_command_id, payload, accepted_at)
  values(p_tenant_id, v_grant.id, v_grant.device_id, p_credential_id, v_grant.register_id, v_grant.branch_id,
    v_grant.inventory_location_id, v_grant.operator_membership_id, p_command->>'localIntentId', v_sync,
    p_fingerprint, p_canonical, p_signature, v_operation, p_command->>'subjectId', p_command->>'baseVersion',
    v_depends, p_command->'payload', v_accepted)
  returning id into v_ingestion;
  return query select v_ingestion, 'received'::text, v_operation, v_received;
exception when unique_violation then
  select * into v_existing from public.offline_operation_intents where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if not found or v_existing.command_fingerprint <> p_fingerprint then raise exception using errcode = 'ID409', message = 'offline idempotency conflict'; end if;
  return query select v_existing.id, v_existing.sync_status, v_existing.operation, v_existing.received_at;
end;
$function$;

-- Ownership + least privilege, mirroring 20261111120000_offline_attendance.sql (grant → transfer → revoke).
grant create on schema public, offline_pos_private to offline_pos_writer;
alter table public.offline_operation_intents owner to offline_pos_writer;
alter function offline_pos_private.record_offline_intent(uuid,uuid,jsonb,text,text,text) owner to offline_pos_writer;
alter function offline_pos_private.get_intent_operations(uuid,uuid) owner to offline_pos_writer;
revoke create on schema public, offline_pos_private from offline_pos_writer;

alter table public.offline_operation_intents enable row level security;
create policy offline_writer_operation_intents on public.offline_operation_intents
  for all to offline_pos_writer using (true) with check (true);
revoke all on table public.offline_operation_intents from public;
revoke all on function offline_pos_private.record_offline_intent(uuid,uuid,jsonb,text,text,text) from public;
revoke all on function offline_pos_private.get_intent_operations(uuid,uuid) from public;

do $b$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='anon') then
    execute 'revoke all on table public.offline_operation_intents from anon';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname='authenticated') then
    execute 'revoke all on table public.offline_operation_intents from authenticated';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname='service_role') then
    execute 'grant select on public.offline_operation_intents to service_role';
    execute 'grant execute on function offline_pos_private.record_offline_intent(uuid,uuid,jsonb,text,text,text) to service_role';
    execute 'grant execute on function offline_pos_private.get_intent_operations(uuid,uuid) to service_role';
  end if;
end $b$;
