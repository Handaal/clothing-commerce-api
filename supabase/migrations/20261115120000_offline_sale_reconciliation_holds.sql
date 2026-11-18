-- ADR-042 §4.6 — TERMINAL DISPOSITION FOR OFFLINE SALES THE TILL CANNOT SEND (Finding A) and
-- NO RELEASE WITHOUT PROOF (expiry).
--
-- Problem: an offline installment sale that names a customer created offline is held on the till when the
-- server definitively rejects that customer. Its offline sale ordinal is then never ingested, so the stock
-- grant can neither close (close needs every ordinal 1..final) nor be re-issued; the register is wedged.
--
-- Protocol (no human approval step; the server disposes automatically):
--   * The till sends a signed HOLD command bound to grant, device, register, sale sync id, local sale id,
--     ordinal, reason and the SHA-256 fingerprint of the ORIGINAL signed sale command, together with that
--     original signed sale. The server verifies both device signatures (service layer), the binding, the
--     grant window, that the ordinal is within policy and not yet used, and that the customer the sale
--     depends on really does not exist on the server (i.e. the dependency is genuinely unresolved).
--   * The ordinal then has exactly one immutable terminal record: 'held_for_reconciliation'. The sale is
--     NOT applied (no order, payment, debt or customer link is created) and NOT called void: the paid
--     deposit and receipt stand on the till; the server keeps the full signed sale as evidence.
--   * Stock: the units the sale took from the till's grant are moved into held_qty. They stay reserved
--     against the POS pool (never released and never consumed), so nobody can sell them, and the grant's
--     remaining units can be released on close. Resolving a hold (convert to sale / return to stock) needs
--     an owner policy and is deliberately NOT implemented: the hold simply stands and is surfaced.
--   * Exact replay returns the original receipt; a different hold or sale for the same ordinal, sale id or
--     local sale id is refused; a sale ingestion for a held ordinal is refused (trigger, same lock key).
--
-- Expiry: an offline sale accepted before the grant expired may legitimately sync later. The server can only
-- prove that no unreported offline consumption exists when the till reports its final ordinal (close), so
-- the "no gap so far" expiry test (p_upto null) now always answers false: expired stock and voucher grants
-- are retained (still active, still reserved) until the till closes them, and are listed by
-- inventory_private.offline_stock_grants_awaiting_close for the owner. Nothing is released early.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Held quantity on stock grant lines
-- ---------------------------------------------------------------------------------------------------------
alter table public.offline_pos_stock_grant_lines add column held_qty bigint not null default 0;
alter table public.offline_pos_stock_grant_lines drop constraint offline_pos_stock_grant_lines_quantities;
alter table public.offline_pos_stock_grant_lines add constraint offline_pos_stock_grant_lines_quantities check (
  granted_qty > 0 and consumed_qty >= 0 and released_qty >= 0 and held_qty >= 0
  and consumed_qty + released_qty + held_qty <= granted_qty);

create table public.offline_pos_stock_grant_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  stock_grant_line_id uuid not null references public.offline_pos_stock_grant_lines (id) on delete restrict,
  sync_command_id uuid not null,
  quantity bigint not null check (quantity > 0),
  created_at timestamptz not null default now(),
  constraint offline_pos_stock_grant_holds_unique unique (tenant_id, sync_command_id, stock_grant_line_id)
);
alter table public.offline_pos_stock_grant_holds enable row level security;
revoke all on public.offline_pos_stock_grant_holds from public;
create trigger offline_pos_stock_grant_holds_immutable before update or delete on public.offline_pos_stock_grant_holds
  for each row execute function inventory_private.forbid_ledger_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- 2. Terminal hold ledger (one immutable row per held sale ordinal)
-- ---------------------------------------------------------------------------------------------------------
create table public.offline_sale_reconciliation_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  grant_id uuid not null,
  device_id uuid not null,
  register_id uuid not null,
  hold_credential_id uuid not null,
  hold_sync_command_id uuid not null,
  hold_fingerprint text not null,
  hold_canonical_command text not null,
  hold_signature_base64 text not null,
  sale_credential_id uuid not null,
  sale_sync_command_id uuid not null,
  local_sale_id text not null,
  offline_sale_ordinal integer not null,
  sale_fingerprint text not null,
  sale_canonical_command text not null,
  sale_signature_base64 text not null,
  sale_accepted_at timestamptz not null,
  reason text not null,
  customer_id uuid not null,
  held_lines jsonb not null,
  status text not null default 'held_for_reconciliation',
  received_at timestamptz not null default now(),
  constraint offline_sale_holds_grant_fk foreign key (tenant_id, grant_id) references public.offline_grants (tenant_id, id) on delete restrict,
  constraint offline_sale_holds_device_fk foreign key (tenant_id, device_id) references public.devices (tenant_id, id) on delete restrict,
  constraint offline_sale_holds_hold_credential_fk foreign key (tenant_id, hold_credential_id) references public.device_credentials (tenant_id, id) on delete restrict,
  constraint offline_sale_holds_sale_credential_fk foreign key (tenant_id, sale_credential_id) references public.device_credentials (tenant_id, id) on delete restrict,
  constraint offline_sale_holds_ordinal check (offline_sale_ordinal > 0),
  constraint offline_sale_holds_reason check (reason in ('customer_dependency_rejected')),
  constraint offline_sale_holds_status check (status in ('held_for_reconciliation')),
  constraint offline_sale_holds_fingerprints check (hold_fingerprint ~ '^[a-f0-9]{64}$' and sale_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint offline_sale_holds_local_not_blank check (btrim(local_sale_id) <> ''),
  constraint offline_sale_holds_hold_sync_unique unique (tenant_id, hold_sync_command_id),
  constraint offline_sale_holds_sale_sync_unique unique (tenant_id, sale_sync_command_id),
  constraint offline_sale_holds_ordinal_unique unique (tenant_id, grant_id, offline_sale_ordinal),
  constraint offline_sale_holds_local_unique unique (tenant_id, device_id, local_sale_id)
);
alter table public.offline_sale_reconciliation_holds enable row level security;
revoke all on public.offline_sale_reconciliation_holds from public;
create trigger offline_sale_reconciliation_holds_immutable before update or delete on public.offline_sale_reconciliation_holds
  for each row execute function offline_pos_private.forbid_immutable_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- 3. Ordinal accounting: ingested ∪ held; no proof of completeness without the till's final ordinal
-- ---------------------------------------------------------------------------------------------------------
create or replace function inventory_private.stock_grant_ordinals_complete(p_tenant_id uuid, p_offline_grant_id uuid, p_upto integer)
returns boolean language plpgsql stable security definer set search_path = '' as $function$
declare v_count integer; v_above boolean;
begin
  -- Without the till's reported final ordinal the server cannot exclude offline sales accepted before
  -- expiry that have not synced yet, so it never claims completeness (expiry never releases early).
  if p_upto is null then
    return false;
  end if;
  with ordinals as (
    select (i.canonical_command::jsonb->>'offlineSaleOrdinal')::integer as ordinal
      from public.offline_sale_ingestions i
     where i.tenant_id = p_tenant_id and i.grant_id = p_offline_grant_id
    union all
    select h.offline_sale_ordinal from public.offline_sale_reconciliation_holds h
     where h.tenant_id = p_tenant_id and h.grant_id = p_offline_grant_id
  )
  select count(distinct o.ordinal) filter (where o.ordinal between 1 and p_upto),
         coalesce(bool_or(o.ordinal > p_upto), false)
    into v_count, v_above
    from ordinals o;
  return v_count = p_upto and not v_above;
end;
$function$;

-- Release now leaves held units reserved.
create or replace function inventory_private.stock_grant_release(p_tenant_id uuid, p_stock_grant_id uuid, p_status text, p_final integer)
returns void language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_pos_stock_grants%rowtype; v_line record; v_remaining bigint;
begin
  select * into v_grant from public.offline_pos_stock_grants g
   where g.tenant_id = p_tenant_id and g.id = p_stock_grant_id;
  perform 1 from public.inventory_balances b
   where b.tenant_id = p_tenant_id and b.inventory_location_id = v_grant.inventory_location_id
     and b.variant_id in (select l.variant_id from public.offline_pos_stock_grant_lines l where l.stock_grant_id = p_stock_grant_id)
   order by b.variant_id for update;
  perform 1 from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = v_grant.inventory_location_id for share;
  for v_line in
    select l.* from public.offline_pos_stock_grant_lines l where l.stock_grant_id = p_stock_grant_id
     order by l.variant_id for update
  loop
    v_remaining := v_line.granted_qty - v_line.consumed_qty - v_line.released_qty - v_line.held_qty;
    if v_remaining > 0 then
      perform inventory_private.channel_lock_key(p_tenant_id, v_grant.inventory_location_id, v_line.variant_id);
      update public.inventory_channel_balances b
         set reserved_qty = b.reserved_qty - v_remaining, version = b.version + 1, updated_at = now()
       where b.tenant_id = p_tenant_id and b.inventory_location_id = v_grant.inventory_location_id
         and b.variant_id = v_line.variant_id and b.channel = 'pos';
      update public.offline_pos_stock_grant_lines
         set released_qty = released_qty + v_remaining, version = version + 1
       where id = v_line.id;
    end if;
  end loop;
  update public.offline_pos_stock_grants
     set status = p_status, ended_at = now(), final_sale_ordinal = p_final
   where id = p_stock_grant_id;
end;
$function$;

create or replace function inventory_private.stock_grant_json(p_stock_grant_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'stockGrantId', g.id, 'offlineGrantId', g.offline_grant_id, 'status', g.status, 'expiresAt', g.expires_at,
    'enforced', coalesce((select l.channel_stock_mode = 'enforced' from public.inventory_locations l
                           where l.tenant_id = g.tenant_id and l.id = g.inventory_location_id), false),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
               'variantId', l.variant_id, 'grantedQuantity', l.granted_qty,
               'consumedQuantity', l.consumed_qty, 'releasedQuantity', l.released_qty) order by l.variant_id)
             from public.offline_pos_stock_grant_lines l where l.stock_grant_id = g.id), '[]'::jsonb))
    from public.offline_pos_stock_grants g where g.id = p_stock_grant_id;
$function$;

-- Consumption must not dip into held units.
create or replace function inventory_private.consume_offline_stock_grant(
  p_tenant_id uuid, p_offline_grant_id uuid, p_location_id uuid, p_lines jsonb, p_sync_command_id uuid
) returns text language plpgsql security definer set search_path = '' as $function$
declare v_mode text; v_grant public.offline_pos_stock_grants%rowtype; v_item record;
  v_line public.offline_pos_stock_grant_lines%rowtype; v_remaining bigint;
begin
  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = p_location_id for share;
  if v_mode is distinct from 'shadow' and v_mode is distinct from 'enforced' then
    return null;
  end if;
  select * into v_grant from public.offline_pos_stock_grants g
   where g.tenant_id = p_tenant_id and g.offline_grant_id = p_offline_grant_id for update;
  if not found or v_grant.status <> 'active' then
    if v_mode = 'enforced' then
      insert into public.offline_pos_stock_grant_shortfalls (tenant_id, offline_grant_id, sync_command_id, code, detail)
      values (p_tenant_id, p_offline_grant_id, p_sync_command_id, 'stock_grant_missing',
              jsonb_build_object('stockGrantStatus', v_grant.status));
      return 'insufficient_stock_at_ingestion';
    end if;
    return null;
  end if;

  if v_mode = 'enforced' then
    for v_item in
      select (e.value->>'variantId')::uuid as variant_id, sum((e.value->>'quantity')::bigint) as qty
        from jsonb_array_elements(p_lines) e group by 1 order by 1
    loop
      select l.granted_qty - l.consumed_qty - l.released_qty - l.held_qty into v_remaining
        from public.offline_pos_stock_grant_lines l
       where l.stock_grant_id = v_grant.id and l.variant_id = v_item.variant_id for update;
      if coalesce(v_remaining, 0) < v_item.qty then
        insert into public.offline_pos_stock_grant_shortfalls (tenant_id, offline_grant_id, sync_command_id, code, detail)
        values (p_tenant_id, p_offline_grant_id, p_sync_command_id, 'stock_grant_exceeded',
                jsonb_build_object('variantId', v_item.variant_id, 'quantity', v_item.qty, 'remaining', coalesce(v_remaining, 0)));
        return 'insufficient_stock_at_ingestion';
      end if;
    end loop;
  end if;

  for v_item in
    select (e.value->>'variantId')::uuid as variant_id, sum((e.value->>'quantity')::bigint) as qty
      from jsonb_array_elements(p_lines) e group by 1 order by 1
  loop
    select * into v_line from public.offline_pos_stock_grant_lines l
     where l.stock_grant_id = v_grant.id and l.variant_id = v_item.variant_id for update;
    continue when not found
      or v_line.granted_qty - v_line.consumed_qty - v_line.released_qty - v_line.held_qty < v_item.qty;
    perform inventory_private.channel_lock_key(p_tenant_id, p_location_id, v_item.variant_id);
    update public.inventory_channel_balances b
       set reserved_qty = b.reserved_qty - v_item.qty, version = b.version + 1, updated_at = now()
     where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
       and b.variant_id = v_item.variant_id and b.channel = 'pos';
    update public.offline_pos_stock_grant_lines
       set consumed_qty = consumed_qty + v_item.qty, version = version + 1
     where id = v_line.id;
    insert into public.offline_pos_stock_grant_consumptions (tenant_id, stock_grant_line_id, sync_command_id, quantity)
    values (p_tenant_id, v_line.id, p_sync_command_id, v_item.qty);
  end loop;
  return null;
end;
$function$;

-- Move the units a held sale took from the till's grant into held_qty (they stay reserved). Returns the held
-- lines; [] at a legacy location (no stock grant). Lock order: balances -> location -> grant -> lines.
create function inventory_private.hold_offline_stock_grant(
  p_tenant_id uuid, p_offline_grant_id uuid, p_location_id uuid, p_lines jsonb, p_sync_command_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_pos_stock_grants%rowtype; v_item record;
  v_line public.offline_pos_stock_grant_lines%rowtype; v_take bigint; v_out jsonb := '[]'::jsonb;
begin
  perform 1 from public.inventory_balances b
   where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
     and b.variant_id in (select (e.value->>'variantId')::uuid from jsonb_array_elements(p_lines) e)
   order by b.variant_id for update;
  perform 1 from public.inventory_locations l where l.tenant_id = p_tenant_id and l.id = p_location_id for share;
  select * into v_grant from public.offline_pos_stock_grants g
   where g.tenant_id = p_tenant_id and g.offline_grant_id = p_offline_grant_id for update;
  if not found or v_grant.status <> 'active' then
    return v_out;
  end if;
  for v_item in
    select (e.value->>'variantId')::uuid as variant_id, sum((e.value->>'quantity')::bigint) as qty
      from jsonb_array_elements(p_lines) e group by 1 order by 1
  loop
    select * into v_line from public.offline_pos_stock_grant_lines l
     where l.stock_grant_id = v_grant.id and l.variant_id = v_item.variant_id for update;
    continue when not found;
    v_take := least(v_item.qty, v_line.granted_qty - v_line.consumed_qty - v_line.released_qty - v_line.held_qty);
    continue when v_take <= 0;
    update public.offline_pos_stock_grant_lines
       set held_qty = held_qty + v_take, version = version + 1
     where id = v_line.id;
    insert into public.offline_pos_stock_grant_holds (tenant_id, stock_grant_line_id, sync_command_id, quantity)
    values (p_tenant_id, v_line.id, p_sync_command_id, v_take);
    v_out := v_out || jsonb_build_object('variantId', v_item.variant_id, 'quantity', v_take, 'requestedQuantity', v_item.qty);
  end loop;
  return v_out;
end;
$function$;

-- Owner visibility: grants past expiry that are still reserved because the till has not reported its final
-- ordinal, plus held units per grant. Read-only.
create function inventory_private.offline_stock_grants_awaiting_close(p_tenant_id uuid)
returns table(stock_grant_id uuid, offline_grant_id uuid, register_id uuid, device_id uuid, expires_at timestamptz,
  status text, reserved_units bigint, held_units bigint)
language sql stable security definer set search_path = '' as $function$
  select g.id, g.offline_grant_id, g.register_id, g.device_id, g.expires_at, g.status,
         coalesce(sum(l.granted_qty - l.consumed_qty - l.released_qty - l.held_qty), 0)::bigint,
         coalesce(sum(l.held_qty), 0)::bigint
    from public.offline_pos_stock_grants g
    left join public.offline_pos_stock_grant_lines l on l.stock_grant_id = g.id
   where g.tenant_id = p_tenant_id
     and ((g.status = 'active' and g.expires_at < now()) or l.held_qty > 0)
   group by g.id
   order by g.expires_at, g.id;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. One ordinal, one terminal record: ingestion refuses a held or already-used ordinal
-- ---------------------------------------------------------------------------------------------------------
create function offline_pos_private.offline_sale_ordinal_lock(p_tenant_id uuid, p_grant_id uuid, p_ordinal integer)
returns void language sql volatile security definer set search_path = '' as $function$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'offline-sale-ordinal:' || p_tenant_id::text || ':' || p_grant_id::text || ':' || p_ordinal::text, 0));
$function$;

create function offline_pos_private.guard_offline_sale_ordinal()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_ordinal integer := (new.canonical_command::jsonb->>'offlineSaleOrdinal')::integer;
begin
  perform offline_pos_private.offline_sale_ordinal_lock(new.tenant_id, new.grant_id, v_ordinal);
  if exists (select 1 from public.offline_sale_reconciliation_holds h
              where h.tenant_id = new.tenant_id
                and (h.sale_sync_command_id = new.sync_command_id
                     or (h.grant_id = new.grant_id and h.offline_sale_ordinal = v_ordinal)
                     or (h.device_id = new.device_id and h.local_sale_id = new.local_sale_id))) then
    raise exception using errcode = 'OH409', message = 'offline sale ordinal is held for reconciliation';
  end if;
  if exists (select 1 from public.offline_sale_ingestions i
              where i.tenant_id = new.tenant_id and i.grant_id = new.grant_id
                and (i.canonical_command::jsonb->>'offlineSaleOrdinal')::integer = v_ordinal) then
    raise exception using errcode = 'OH409', message = 'offline sale ordinal already used by another sale';
  end if;
  return new;
end;
$function$;
create trigger offline_sale_ingestions_ordinal_guard before insert on public.offline_sale_ingestions
  for each row execute function offline_pos_private.guard_offline_sale_ordinal();

-- ---------------------------------------------------------------------------------------------------------
-- 5. Record a hold (signatures verified by the service before this is called)
-- ---------------------------------------------------------------------------------------------------------
create function offline_pos_private.record_offline_sale_hold(
  p_tenant_id uuid,
  p_hold_credential_id uuid, p_hold jsonb, p_hold_canonical text, p_hold_fingerprint text, p_hold_signature text,
  p_sale_credential_id uuid, p_sale jsonb, p_sale_canonical text, p_sale_fingerprint text, p_sale_signature text
) returns table(hold_id uuid, status text, held_lines jsonb, received_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_sale_reconciliation_holds%rowtype;
  v_hold_sync uuid; v_sale_sync uuid; v_ordinal integer; v_accepted timestamptz; v_received timestamptz := now();
  v_customer uuid; v_lines jsonb; v_held jsonb; v_id uuid;
begin
  v_hold_sync := (p_hold->>'syncCommandId')::uuid;
  v_sale_sync := (p_sale->>'syncCommandId')::uuid;
  v_ordinal := (p_sale->>'offlineSaleOrdinal')::integer;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('offline-sale-hold:' || p_tenant_id::text || ':' || v_sale_sync::text, 0));

  select * into v_existing from public.offline_sale_reconciliation_holds h
   where h.tenant_id = p_tenant_id and (h.hold_sync_command_id = v_hold_sync or h.sale_sync_command_id = v_sale_sync);
  if found then
    if v_existing.hold_fingerprint <> p_hold_fingerprint or v_existing.sale_fingerprint <> p_sale_fingerprint then
      raise exception using errcode = 'ID409', message = 'offline idempotency conflict';
    end if;
    return query select v_existing.id, v_existing.status, v_existing.held_lines, v_existing.received_at; return;
  end if;

  -- Binding: the hold names exactly this signed sale.
  if p_hold->>'saleSyncCommandId' is distinct from p_sale->>'syncCommandId'
     or p_hold->>'saleCommandFingerprint' is distinct from p_sale_fingerprint
     or p_hold->>'grantId' is distinct from p_sale->>'grantId'
     or p_hold->>'deviceId' is distinct from p_sale->>'deviceId'
     or p_hold->>'registerId' is distinct from p_sale->>'registerId'
     or p_hold->>'localSaleId' is distinct from p_sale->>'localSaleId'
     or (p_hold->>'offlineSaleOrdinal')::integer is distinct from v_ordinal
     or p_hold->>'customerId' is distinct from p_sale->>'customerId' then
    raise exception using errcode = 'OH422', message = 'hold does not match the signed sale';
  end if;
  if p_hold->>'reason' is distinct from 'customer_dependency_rejected' or p_sale->>'customerId' is null then
    raise exception using errcode = 'OH422', message = 'hold reason not supported for this sale';
  end if;
  v_customer := (p_sale->>'customerId')::uuid;

  select * into v_grant from public.offline_grants g where g.tenant_id = p_tenant_id and g.id = (p_sale->>'grantId')::uuid;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;
  if (p_sale->>'deviceId')::uuid <> v_grant.device_id or (p_sale->>'registerId')::uuid <> v_grant.register_id
     or p_sale->>'currency' <> v_grant.currency then
    raise exception using errcode = 'OG403', message = 'grant binding mismatch';
  end if;
  if (p_sale->>'schemaVersion')::integer <> v_grant.schema_version then
    raise exception using errcode = 'OG422', message = 'schema version unsupported';
  end if;
  v_accepted := (p_sale->>'acceptedAt')::timestamptz;
  if v_accepted < v_grant.issued_at - interval '5 minutes' or v_accepted > v_grant.accepted_until
     or v_accepted > v_received + interval '5 minutes' then
    raise exception using errcode = 'OG410', message = 'acceptedAt outside grant authority';
  end if;
  perform 1 from public.device_credentials c where c.tenant_id = p_tenant_id and c.id = p_sale_credential_id
    and c.device_id = v_grant.device_id and c.valid_from <= v_accepted and (c.valid_to is null or c.valid_to >= v_accepted);
  if not found then raise exception using errcode = 'OS401', message = 'credential not valid at acceptance'; end if;
  perform 1 from public.device_credentials c where c.tenant_id = p_tenant_id and c.id = p_hold_credential_id
    and c.device_id = v_grant.device_id and c.valid_from <= v_received and (c.valid_to is null or c.valid_to >= v_received);
  if not found then raise exception using errcode = 'OS401', message = 'hold credential not valid'; end if;
  if v_ordinal < 1 or v_ordinal > v_grant.max_pending_offline_sales then
    raise exception using errcode = 'OL422', message = 'pending sale limit exceeded';
  end if;

  perform offline_pos_private.offline_sale_ordinal_lock(p_tenant_id, v_grant.id, v_ordinal);
  if exists (select 1 from public.offline_sale_ingestions i where i.tenant_id = p_tenant_id
               and (i.sync_command_id = v_sale_sync
                    or (i.device_id = v_grant.device_id and i.local_sale_id = p_sale->>'localSaleId')
                    or (i.grant_id = v_grant.id and (i.canonical_command::jsonb->>'offlineSaleOrdinal')::integer = v_ordinal))) then
    raise exception using errcode = 'OH409', message = 'offline sale ordinal already ingested';
  end if;
  if exists (select 1 from public.offline_sale_reconciliation_holds h where h.tenant_id = p_tenant_id
               and ((h.grant_id = v_grant.id and h.offline_sale_ordinal = v_ordinal)
                    or (h.device_id = v_grant.device_id and h.local_sale_id = p_sale->>'localSaleId'))) then
    raise exception using errcode = 'OH409', message = 'offline sale ordinal already held';
  end if;
  -- The dependency must be genuinely unresolved: if the customer exists the sale must be sent normally.
  if exists (select 1 from public.customers c where c.tenant_id = p_tenant_id and c.id = v_customer) then
    raise exception using errcode = 'OH422', message = 'customer exists; the sale must be synchronized normally';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('variantId', e.value->>'variantId', 'quantity', (e.value->>'quantity')::bigint)), '[]'::jsonb)
    into v_lines from jsonb_array_elements(p_sale->'lines') e;
  v_held := inventory_private.hold_offline_stock_grant(p_tenant_id, v_grant.id, v_grant.inventory_location_id, v_lines, v_sale_sync);

  insert into public.offline_sale_reconciliation_holds (tenant_id, grant_id, device_id, register_id,
    hold_credential_id, hold_sync_command_id, hold_fingerprint, hold_canonical_command, hold_signature_base64,
    sale_credential_id, sale_sync_command_id, local_sale_id, offline_sale_ordinal, sale_fingerprint,
    sale_canonical_command, sale_signature_base64, sale_accepted_at, reason, customer_id, held_lines, received_at)
  values (p_tenant_id, v_grant.id, v_grant.device_id, v_grant.register_id,
    p_hold_credential_id, v_hold_sync, p_hold_fingerprint, p_hold_canonical, p_hold_signature,
    p_sale_credential_id, v_sale_sync, p_sale->>'localSaleId', v_ordinal, p_sale_fingerprint,
    p_sale_canonical, p_sale_signature, v_accepted, p_hold->>'reason', v_customer, v_held, v_received)
  returning id into v_id;
  return query select v_id, 'held_for_reconciliation'::text, v_held, v_received;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- 6. Ownership and privileges (same pattern as the stock-grant and offline-customer migrations)
-- ---------------------------------------------------------------------------------------------------------
grant select on public.offline_sale_reconciliation_holds to inventory_writer;
create policy inventory_writer_offline_hold_read on public.offline_sale_reconciliation_holds for select to inventory_writer using (true);

grant create on schema public, inventory_private to inventory_writer;
alter table public.offline_pos_stock_grant_holds owner to inventory_writer;
alter function inventory_private.hold_offline_stock_grant(uuid, uuid, uuid, jsonb, uuid) owner to inventory_writer;
alter function inventory_private.offline_stock_grants_awaiting_close(uuid) owner to inventory_writer;
revoke create on schema public, inventory_private from inventory_writer;

grant create on schema public, offline_pos_private to offline_pos_writer;
alter table public.offline_sale_reconciliation_holds owner to offline_pos_writer;
alter function offline_pos_private.offline_sale_ordinal_lock(uuid, uuid, integer) owner to offline_pos_writer;
alter function offline_pos_private.guard_offline_sale_ordinal() owner to offline_pos_writer;
alter function offline_pos_private.record_offline_sale_hold(uuid, uuid, jsonb, text, text, text, uuid, jsonb, text, text, text) owner to offline_pos_writer;
revoke create on schema public, offline_pos_private from offline_pos_writer;

revoke all on function inventory_private.hold_offline_stock_grant(uuid, uuid, uuid, jsonb, uuid) from public;
revoke all on function inventory_private.offline_stock_grants_awaiting_close(uuid) from public;
revoke all on function offline_pos_private.offline_sale_ordinal_lock(uuid, uuid, integer) from public;
revoke all on function offline_pos_private.guard_offline_sale_ordinal() from public;
revoke all on function offline_pos_private.record_offline_sale_hold(uuid, uuid, jsonb, text, text, text, uuid, jsonb, text, text, text) from public;
grant execute on function inventory_private.hold_offline_stock_grant(uuid, uuid, uuid, jsonb, uuid) to offline_pos_writer;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function offline_pos_private.record_offline_sale_hold(uuid, uuid, jsonb, text, text, text, uuid, jsonb, text, text, text) to service_role;
    grant execute on function inventory_private.offline_stock_grants_awaiting_close(uuid) to service_role;
    grant select on public.offline_sale_reconciliation_holds to service_role;
  end if;
end $b$;
