-- ADR-042 §13 — ONLINE-FIRST POS, BOUNDED EMERGENCY OFFLINE, POST-SYNC CONFLICT REPORTING
-- (owner decision 2026-11-14 night). Forward-only and additive. Nothing applied earlier is edited or dropped.
--
-- Part A  Retire the superseded Website/POS stock split, per-till stock grants, reserved voucher quota grants
--         and offline returns. Their tables stay (dormant, history preserved); every location is pinned to the
--         original shared-stock behaviour ('legacy') and the issuing entry points lose their grants.
-- Part B  pos_sync_conflicts: one structured, immutable, idempotent conflict record per business conflict
--         detected while syncing an offline command. Report/reconciliation only — no approval, no mutation of
--         the original sale/payment/customer/voucher/attendance record.
-- Part C  offline_conflict_ingestions: a signed offline paydown or attendance event that business state
--         refuses (CA409 / AT409 / AT404) is preserved once as evidence with a conflict row instead of being
--         lost on the till. The AR ledger and attendance timeline are NOT changed by such a command.

-- =========================================================================================================
-- Part A — retire the superseded stock-split / grant / offline-return entry points
-- =========================================================================================================

create function inventory_private.forbid_channel_stock_mode()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if new.channel_stock_mode is distinct from 'legacy' then
    raise exception using errcode = 'CH410',
      message = 'Website/POS stock channels are superseded (ADR-042 §13); stock is one shared pool';
  end if;
  return new;
end;
$function$;
revoke all on function inventory_private.forbid_channel_stock_mode() from public;

create trigger inventory_locations_shared_stock_only
  before insert or update of channel_stock_mode on public.inventory_locations
  for each row execute function inventory_private.forbid_channel_stock_mode();

comment on trigger inventory_locations_shared_stock_only on public.inventory_locations is
  'ADR-042 §13: every location stays on the original shared-stock behaviour (legacy). The channel-pool tables are dormant history.';

do $revoke$
declare
  v_fn regprocedure;
  v_role text;
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where (n.nspname, p.proname) in (
       ('inventory_private', 'initialize_channel_stock'),
       ('inventory_private', 'allocate_channel_stock'),
       ('inventory_private', 'allocate_channel_stock_v2'),
       ('inventory_private', 'issue_offline_stock_grant'),
       ('promotions_private', 'issue_offline_voucher_grants'),
       ('offline_pos_private', 'issue_return_grant'),
       ('offline_pos_private', 'record_offline_return'))
  loop
    execute pg_catalog.format('revoke execute on function %s from public', v_fn);
    foreach v_role in array array['service_role', 'authenticated', 'anon'] loop
      if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
        execute pg_catalog.format('revoke execute on function %s from %I', v_fn, v_role);
      end if;
    end loop;
  end loop;
end
$revoke$;

-- =========================================================================================================
-- Part B — pos_sync_conflicts
-- =========================================================================================================

create table public.pos_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  dedupe_key text not null,
  kind text not null,
  reason_code text not null,
  status text not null default 'open',
  branch_id uuid,
  inventory_location_id uuid,
  device_id uuid,
  register_id uuid,
  grant_id uuid,
  source_table text not null,
  source_id uuid not null,
  sync_command_id uuid,
  local_reference text,
  order_id uuid,
  payment_id uuid,
  customer_id uuid,
  promotion_id uuid,
  membership_id uuid,
  variant_id uuid,
  quantity bigint,
  amount_minor bigint,
  currency text,
  local_evidence jsonb not null default '{}'::jsonb,
  server_evidence jsonb not null default '{}'::jsonb,
  local_event_at timestamptz,
  detected_at timestamptz not null default now(),
  constraint pos_sync_conflicts_kind check (kind in (
    'stock_shortfall', 'voucher', 'customer_duplicate', 'customer_debt', 'attendance', 'dependency',
    'sync_integrity')),
  constraint pos_sync_conflicts_status check (status in ('open', 'informational')),
  constraint pos_sync_conflicts_reason check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  constraint pos_sync_conflicts_dedupe check (btrim(dedupe_key) <> ''),
  constraint pos_sync_conflicts_evidence check (
    jsonb_typeof(local_evidence) = 'object' and jsonb_typeof(server_evidence) = 'object'),
  constraint pos_sync_conflicts_currency check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint pos_sync_conflicts_dedupe_unique unique (tenant_id, dedupe_key),
  constraint pos_sync_conflicts_tenant_id_unique unique (tenant_id, id)
);
create index pos_sync_conflicts_recent_idx on public.pos_sync_conflicts (tenant_id, detected_at desc, id);
create index pos_sync_conflicts_kind_idx on public.pos_sync_conflicts (tenant_id, status, kind);
create index pos_sync_conflicts_command_idx on public.pos_sync_conflicts (tenant_id, sync_command_id);

comment on table public.pos_sync_conflicts is
  'ADR-042 §13.5: structured post-sync conflicts of bounded emergency offline POS operation (shared-stock shortfall, voucher, duplicate customer, stale debt, attendance, dependency, integrity). Report only: never an approval queue, never mutates the source record. No customer name/phone is stored here.';

alter table public.pos_sync_conflicts enable row level security;
revoke all on public.pos_sync_conflicts from public;
create trigger pos_sync_conflicts_immutable
  before update or delete on public.pos_sync_conflicts
  for each row execute function offline_pos_private.forbid_immutable_mutation();

-- One idempotent writer used by every detector below.
create function offline_pos_private.record_sync_conflict(p_row public.pos_sync_conflicts)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare v_id uuid;
begin
  insert into public.pos_sync_conflicts (
    tenant_id, dedupe_key, kind, reason_code, status, branch_id, inventory_location_id, device_id,
    register_id, grant_id, source_table, source_id, sync_command_id, local_reference, order_id, payment_id,
    customer_id, promotion_id, membership_id, variant_id, quantity, amount_minor, currency, local_evidence,
    server_evidence, local_event_at)
  values (
    p_row.tenant_id, p_row.dedupe_key, p_row.kind, p_row.reason_code, coalesce(p_row.status, 'open'),
    p_row.branch_id, p_row.inventory_location_id, p_row.device_id, p_row.register_id, p_row.grant_id,
    p_row.source_table, p_row.source_id, p_row.sync_command_id, p_row.local_reference, p_row.order_id,
    p_row.payment_id, p_row.customer_id, p_row.promotion_id, p_row.membership_id, p_row.variant_id,
    p_row.quantity, p_row.amount_minor, p_row.currency, coalesce(p_row.local_evidence, '{}'::jsonb),
    coalesce(p_row.server_evidence, '{}'::jsonb), p_row.local_event_at)
  on conflict (tenant_id, dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    select c.id into v_id from public.pos_sync_conflicts c
     where c.tenant_id = p_row.tenant_id and c.dedupe_key = p_row.dedupe_key;
  end if;
  return v_id;
end;
$function$;
revoke all on function offline_pos_private.record_sync_conflict(public.pos_sync_conflicts) from public;

-- ---------------------------------------------------------------------------------------------------------
-- B.1  Shared-stock shortfall (and device-revoked integrity) from an offline sale reconciliation.
--      record_offline_sale already: wrote the order + payment(s) (+ debt) exactly once, posted NO stock
--      movement for the sale, left the order unfulfilled and inserted offline_reconciliations. This trigger
--      runs in that same transaction and records the evidence. inventory_balances is not touched.
-- ---------------------------------------------------------------------------------------------------------
create function offline_pos_private.conflicts_from_sale_reconciliation()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_ing public.offline_sale_ingestions%rowtype;
  v_grant public.offline_grants%rowtype;
  v_cmd jsonb;
  v_lines jsonb;
  v_line record;
  v_on_hand bigint;
  v_version bigint;
  v_variant jsonb;
  v_since timestamptz;
  v_movements jsonb;
  v_row public.pos_sync_conflicts;
  v_short integer := 0;
begin
  select * into v_ing from public.offline_sale_ingestions
   where tenant_id = new.tenant_id and id = new.ingestion_id;
  select * into v_grant from public.offline_grants
   where tenant_id = new.tenant_id and id = v_ing.grant_id;
  v_cmd := v_ing.canonical_command::jsonb;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'variantId', l.variant_id, 'quantity', l.quantity) order by l.variant_id), '[]'::jsonb)
    into v_lines
    from (select (e.value->>'variantId')::uuid as variant_id, sum((e.value->>'quantity')::bigint) as quantity
            from pg_catalog.jsonb_array_elements(v_cmd->'lines') e(value) group by 1) l;

  v_row.tenant_id := new.tenant_id;
  v_row.branch_id := v_ing.branch_id;
  v_row.inventory_location_id := v_ing.inventory_location_id;
  v_row.device_id := v_ing.device_id;
  v_row.register_id := v_ing.register_id;
  v_row.grant_id := v_ing.grant_id;
  v_row.source_table := 'offline_reconciliations';
  v_row.source_id := new.id;
  v_row.sync_command_id := v_ing.sync_command_id;
  v_row.local_reference := v_ing.local_sale_id;
  v_row.order_id := new.order_id;
  v_row.payment_id := new.payment_id;
  v_row.currency := v_grant.currency;
  v_row.local_event_at := v_ing.accepted_at;

  if new.reason = 'device_revoked_at_ingestion' then
    v_row.dedupe_key := 'integrity:' || v_ing.sync_command_id::text;
    v_row.kind := 'sync_integrity';
    v_row.reason_code := 'DEVICE_REVOKED_AT_INGESTION';
    v_row.amount_minor := (v_ing.price_provenance->>'totalMinor')::bigint;
    v_row.local_evidence := pg_catalog.jsonb_build_object('localSaleId', v_ing.local_sale_id,
      'acceptedAt', v_ing.accepted_at, 'lines', v_lines);
    v_row.server_evidence := pg_catalog.jsonb_build_object('saleRecorded', true, 'stockPosted', false,
      'orderFulfilled', false, 'reconciliationReason', new.reason);
    perform offline_pos_private.record_sync_conflict(v_row);
    return new;
  end if;

  for v_line in
    select (x.value->>'variantId')::uuid as variant_id, (x.value->>'quantity')::bigint as quantity
      from pg_catalog.jsonb_array_elements(v_lines) x(value)
  loop
    select b.on_hand_quantity, b.version into v_on_hand, v_version
      from public.inventory_balances b
     where b.tenant_id = new.tenant_id and b.variant_id = v_line.variant_id
       and b.inventory_location_id = v_ing.inventory_location_id;
    v_on_hand := coalesce(v_on_hand, 0);
    if v_line.quantity <= v_on_hand then continue; end if;
    v_short := v_short + 1;

    select vv.value into v_variant
      from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) p(value),
           lateral pg_catalog.jsonb_array_elements(p.value->'variants') vv(value)
     where vv.value->>'variantId' = v_line.variant_id::text
     limit 1;
    v_since := coalesce((v_variant->'advisoryInventory'->>'asOf')::timestamptz, v_grant.issued_at);
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'movementId', m.id, 'operationId', o.id, 'operationType', o.operation_type,
             'quantityDelta', m.quantity_delta, 'recordedAt', m.recorded_at,
             'orderId', f.order_id, 'orderChannel', ord.channel) order by m.recorded_at, m.id),
           '[]'::jsonb)
      into v_movements
      from (select * from public.inventory_movements im
             where im.tenant_id = new.tenant_id and im.variant_id = v_line.variant_id
               and im.inventory_location_id = v_ing.inventory_location_id and im.recorded_at > v_since
             order by im.recorded_at, im.id limit 50) m
      join public.inventory_operations o on o.tenant_id = m.tenant_id and o.id = m.operation_id
      left join public.fulfillments f on f.tenant_id = o.tenant_id and f.inventory_operation_id = o.id
      left join public.orders ord on ord.tenant_id = f.tenant_id and ord.id = f.order_id;

    v_row.dedupe_key := 'stock:' || v_ing.sync_command_id::text || ':' || v_line.variant_id::text;
    v_row.kind := 'stock_shortfall';
    v_row.reason_code := 'STOCK_SHORTFALL_AT_SYNC';
    v_row.variant_id := v_line.variant_id;
    v_row.quantity := v_line.quantity - greatest(v_on_hand, 0);
    v_row.amount_minor := null;
    v_row.local_evidence := pg_catalog.jsonb_build_object(
      'localSaleId', v_ing.local_sale_id, 'acceptedAt', v_ing.accepted_at,
      'sku', v_variant->>'sku', 'requestedQuantity', v_line.quantity,
      'cachedOnHand', (v_variant->'advisoryInventory'->>'onHandQuantity')::bigint,
      'cachedBalanceVersion', (v_variant->'advisoryInventory'->>'version')::bigint,
      'cachedAsOf', v_variant->'advisoryInventory'->>'asOf',
      'snapshotIssuedAt', v_grant.issued_at);
    v_row.server_evidence := pg_catalog.jsonb_build_object(
      'canonicalOnHandAtSync', v_on_hand, 'canonicalBalanceVersion', coalesce(v_version, 0),
      'shortfallQuantity', v_line.quantity - greatest(v_on_hand, 0),
      'interveningMovements', v_movements, 'saleLines', v_lines,
      'saleRecorded', true, 'stockPostedForSale', false, 'orderFulfilled', false,
      'canonicalDisposition',
        'inventory_balances unchanged by this sale; the shortfall is reported here and corrected through online inventory/order workflows');
    perform offline_pos_private.record_sync_conflict(v_row);
  end loop;

  if v_short = 0 then
    -- Defensive: a reconciliation with no short line (should not happen at a legacy location).
    v_row.dedupe_key := 'integrity:' || v_ing.sync_command_id::text;
    v_row.kind := 'sync_integrity';
    v_row.reason_code := 'RECONCILIATION_WITHOUT_SHORTFALL';
    v_row.variant_id := null;
    v_row.quantity := null;
    v_row.local_evidence := pg_catalog.jsonb_build_object('localSaleId', v_ing.local_sale_id, 'lines', v_lines);
    v_row.server_evidence := pg_catalog.jsonb_build_object('reconciliationReason', new.reason,
      'saleRecorded', true, 'stockPostedForSale', false);
    perform offline_pos_private.record_sync_conflict(v_row);
  end if;
  return new;
end;
$function$;
revoke all on function offline_pos_private.conflicts_from_sale_reconciliation() from public;
create trigger offline_reconciliations_sync_conflicts
  after insert on public.offline_reconciliations
  for each row execute function offline_pos_private.conflicts_from_sale_reconciliation();

-- ---------------------------------------------------------------------------------------------------------
-- B.2  Voucher exceptions (D-2 evidence table from 20261114170000): sale stands at the price paid.
-- ---------------------------------------------------------------------------------------------------------
create function offline_pos_private.conflicts_from_voucher_exception()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_ing public.offline_sale_ingestions%rowtype; v_row public.pos_sync_conflicts;
begin
  select * into v_ing from public.offline_sale_ingestions
   where tenant_id = new.tenant_id and sync_command_id = new.sync_command_id;
  v_row.tenant_id := new.tenant_id;
  v_row.dedupe_key := 'voucher:' || new.id::text;
  v_row.kind := 'voucher';
  v_row.reason_code := new.code;
  v_row.branch_id := v_ing.branch_id;
  v_row.inventory_location_id := v_ing.inventory_location_id;
  v_row.device_id := v_ing.device_id;
  v_row.register_id := v_ing.register_id;
  v_row.grant_id := new.offline_grant_id;
  v_row.source_table := 'offline_voucher_exceptions';
  v_row.source_id := new.id;
  v_row.sync_command_id := new.sync_command_id;
  v_row.local_reference := v_ing.local_sale_id;
  v_row.order_id := new.order_id;
  v_row.promotion_id := new.promotion_id;
  v_row.amount_minor := new.discount_total_minor;
  v_row.local_event_at := v_ing.accepted_at;
  v_row.local_evidence := pg_catalog.jsonb_build_object('discountTotalMinor', new.discount_total_minor,
    'codeId', new.code_id, 'voucherGrantId', new.voucher_grant_id);
  v_row.server_evidence := pg_catalog.jsonb_build_object('exceptionCode', new.code,
    'saleStandsAtPricePaid', true, 'redemptionApproved', false);
  perform offline_pos_private.record_sync_conflict(v_row);
  return new;
end;
$function$;
revoke all on function offline_pos_private.conflicts_from_voucher_exception() from public;
create trigger offline_voucher_exceptions_sync_conflicts
  after insert on public.offline_voucher_exceptions
  for each row execute function offline_pos_private.conflicts_from_voucher_exception();

-- ---------------------------------------------------------------------------------------------------------
-- B.3  Possible duplicate customer created offline (flagged, never merged). Ids only — no name/phone.
-- ---------------------------------------------------------------------------------------------------------
create function offline_pos_private.conflicts_from_offline_customer()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_grants%rowtype; v_row public.pos_sync_conflicts;
begin
  if new.duplicate_of_customer_id is null then return new; end if;
  select * into v_grant from public.offline_grants where tenant_id = new.tenant_id and id = new.grant_id;
  v_row.tenant_id := new.tenant_id;
  v_row.dedupe_key := 'customer:' || new.sync_command_id::text;
  v_row.kind := 'customer_duplicate';
  v_row.reason_code := 'POSSIBLE_DUPLICATE_CUSTOMER';
  v_row.status := 'informational';
  v_row.branch_id := v_grant.branch_id;
  v_row.inventory_location_id := v_grant.inventory_location_id;
  v_row.device_id := new.device_id;
  v_row.register_id := new.register_id;
  v_row.grant_id := new.grant_id;
  v_row.source_table := 'offline_customer_ingestions';
  v_row.source_id := new.id;
  v_row.sync_command_id := new.sync_command_id;
  v_row.local_reference := new.local_customer_id::text;
  v_row.customer_id := new.customer_id;
  v_row.local_event_at := new.accepted_at;
  v_row.local_evidence := pg_catalog.jsonb_build_object('localCustomerId', new.local_customer_id);
  v_row.server_evidence := pg_catalog.jsonb_build_object('createdCustomerId', new.customer_id,
    'possibleDuplicateOfCustomerId', new.duplicate_of_customer_id, 'matchedOn', 'normalized_phone',
    'merged', false);
  perform offline_pos_private.record_sync_conflict(v_row);
  return new;
end;
$function$;
revoke all on function offline_pos_private.conflicts_from_offline_customer() from public;
create trigger offline_customer_ingestions_sync_conflicts
  after insert on public.offline_customer_ingestions
  for each row execute function offline_pos_private.conflicts_from_offline_customer();

-- ---------------------------------------------------------------------------------------------------------
-- B.4  Sale held because its offline-created customer was rejected (20261115120000): dependency conflict.
-- ---------------------------------------------------------------------------------------------------------
create function offline_pos_private.conflicts_from_sale_hold()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_grants%rowtype; v_row public.pos_sync_conflicts;
begin
  select * into v_grant from public.offline_grants where tenant_id = new.tenant_id and id = new.grant_id;
  v_row.tenant_id := new.tenant_id;
  v_row.dedupe_key := 'dependency:' || new.sale_sync_command_id::text;
  v_row.kind := 'dependency';
  v_row.reason_code := 'CUSTOMER_DEPENDENCY_REJECTED';
  v_row.branch_id := v_grant.branch_id;
  v_row.inventory_location_id := v_grant.inventory_location_id;
  v_row.device_id := new.device_id;
  v_row.register_id := new.register_id;
  v_row.grant_id := new.grant_id;
  v_row.source_table := 'offline_sale_reconciliation_holds';
  v_row.source_id := new.id;
  v_row.sync_command_id := new.sale_sync_command_id;
  v_row.local_reference := new.local_sale_id;
  v_row.customer_id := new.customer_id;
  v_row.currency := v_grant.currency;
  v_row.amount_minor := (new.sale_canonical_command::jsonb->>'totalMinor')::bigint;
  v_row.local_event_at := new.sale_accepted_at;
  v_row.local_evidence := pg_catalog.jsonb_build_object('localSaleId', new.local_sale_id,
    'offlineSaleOrdinal', new.offline_sale_ordinal, 'heldLines', new.held_lines);
  v_row.server_evidence := pg_catalog.jsonb_build_object('signedSaleRetained', true, 'saleApplied', false,
    'holdStatus', new.status, 'reason', new.reason);
  perform offline_pos_private.record_sync_conflict(v_row);
  return new;
end;
$function$;
revoke all on function offline_pos_private.conflicts_from_sale_hold() from public;
create trigger offline_sale_holds_sync_conflicts
  after insert on public.offline_sale_reconciliation_holds
  for each row execute function offline_pos_private.conflicts_from_sale_hold();

-- =========================================================================================================
-- Part C — preserve refused offline paydowns / attendance events as signed evidence
-- =========================================================================================================

create table public.offline_conflict_ingestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  command_kind text not null,
  grant_id uuid not null,
  device_id uuid not null,
  credential_id uuid not null,
  register_id uuid not null,
  sync_command_id uuid not null,
  local_reference text not null,
  command_fingerprint text not null,
  canonical_command text not null,
  device_signature_base64 text not null,
  refusal_code text not null,
  conflict_id uuid not null,
  accepted_at timestamptz not null,
  received_at timestamptz not null default now(),
  constraint offline_conflict_ingestions_kind check (command_kind in ('customer_payment', 'attendance')),
  constraint offline_conflict_ingestions_refusal check (refusal_code in ('CA409', 'AT409', 'AT404')),
  constraint offline_conflict_ingestions_fingerprint check (command_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint offline_conflict_ingestions_grant_fk foreign key (tenant_id, grant_id)
    references public.offline_grants (tenant_id, id) on delete restrict,
  constraint offline_conflict_ingestions_credential_fk foreign key (tenant_id, credential_id)
    references public.device_credentials (tenant_id, id) on delete restrict,
  constraint offline_conflict_ingestions_conflict_fk foreign key (tenant_id, conflict_id)
    references public.pos_sync_conflicts (tenant_id, id) on delete restrict,
  constraint offline_conflict_ingestions_sync_unique unique (tenant_id, sync_command_id)
);
alter table public.offline_conflict_ingestions enable row level security;
revoke all on public.offline_conflict_ingestions from public;
create trigger offline_conflict_ingestions_immutable
  before update or delete on public.offline_conflict_ingestions
  for each row execute function offline_pos_private.forbid_immutable_mutation();

comment on table public.offline_conflict_ingestions is
  'ADR-042 §13.5: signed offline paydown/attendance commands refused by business state at sync (CA409/AT409/AT404), kept once as evidence with a pos_sync_conflicts row. Not applied to the AR ledger or attendance timeline.';

-- A command is either applied OR preserved as a conflict, never both: both paths take the same advisory lock.
create function offline_pos_private.sync_command_lock(p_tenant_id uuid, p_sync uuid)
returns void language sql set search_path = '' as $function$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('offline-sync-command:' || p_tenant_id::text || ':' || p_sync::text, 0));
$function$;
revoke all on function offline_pos_private.sync_command_lock(uuid, uuid) from public;

create function offline_pos_private.forbid_apply_after_conflict()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform offline_pos_private.sync_command_lock(new.tenant_id, new.sync_command_id);
  if exists (select 1 from public.offline_conflict_ingestions c
              where c.tenant_id = new.tenant_id and c.sync_command_id = new.sync_command_id) then
    raise exception using errcode = 'ID409',
      message = 'offline command was already preserved as a sync conflict';
  end if;
  return new;
end;
$function$;
revoke all on function offline_pos_private.forbid_apply_after_conflict() from public;
create trigger offline_payment_ingestions_not_conflicted
  before insert on public.offline_payment_ingestions
  for each row execute function offline_pos_private.forbid_apply_after_conflict();
create trigger offline_attendance_ingestions_not_conflicted
  before insert on public.offline_attendance_ingestions
  for each row execute function offline_pos_private.forbid_apply_after_conflict();

create function offline_pos_private.record_offline_conflict(
  p_tenant_id uuid, p_credential_id uuid, p_kind text, p_command jsonb, p_canonical text,
  p_fingerprint text, p_signature text, p_refusal_code text)
returns table(conflict_ingestion_id uuid, conflict_id uuid, reason_code text, received_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare
  v_sync uuid := (p_command->>'syncCommandId')::uuid;
  v_existing public.offline_conflict_ingestions%rowtype;
  v_grant public.offline_grants%rowtype;
  v_accepted timestamptz := (p_command->>'acceptedAt')::timestamptz;
  v_received timestamptz := pg_catalog.now();
  v_row public.pos_sync_conflicts;
  v_conflict uuid;
  v_ingestion uuid;
  v_local text;
begin
  if p_kind not in ('customer_payment', 'attendance') or p_refusal_code not in ('CA409', 'AT409', 'AT404')
     or (p_kind = 'customer_payment' and p_refusal_code <> 'CA409')
     or (p_kind = 'attendance' and p_refusal_code = 'CA409') or v_sync is null then
    raise exception using errcode = '22023', message = 'invalid offline conflict';
  end if;
  perform offline_pos_private.sync_command_lock(p_tenant_id, v_sync);
  select * into v_existing from public.offline_conflict_ingestions
   where tenant_id = p_tenant_id and sync_command_id = v_sync;
  if found then
    if v_existing.command_fingerprint <> p_fingerprint then
      raise exception using errcode = 'ID409', message = 'offline idempotency conflict';
    end if;
    return query select v_existing.id, v_existing.conflict_id,
      (select c.reason_code from public.pos_sync_conflicts c
        where c.tenant_id = p_tenant_id and c.id = v_existing.conflict_id), v_existing.received_at;
    return;
  end if;
  if exists (select 1 from public.offline_payment_ingestions i
              where i.tenant_id = p_tenant_id and i.sync_command_id = v_sync)
     or exists (select 1 from public.offline_attendance_ingestions i
                 where i.tenant_id = p_tenant_id and i.sync_command_id = v_sync) then
    raise exception using errcode = 'ID409', message = 'offline command was already applied';
  end if;

  -- Same binding / credential / acceptance-window checks as the applying functions.
  select * into v_grant from public.offline_grants
   where tenant_id = p_tenant_id and id = (p_command->>'grantId')::uuid;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;
  if (p_command->>'deviceId')::uuid <> v_grant.device_id
     or (p_command->>'registerId')::uuid <> v_grant.register_id then
    raise exception using errcode = 'OG403', message = 'grant binding mismatch';
  end if;
  if (p_command->>'schemaVersion')::integer <> v_grant.schema_version then
    raise exception using errcode = 'OG422', message = 'schema version unsupported';
  end if;
  if v_accepted is null or v_accepted < v_grant.issued_at - interval '5 minutes'
     or v_accepted > v_grant.accepted_until or v_accepted > v_received + interval '5 minutes' then
    raise exception using errcode = 'OG410', message = 'acceptedAt outside grant authority';
  end if;
  perform 1 from public.device_credentials c
   where c.tenant_id = p_tenant_id and c.id = p_credential_id and c.device_id = v_grant.device_id
     and c.valid_from <= v_accepted and (c.valid_to is null or c.valid_to >= v_accepted);
  if not found then raise exception using errcode = 'OS401', message = 'credential not valid at acceptance'; end if;

  v_row.tenant_id := p_tenant_id;
  v_row.dedupe_key := p_kind || ':' || v_sync::text;
  v_row.branch_id := v_grant.branch_id;
  v_row.inventory_location_id := v_grant.inventory_location_id;
  v_row.device_id := v_grant.device_id;
  v_row.register_id := v_grant.register_id;
  v_row.grant_id := v_grant.id;
  v_row.sync_command_id := v_sync;
  v_row.local_event_at := v_accepted;
  v_row.source_table := 'offline_conflict_ingestions';
  v_ingestion := gen_random_uuid();
  v_row.source_id := v_ingestion;

  -- Defence in depth: the same command-level checks that ran before the business refusal.
  if p_kind = 'customer_payment' then
    if p_command->>'currency' is distinct from v_grant.currency then
      raise exception using errcode = 'OG403', message = 'grant binding mismatch';
    end if;
    if coalesce((p_command->>'amountMinor')::bigint, 0) <= 0 then
      raise exception using errcode = 'OS422', message = 'invalid payment amount';
    end if;
    if not exists (select 1 from public.customers cu
                    where cu.tenant_id = p_tenant_id and cu.id = (p_command->>'customerId')::uuid) then
      raise exception using errcode = 'OG404', message = 'customer not found';
    end if;
  else
    if (p_command->>'eventAt')::timestamptz is null
       or (p_command->>'eventAt')::timestamptz < v_grant.issued_at - interval '5 minutes'
       or (p_command->>'eventAt')::timestamptz > v_received + interval '5 minutes' then
      raise exception using errcode = 'OG410', message = 'eventAt outside grant authority';
    end if;
    if (p_command->>'operatorMembershipId')::uuid is distinct from v_grant.operator_membership_id then
      raise exception using errcode = 'OG403', message = 'operator does not match grant';
    end if;
    if coalesce((p_command->>'membershipId')::uuid, v_grant.operator_membership_id) <> v_grant.operator_membership_id
       and not staff_private.can_manage_attendance(p_tenant_id, v_grant.operator_membership_id) then
      raise exception using errcode = 'OG403', message = 'team attendance permission denied';
    end if;
  end if;

  if p_kind = 'customer_payment' then
    v_local := coalesce(p_command->>'localPaymentId', v_sync::text);
    v_row.kind := 'customer_debt';
    v_row.reason_code := 'PAYDOWN_EXCEEDS_OUTSTANDING';
    v_row.customer_id := (p_command->>'customerId')::uuid;
    v_row.amount_minor := (p_command->>'amountMinor')::bigint;
    v_row.currency := v_grant.currency;
    v_row.local_evidence := pg_catalog.jsonb_build_object('localPaymentId', v_local,
      'amountMinor', (p_command->>'amountMinor')::bigint, 'method', coalesce(p_command->>'method', 'cash'),
      'acceptedAt', v_accepted, 'tenderRecordedBy', 'cashier');
    v_row.server_evidence := pg_catalog.jsonb_build_object(
      'outstandingAtSyncMinor', case when v_row.customer_id is null then null
        else customers_ar_private.customer_outstanding(p_tenant_id, v_row.customer_id) end,
      'paymentPreservedAsEvidence', true, 'appliedToLedger', false);
  else
    v_local := coalesce(p_command->>'localEventId', v_sync::text);
    v_row.kind := 'attendance';
    v_row.reason_code := case p_refusal_code when 'AT409' then 'ALREADY_CLOCKED_IN'
                                             else 'NO_MATCHING_CLOCK_IN_OR_STAFF_INACTIVE' end;
    v_row.membership_id := coalesce((p_command->>'membershipId')::uuid, v_grant.operator_membership_id);
    v_row.local_evidence := pg_catalog.jsonb_build_object('localEventId', v_local,
      'eventType', p_command->>'eventType', 'eventAt', p_command->>'eventAt', 'acceptedAt', v_accepted,
      'operatorMembershipId', v_grant.operator_membership_id);
    v_row.server_evidence := pg_catalog.jsonb_build_object('refusal', p_refusal_code,
      'eventPreservedAsEvidence', true, 'appliedToTimeline', false);
  end if;
  v_row.local_reference := v_local;

  v_conflict := offline_pos_private.record_sync_conflict(v_row);
  insert into public.offline_conflict_ingestions (
    id, tenant_id, command_kind, grant_id, device_id, credential_id, register_id, sync_command_id,
    local_reference, command_fingerprint, canonical_command, device_signature_base64, refusal_code,
    conflict_id, accepted_at, received_at)
  values (
    v_ingestion, p_tenant_id, p_kind, v_grant.id, v_grant.device_id, p_credential_id, v_grant.register_id,
    v_sync, v_local, p_fingerprint, p_canonical, p_signature, p_refusal_code, v_conflict, v_accepted,
    v_received);
  return query select v_ingestion, v_conflict, v_row.reason_code, v_received;
end;
$function$;
revoke all on function offline_pos_private.record_offline_conflict(uuid, uuid, text, jsonb, text, text, text, text) from public;

do $grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant select on public.pos_sync_conflicts to service_role;
    -- Read-only: the API checks for an earlier preserved conflict before re-applying a command.
    grant select on public.offline_conflict_ingestions to service_role;
    grant execute on function offline_pos_private.record_offline_conflict(uuid, uuid, text, jsonb, text, text, text, text) to service_role;
  end if;
end
$grants$;
