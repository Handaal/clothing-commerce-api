-- ADR-042 §7 + D-7 — OFFLINE RETURNS: admin credential flag and the owner's per-grant refund budget.
--
-- * return_settings.offline_refund_budget_minor (D-7): the most one offline return grant may refund. It is
--   REQUIRED: with no budget the server issues no offline return grant (fail closed; ADR-041 A-i no longer
--   defaults to the canonical ceiling). A grant refunds at most min(canonical ceiling, budget), cumulative
--   across the returns captured under it; going over holds the return for reconciliation (no refund).
-- * return_settings.offline_requires_admin_credentials: copied onto each grant at issuance
--   (offline_return_grants.requires_pos_admin_credentials). When set, every offline return command must carry
--   a valid one-use admin assertion for payments.refund (ADR-042 §6.3); otherwise it is held for
--   reconciliation. Refunds always settle online; offline ingestion never restocks (disposition non_restock),
--   and a later connected sellable restock of a POS order credits the POS bucket (20261114140000).

alter table public.return_settings
  add column offline_refund_budget_minor bigint
    check (offline_refund_budget_minor is null or offline_refund_budget_minor between 0 and 9007199254740991),
  add column offline_requires_admin_credentials boolean not null default false;
alter table public.offline_return_grants
  add column requires_pos_admin_credentials boolean not null default false;

alter table public.offline_return_reconciliations drop constraint offline_return_reconciliations_reason;
alter table public.offline_return_reconciliations add constraint offline_return_reconciliations_reason
  check (reason in ('eligibility_drift_at_ingestion', 'device_revoked_at_ingestion',
                    'admin_credential_invalid_at_ingestion', 'refund_budget_exceeded_at_ingestion'));

grant select on public.return_settings to offline_pos_writer;
create policy offline_pos_writer_return_settings_read on public.return_settings for select to offline_pos_writer using (true);

create or replace function offline_pos_private.issue_return_grant(
  p_tenant_id uuid, p_device_id uuid, p_register_id uuid, p_operator_membership_id uuid, p_order_id uuid, p_idempotency_key text
) returns setof public.offline_return_grants language plpgsql security definer set search_path = '' as $function$
declare v_policy public.offline_pos_policies%rowtype; v_branch uuid; v_location uuid; v_currency text;
  v_grant public.offline_return_grants%rowtype; v_now timestamptz := now(); v_eligibility jsonb; v_max bigint;
  v_budget bigint; v_requires boolean;
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
  -- ADR-042 D-7: the owner's per-grant offline refund budget is REQUIRED (no invented default). Without it no
  -- offline return grant is issued. The grant refunds at most min(canonical ceiling, budget).
  select s.offline_refund_budget_minor, s.offline_requires_admin_credentials into v_budget, v_requires
    from public.return_settings s where s.tenant_id = p_tenant_id;
  if v_budget is null then
    raise exception using errcode = 'RT423', message = 'offline return refund budget is not configured';
  end if;
  v_max := least((v_eligibility->>'maxRefundableMinor')::bigint, v_budget);
  insert into public.offline_return_grants(tenant_id, device_id, register_id, branch_id, inventory_location_id, operator_membership_id, order_id, currency,
    expires_at, max_refundable_minor, eligibility_snapshot, issuance_idempotency_key, issuance_fingerprint, requires_pos_admin_credentials)
  -- A-ii default: reuse the approved offline operator lease as the return-grant window.
  values(p_tenant_id, p_device_id, p_register_id, v_branch, v_location, p_operator_membership_id, p_order_id, v_currency,
    v_now + pg_catalog.make_interval(secs => v_policy.operator_lease_seconds), v_max, v_eligibility, p_idempotency_key, v_fingerprint,
    coalesce(v_requires, false))
  returning * into v_grant;
  return next v_grant;
end;
$function$;

create or replace function offline_pos_private.record_offline_return(
  p_tenant_id uuid, p_credential_id uuid, p_command jsonb, p_canonical text, p_fingerprint text, p_signature text
) returns table(ingestion_id uuid, sync_status text, return_id uuid, refund_id uuid, refund_amount_minor bigint, refund_currency text, reconciliation_id uuid, received_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_return_grants%rowtype; v_existing public.offline_return_ingestions%rowtype;
  v_device_status text; v_received timestamptz := now(); v_accepted timestamptz; v_sync uuid;
  v_element jsonb; v_snap_line jsonb; v_intent_lines jsonb := '[]'; v_intent jsonb; v_detail jsonb;
  v_return uuid; v_refund uuid; v_refund_amount bigint; v_refund_currency text;
  v_ingestion uuid; v_reconciliation uuid; v_reason text; v_held boolean := false; v_credential text; v_prior bigint; v_assert_grant uuid;
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
  -- ADR-042 §6/§7: when the grant requires an admin credential, a missing/invalid/reused assertion holds the
  -- return for reconciliation (no refund is created). The assertion is consumed once per command.
  -- Verifiers are issued per offline (sale) grant at bootstrap, so the assertion names that grant; it must
  -- belong to the same device and cover the return's acceptance time.
  if v_grant.requires_pos_admin_credentials then
    v_assert_grant := nullif(p_command->'adminAssertion'->>'offlineGrantId', '')::uuid;
    if v_assert_grant is null or not exists (
         select 1 from public.offline_grants og
          where og.tenant_id = p_tenant_id and og.id = v_assert_grant and og.device_id = v_grant.device_id
            and v_accepted between og.issued_at - interval '5 minutes' and og.accepted_until) then
      v_credential := case when p_command ? 'adminAssertion' then 'CREDENTIAL_NOT_ISSUED' else 'CREDENTIAL_MISSING' end;
    else
      v_credential := offline_pos_private.consume_admin_assertion(p_tenant_id, v_assert_grant, v_sync, p_command->'adminAssertion', 'payments.refund');
    end if;
  end if;
  if v_device_status = 'revoked' then
    -- Not dropped: retain the signed command, open governed reconciliation, create no canonical return.
    v_held := true; v_reason := 'device_revoked_at_ingestion';
  elsif v_credential is not null then
    v_held := true; v_reason := 'admin_credential_invalid_at_ingestion';
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
      -- ADR-042 D-7: the grant's refund budget (cumulative across its returns). Over it => undo and hold.
      select coalesce(sum(i.refund_amount_minor), 0) into v_prior from public.offline_return_ingestions i
       where i.tenant_id = p_tenant_id and i.return_grant_id = v_grant.id and i.sync_status = 'synced';
      if v_prior + coalesce(v_refund_amount, 0) > v_grant.max_refundable_minor then
        raise exception using errcode = 'RTCAP', message = 'offline refund budget exceeded';
      end if;
    exception
      when sqlstate 'RTCAP' then
        v_held := true; v_reason := 'refund_budget_exceeded_at_ingestion';
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

create or replace function settings_private.return_settings_json(s public.return_settings) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('tenantId', s.tenant_id, 'enabled', s.enabled, 'windowDays', s.window_days,
    'allowedReasons', to_jsonb(coalesce(s.allowed_reasons, array[]::text[])),
    'manualRefundsEnabled', s.manual_refunds_enabled, 'maxManualRefundMinor', s.max_manual_refund_minor,
    'offlineRefundBudgetMinor', s.offline_refund_budget_minor,
    'offlineRequiresAdminCredentials', s.offline_requires_admin_credentials)
$f$;

create or replace function settings_private.get_return_settings(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare s public.return_settings;
begin
  select * into s from public.return_settings where tenant_id = p_tenant;
  if not found then
    -- Unconfigured returns are a valid, safe default state, not a 404.
    return jsonb_build_object('tenantId', p_tenant, 'enabled', false, 'windowDays', null,
      'allowedReasons', '[]'::jsonb, 'manualRefundsEnabled', false, 'maxManualRefundMinor', null,
      'offlineRefundBudgetMinor', null, 'offlineRequiresAdminCredentials', false);
  end if;
  return settings_private.return_settings_json(s);
end;
$f$;

create or replace function settings_private.write_return_settings(p_tenant uuid, p_actor uuid, p_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_cur public.return_settings; v_row public.return_settings;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid return-settings command'; end if;
  perform settings_private.only_keys(p_input, array['enabled', 'windowDays', 'manualRefundsEnabled',
    'maxManualRefundMinor', 'allowedReasons', 'offlineRefundBudgetMinor', 'offlineRequiresAdminCredentials']);
  v_intent := jsonb_build_object('op', 'write_return_settings', 'actor', p_actor, 'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  select * into v_cur from public.return_settings where tenant_id = p_tenant for update;
  if not found then
    insert into public.return_settings (tenant_id, enabled, window_days, allowed_reasons,
      manual_refunds_enabled, max_manual_refund_minor, offline_refund_budget_minor, offline_requires_admin_credentials)
    values (p_tenant, coalesce((p_input ->> 'enabled')::boolean, false),
      case when p_input ? 'windowDays' then (p_input ->> 'windowDays')::integer else null end,
      settings_private.text_array(p_input -> 'allowedReasons'),
      coalesce((p_input ->> 'manualRefundsEnabled')::boolean, false),
      case when p_input ? 'maxManualRefundMinor' then (p_input ->> 'maxManualRefundMinor')::bigint else null end,
      case when p_input ? 'offlineRefundBudgetMinor' then (p_input ->> 'offlineRefundBudgetMinor')::bigint else null end,
      coalesce((p_input ->> 'offlineRequiresAdminCredentials')::boolean, false))
    returning * into v_row;
  else
    update public.return_settings set
      enabled = case when p_input ? 'enabled' then (p_input ->> 'enabled')::boolean else enabled end,
      window_days = case when p_input ? 'windowDays' then (p_input ->> 'windowDays')::integer else window_days end,
      allowed_reasons = case when p_input ? 'allowedReasons' then settings_private.text_array(p_input -> 'allowedReasons') else allowed_reasons end,
      manual_refunds_enabled = case when p_input ? 'manualRefundsEnabled' then (p_input ->> 'manualRefundsEnabled')::boolean else manual_refunds_enabled end,
      max_manual_refund_minor = case when p_input ? 'maxManualRefundMinor' then (p_input ->> 'maxManualRefundMinor')::bigint else max_manual_refund_minor end,
      offline_refund_budget_minor = case when p_input ? 'offlineRefundBudgetMinor' then (p_input ->> 'offlineRefundBudgetMinor')::bigint else offline_refund_budget_minor end,
      offline_requires_admin_credentials = case when p_input ? 'offlineRequiresAdminCredentials' then (p_input ->> 'offlineRequiresAdminCredentials')::boolean else offline_requires_admin_credentials end
    where tenant_id = p_tenant returning * into v_row;
  end if;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.return_settings_json(v_row));
end;
$f$;
