-- Offline-first all-desks program (POS roadmap §22) — AUTOMATIC SERVER ADJUDICATION of offline intents.
--
-- Owner clarification (2026-11-14): there is NO human/admin/manager approval step for offline operations.
-- 20261114120000_offline_operation_intents.sql stored every intent as 'pending_review', i.e. waiting for a
-- person. This forward-only migration replaces that with a deterministic, synchronous machine disposition
-- decided in the SAME transaction that durably records the signed command:
--
--   applied               the typed domain handler validated the command under the register's configured
--                         handler policy and committed its business effect atomically (ledger + receipt);
--   rejected              the command can never be applied (over a policy limit, out of scope, unknown
--                         subject, retired kind). No business side effect;
--   needs_reconciliation  the command conflicts with canonical state (stale base version, insufficient
--                         stock, dependency not applied, device revoked, ledger refused). No business side
--                         effect; the immutable evidence is kept for OPERATOR reconciliation at the till;
--   blocked_policy        no approved handler policy exists for this operation on this register, or the
--                         operation has no typed handler yet. Fails closed; no business side effect.
--
-- There is no 'pending'/'pending_review' state: a row is inserted only together with its final disposition.
-- Transient failures (unknown grant, dependency not yet received, DB error) raise and roll back, so the till
-- retries the exact same signed bytes; nothing waits for a person.
--
-- Policy model (no business rule is invented here):
--   * offline_pos_policies.offline_intent_operations (existing) — transport opt-in; unlisted ⇒ OI403, no row.
--   * offline_pos_policies.offline_intent_handler_policies (new, default '{}') — per-operation handler policy
--     object, e.g. {"inventory.receive": {"version": "E-1", "maxQuantity": 50}}. Absent ⇒ blocked_policy.
--     Every numeric limit a handler needs must be supplied by the owner's policy; a missing or malformed limit
--     is blocked_policy (OIP_POLICY_INVALID), never a guessed default.
--
-- Typed handlers implemented: inventory.receive, inventory.adjust, inventory.count,
-- settings.device_revoke_request (self only). review.resolution_request is retired (it asked a person to
-- act) and is deterministically rejected. Every other operation has no handler yet ⇒ blocked_policy.
-- Client JSON never addresses a table: each handler reads only its validated, schema-checked fields and
-- writes only through the existing hardened domain functions (inventory_private.record_operation,
-- offline_pos_private.revoke_device). Additive/forward-only: no historical migration is modified.

alter table public.offline_pos_policies
  add column offline_intent_handler_policies jsonb not null default '{}'::jsonb,
  add constraint offline_pos_policies_intent_handler_policies_object
    check (jsonb_typeof(offline_intent_handler_policies) = 'object');

comment on column public.offline_pos_policies.offline_intent_handler_policies is
  'Owner-configured handler policy per offline intent operation ({"<operation>": {"version": text, ...limits}}). Absent ⇒ the server deterministically disposes the intent as blocked_policy. Configuration, not per-command approval.';

-- Disposition columns. Adding columns does not fire the immutability trigger; rows remain write-once.
alter table public.offline_operation_intents
  add column disposition_code text,
  add column disposition_detail jsonb not null default '{}'::jsonb,
  add column policy_version text,
  add column decided_at timestamptz;

alter table public.offline_operation_intents alter column adjudication_status drop default;
alter table public.offline_operation_intents drop constraint offline_operation_intents_adjudication;
-- NOT VALID: rows written by the superseded pre-adjudication function (disposable test databases only;
-- that migration was never deployed) keep their legacy value; every new row must carry a machine disposition.
alter table public.offline_operation_intents
  add constraint offline_operation_intents_disposition check (
    adjudication_status in ('applied', 'rejected', 'needs_reconciliation', 'blocked_policy')
    and disposition_code is not null and btrim(disposition_code) <> ''
    and decided_at is not null
    and jsonb_typeof(disposition_detail) = 'object'
  ) not valid;

comment on column public.offline_operation_intents.adjudication_status is
  'Final machine disposition decided atomically at ingestion: applied | rejected | needs_reconciliation | blocked_policy. Never waits for a person.';
comment on table public.offline_operation_intents is
  'Append-only, replay-safe signed offline operation intents with their automatic server disposition and safe outcome evidence.';

drop index if exists public.offline_operation_intents_review_queue;
create index offline_operation_intents_disposition_idx
  on public.offline_operation_intents (tenant_id, adjudication_status, operation, received_at);

-- The writer may post stock only through the hardened ledger function (same boundary as offline sales).
grant usage on schema inventory_private to offline_pos_writer;
grant execute on function inventory_private.record_operation(uuid, text, jsonb, uuid, text, timestamptz, text)
  to offline_pos_writer;

-- ---------------------------------------------------------------------------------------------------------
-- Typed handlers. Each returns (disposition, code, detail, policy_version). They run inside the caller's
-- transaction; any business write happens in a subtransaction that is rolled back on refusal, so a refused
-- command leaves no partial effect.
-- ---------------------------------------------------------------------------------------------------------

create function offline_pos_private.intent_policy_int(p_policy jsonb, p_key text)
returns bigint language sql immutable set search_path = '' as $function$
  select case when jsonb_typeof(p_policy -> p_key) = 'number'
                   and (p_policy ->> p_key) ~ '^[0-9]+$'
                   and (p_policy ->> p_key)::numeric between 1 and 1000000
              then (p_policy ->> p_key)::bigint end;
$function$;

create function offline_pos_private.adjudicate_inventory_intent(
  p_tenant_id uuid, p_grant public.offline_grants, p_operation text, p_payload jsonb, p_base_version text,
  p_sync uuid, p_accepted timestamptz, p_policy jsonb
) returns table(disposition text, code text, detail jsonb)
language plpgsql security definer set search_path = '' as $function$
declare
  v_variant uuid := (p_payload ->> 'variantId')::uuid;
  v_location uuid := p_grant.inventory_location_id;
  v_limit bigint; v_delta bigint; v_on_hand bigint; v_version bigint; v_operation uuid; v_type text;
  v_after bigint;
begin
  if v_location is null then
    return query select 'rejected', 'OIX_NO_LOCATION_SCOPE', jsonb_build_object(); return;
  end if;
  perform 1 from public.product_variants v where v.tenant_id = p_tenant_id and v.id = v_variant;
  if not found then
    return query select 'rejected', 'OIX_UNKNOWN_VARIANT', jsonb_build_object(); return;
  end if;

  -- Serialize with every other writer of this stock key (sales, storefront, other tills).
  v_on_hand := inventory_private.lock_balance_for_offline_sale(p_tenant_id, v_variant, v_location);
  select b.version into v_version from public.inventory_balances b
   where b.tenant_id = p_tenant_id and b.variant_id = v_variant and b.inventory_location_id = v_location;
  v_on_hand := coalesce(v_on_hand, 0); v_version := coalesce(v_version, 0);

  if p_operation = 'inventory.receive' then
    v_limit := offline_pos_private.intent_policy_int(p_policy, 'maxQuantity');
    if v_limit is null then return query select 'blocked_policy', 'OIP_POLICY_INVALID', jsonb_build_object('missing', 'maxQuantity'); return; end if;
    v_delta := (p_payload ->> 'quantity')::bigint;
    if v_delta > v_limit then
      return query select 'rejected', 'OIX_OVER_LIMIT', jsonb_build_object('limit', v_limit, 'requested', v_delta); return;
    end if;
    v_type := 'receipt';
  elsif p_operation = 'inventory.adjust' then
    v_limit := offline_pos_private.intent_policy_int(p_policy, 'maxAbsDelta');
    if v_limit is null then return query select 'blocked_policy', 'OIP_POLICY_INVALID', jsonb_build_object('missing', 'maxAbsDelta'); return; end if;
    v_delta := (p_payload ->> 'quantityDelta')::bigint;
    if abs(v_delta) > v_limit then
      return query select 'rejected', 'OIX_OVER_LIMIT', jsonb_build_object('limit', v_limit, 'requested', v_delta); return;
    end if;
    if v_on_hand + v_delta < 0 then
      -- No oversell tolerance is configured anywhere, so canonical stock never goes negative.
      return query select 'needs_reconciliation', 'OIX_INSUFFICIENT_STOCK',
        jsonb_build_object('onHand', v_on_hand, 'requested', v_delta); return;
    end if;
    v_type := 'adjustment';
  elsif p_operation = 'inventory.count' then
    v_limit := offline_pos_private.intent_policy_int(p_policy, 'maxAbsVariance');
    if v_limit is null then return query select 'blocked_policy', 'OIP_POLICY_INVALID', jsonb_build_object('missing', 'maxAbsVariance'); return; end if;
    -- A count is only meaningful against the canonical balance version the till counted from. Any canonical
    -- movement since then (storefront order, another till, a receipt) makes the count stale: never guess.
    if p_base_version is null or p_base_version !~ '^[0-9]+$' then
      return query select 'needs_reconciliation', 'OIX_NO_BASE_VERSION', jsonb_build_object('currentVersion', v_version); return;
    end if;
    if p_base_version::numeric <> v_version then
      return query select 'needs_reconciliation', 'OIX_STALE_BASE',
        jsonb_build_object('baseVersion', p_base_version, 'currentVersion', v_version); return;
    end if;
    v_delta := (p_payload ->> 'countedQuantity')::bigint - v_on_hand;
    if v_delta = 0 then
      return query select 'applied', 'OIA_COUNT_MATCHED',
        jsonb_build_object('onHandAfter', v_on_hand, 'quantityDelta', 0); return;
    end if;
    if abs(v_delta) > v_limit then
      return query select 'needs_reconciliation', 'OIX_VARIANCE_OVER_LIMIT',
        jsonb_build_object('limit', v_limit, 'variance', v_delta); return;
    end if;
    v_type := 'correction';
  else
    raise exception using errcode = '22023', message = 'not an inventory intent';
  end if;

  begin
    v_operation := inventory_private.record_operation(
      p_tenant_id, v_type,
      jsonb_build_array(jsonb_build_object('variant_id', v_variant, 'inventory_location_id', v_location,
        'quantity_delta', v_delta)),
      p_grant.operator_membership_id, 'offline-intent:' || p_sync::text, p_accepted,
      'Offline ' || p_operation || ' (automatic disposition)');
  exception when others then
    -- The ledger's own invariants (inactive location, negative balance, idempotency) refused the write.
    -- The subtransaction is rolled back, so there is no partial effect.
    return query select 'needs_reconciliation', 'OIX_LEDGER_REFUSED', jsonb_build_object('sqlstate', SQLSTATE); return;
  end;
  select b.on_hand_quantity into v_after from public.inventory_balances b
   where b.tenant_id = p_tenant_id and b.variant_id = v_variant and b.inventory_location_id = v_location;
  return query select 'applied', 'OIA_STOCK_POSTED',
    jsonb_build_object('inventoryOperationId', v_operation, 'quantityDelta', v_delta, 'onHandAfter', v_after);
end;
$function$;

create function offline_pos_private.adjudicate_intent(
  p_tenant_id uuid, p_grant public.offline_grants, p_operation text, p_payload jsonb, p_base_version text,
  p_depends uuid, p_sync uuid, p_accepted timestamptz, p_handler_policies jsonb
) returns table(disposition text, code text, detail jsonb, policy_version text)
language plpgsql security definer set search_path = '' as $function$
declare
  v_policy jsonb := p_handler_policies -> p_operation;
  v_version text; v_parent_status text; v_device_status text; v_result record;
begin
  if p_operation = 'review.resolution_request' then
    -- Retired: it asked a person to act. Operator reconciliation happens at the till; there is no human queue.
    return query select 'rejected', 'OIX_KIND_RETIRED', jsonb_build_object(), null::text; return;
  end if;
  if p_operation not in ('inventory.receive', 'inventory.adjust', 'inventory.count', 'settings.device_revoke_request') then
    return query select 'blocked_policy', 'OIP_HANDLER_NOT_IMPLEMENTED', jsonb_build_object(), null::text; return;
  end if;
  if v_policy is null or jsonb_typeof(v_policy) <> 'object' then
    return query select 'blocked_policy', 'OIP_POLICY_NOT_CONFIGURED', jsonb_build_object(), null::text; return;
  end if;
  v_version := v_policy ->> 'version';
  if v_version is null or btrim(v_version) = '' or length(v_version) > 64 then
    return query select 'blocked_policy', 'OIP_POLICY_INVALID', jsonb_build_object('missing', 'version'), null::text; return;
  end if;

  if p_depends is not null then
    select d.adjudication_status into v_parent_status from public.offline_operation_intents d
     where d.tenant_id = p_tenant_id and d.sync_command_id = p_depends;
    if v_parent_status is distinct from 'applied' then
      return query select 'needs_reconciliation', 'OIX_DEPENDENCY_NOT_APPLIED',
        jsonb_build_object('dependencyDisposition', v_parent_status), v_version; return;
    end if;
  end if;

  select d.status into v_device_status from public.devices d where d.tenant_id = p_tenant_id and d.id = p_grant.device_id;

  if p_operation = 'settings.device_revoke_request' then
    -- Self-revocation only: a till may give up its own authority, never another device's.
    if (p_payload ->> 'targetDeviceId')::uuid <> p_grant.device_id then
      return query select 'rejected', 'OIX_SCOPE_DENIED', jsonb_build_object(), v_version; return;
    end if;
    if v_device_status = 'revoked' then
      return query select 'applied', 'OIA_ALREADY_REVOKED', jsonb_build_object('deviceId', p_grant.device_id), v_version; return;
    end if;
    perform offline_pos_private.revoke_device(p_tenant_id, p_grant.device_id,
      left('offline self-revoke: ' || (p_payload ->> 'reason'), 500), 'offline-intent:' || p_sync::text);
    return query select 'applied', 'OIA_DEVICE_REVOKED', jsonb_build_object('deviceId', p_grant.device_id), v_version; return;
  end if;

  if v_device_status = 'revoked' then
    return query select 'needs_reconciliation', 'OIX_DEVICE_REVOKED', jsonb_build_object(), v_version; return;
  end if;

  select * into v_result from offline_pos_private.adjudicate_inventory_intent(
    p_tenant_id, p_grant, p_operation, p_payload, p_base_version, p_sync, p_accepted, v_policy);
  return query select v_result.disposition, v_result.code, v_result.detail, v_version;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Ingestion: same authority checks as before, then the disposition is decided and stored in one insert.
-- The return shape changes, so the function is replaced (drop + create) rather than edited in place.
-- ---------------------------------------------------------------------------------------------------------
drop function offline_pos_private.record_offline_intent(uuid, uuid, jsonb, text, text, text);

create function offline_pos_private.record_offline_intent(
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
  if not found or not v_policy.enabled or not (v_operation = any(v_policy.offline_intent_operations)) then
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

-- Ownership + least privilege (grant → transfer → revoke), mirroring 20261114120000.
grant create on schema offline_pos_private to offline_pos_writer;
alter function offline_pos_private.record_offline_intent(uuid,uuid,jsonb,text,text,text) owner to offline_pos_writer;
alter function offline_pos_private.adjudicate_intent(uuid,public.offline_grants,text,jsonb,text,uuid,uuid,timestamptz,jsonb) owner to offline_pos_writer;
alter function offline_pos_private.adjudicate_inventory_intent(uuid,public.offline_grants,text,jsonb,text,uuid,timestamptz,jsonb) owner to offline_pos_writer;
alter function offline_pos_private.intent_policy_int(jsonb,text) owner to offline_pos_writer;
revoke create on schema offline_pos_private from offline_pos_writer;

revoke all on function offline_pos_private.record_offline_intent(uuid,uuid,jsonb,text,text,text) from public;
revoke all on function offline_pos_private.adjudicate_intent(uuid,public.offline_grants,text,jsonb,text,uuid,uuid,timestamptz,jsonb) from public;
revoke all on function offline_pos_private.adjudicate_inventory_intent(uuid,public.offline_grants,text,jsonb,text,uuid,timestamptz,jsonb) from public;
revoke all on function offline_pos_private.intent_policy_int(jsonb,text) from public;

do $b$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='anon') then
    execute 'revoke all on function offline_pos_private.record_offline_intent(uuid,uuid,jsonb,text,text,text) from anon';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname='authenticated') then
    execute 'revoke all on function offline_pos_private.record_offline_intent(uuid,uuid,jsonb,text,text,text) from authenticated';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname='service_role') then
    -- Only the ingestion entry point is callable; the handlers are internal.
    execute 'grant execute on function offline_pos_private.record_offline_intent(uuid,uuid,jsonb,text,text,text) to service_role';
  end if;
end $b$;
