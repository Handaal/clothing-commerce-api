-- ADR-042 §4 — OFFLINE POS STOCK GRANTS (additive; inert at legacy locations).
--
-- A till that works offline may only sell stock it was explicitly given. At online bootstrap the server
-- reserves per-variant quantities from the location's POS bucket (inventory_channel_balances.reserved_qty on
-- the 'pos' row) into one stock grant bound to the offline grant (device + register + lease). Because the
-- reservation counts against pos.on_hand, a connected POS sale, a website order or another till can never
-- take stock that a till already holds, so an offline sale made within its grant can never oversell.
--
--   issue    reserve from pos free stock (pos.on_hand - pos.reserved); one active stock grant per register;
--            default (no explicit lines) = all free POS stock of the variants in the offline catalog. A
--            second till therefore receives only what is still free: grants are disjoint by construction.
--   consume  offline sale ingestion: line.consumed += q and pos.reserved -= q in the same transaction as
--            the sale; the deferred channel trigger then takes pos.on_hand -= q. In 'enforced' mode a sale
--            without a grant line, or beyond it, is recorded as needs_reconciliation (no stock moves),
--            with the precise cause kept in offline_pos_stock_grant_shortfalls. 'shadow' never refuses.
--   close    the till reports its final offline sale ordinal; once every ordinal 1..final is ingested the
--            unconsumed remainder is released (status 'closed').
--   expire   after expires_at + 5 minutes, a grant whose ingested ordinals are contiguous is released
--            (status 'expired'); with a gap the reservation stands until the missing sales arrive.
-- Legacy locations issue no stock grant and ingestion behaves exactly as before.
-- Lock order (ADR-042 §3.4): inventory_balances rows by variant -> inventory_locations row -> channel rows.

create table public.offline_pos_stock_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  offline_grant_id uuid not null,
  device_id uuid not null,
  register_id uuid not null,
  inventory_location_id uuid not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active',
  final_sale_ordinal integer,
  ended_at timestamptz,
  constraint offline_pos_stock_grants_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint offline_pos_stock_grants_offline_grant_fk foreign key (tenant_id, offline_grant_id)
    references public.offline_grants (tenant_id, id) on delete restrict,
  constraint offline_pos_stock_grants_location_fk foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations (tenant_id, id) on delete restrict,
  constraint offline_pos_stock_grants_status check (status in ('active', 'closed', 'expired', 'revoked')),
  constraint offline_pos_stock_grants_times check (expires_at > issued_at),
  constraint offline_pos_stock_grants_ended check ((status = 'active') = (ended_at is null)),
  constraint offline_pos_stock_grants_final check (final_sale_ordinal is null or final_sale_ordinal >= 0),
  constraint offline_pos_stock_grants_offline_grant_unique unique (tenant_id, offline_grant_id),
  constraint offline_pos_stock_grants_tenant_id_unique unique (tenant_id, id)
);
create unique index offline_pos_stock_grants_one_active_per_register
  on public.offline_pos_stock_grants (tenant_id, register_id) where status = 'active';
create index offline_pos_stock_grants_expiry_idx
  on public.offline_pos_stock_grants (tenant_id, expires_at) where status = 'active';

create table public.offline_pos_stock_grant_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  stock_grant_id uuid not null,
  variant_id uuid not null,
  granted_qty bigint not null,
  consumed_qty bigint not null default 0,
  released_qty bigint not null default 0,
  version bigint not null default 0,
  constraint offline_pos_stock_grant_lines_grant_fk foreign key (tenant_id, stock_grant_id)
    references public.offline_pos_stock_grants (tenant_id, id) on delete restrict,
  constraint offline_pos_stock_grant_lines_variant_fk foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete restrict,
  constraint offline_pos_stock_grant_lines_quantities check (
    granted_qty > 0 and consumed_qty >= 0 and released_qty >= 0 and consumed_qty + released_qty <= granted_qty),
  constraint offline_pos_stock_grant_lines_unique unique (stock_grant_id, variant_id)
);

create table public.offline_pos_stock_grant_consumptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  stock_grant_line_id uuid not null references public.offline_pos_stock_grant_lines (id) on delete restrict,
  sync_command_id uuid not null,
  quantity bigint not null check (quantity > 0),
  created_at timestamptz not null default now(),
  constraint offline_pos_stock_grant_consumptions_unique unique (tenant_id, sync_command_id, stock_grant_line_id)
);

create table public.offline_pos_stock_grant_shortfalls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  offline_grant_id uuid not null,
  sync_command_id uuid not null,
  code text not null check (code in ('stock_grant_missing', 'stock_grant_exceeded')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index offline_pos_stock_grant_shortfalls_grant_idx
  on public.offline_pos_stock_grant_shortfalls (tenant_id, offline_grant_id);

alter table public.offline_pos_stock_grants enable row level security;
alter table public.offline_pos_stock_grant_lines enable row level security;
alter table public.offline_pos_stock_grant_consumptions enable row level security;
alter table public.offline_pos_stock_grant_shortfalls enable row level security;
revoke all on public.offline_pos_stock_grants, public.offline_pos_stock_grant_lines,
  public.offline_pos_stock_grant_consumptions, public.offline_pos_stock_grant_shortfalls from public;

create trigger offline_pos_stock_grant_consumptions_immutable before update or delete on public.offline_pos_stock_grant_consumptions
  for each row execute function inventory_private.forbid_ledger_mutation();
create trigger offline_pos_stock_grant_shortfalls_immutable before update or delete on public.offline_pos_stock_grant_shortfalls
  for each row execute function inventory_private.forbid_ledger_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------------

-- True when every offline sale ordinal 1..N of this offline grant has been ingested and none above N, where
-- N = p_upto, or (p_upto null) the highest ingested ordinal, i.e. "no gap so far".
create function inventory_private.stock_grant_ordinals_complete(p_tenant_id uuid, p_offline_grant_id uuid, p_upto integer)
returns boolean language plpgsql stable security definer set search_path = '' as $function$
declare v_upto integer; v_count integer; v_above boolean;
begin
  select coalesce(p_upto, max((i.canonical_command::jsonb->>'offlineSaleOrdinal')::integer), 0)
    into v_upto from public.offline_sale_ingestions i
   where i.tenant_id = p_tenant_id and i.grant_id = p_offline_grant_id;
  select count(distinct (i.canonical_command::jsonb->>'offlineSaleOrdinal')::integer) filter (
           where (i.canonical_command::jsonb->>'offlineSaleOrdinal')::integer between 1 and v_upto),
         coalesce(bool_or((i.canonical_command::jsonb->>'offlineSaleOrdinal')::integer > v_upto), false)
    into v_count, v_above
    from public.offline_sale_ingestions i
   where i.tenant_id = p_tenant_id and i.grant_id = p_offline_grant_id;
  return v_count = v_upto and not v_above;
end;
$function$;

-- Release every unconsumed unit of one stock grant back to POS free stock and end it.
create function inventory_private.stock_grant_release(p_tenant_id uuid, p_stock_grant_id uuid, p_status text, p_final integer)
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
    v_remaining := v_line.granted_qty - v_line.consumed_qty - v_line.released_qty;
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

create function inventory_private.stock_grant_json(p_stock_grant_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'stockGrantId', g.id, 'offlineGrantId', g.offline_grant_id, 'status', g.status, 'expiresAt', g.expires_at,
    -- The till limits offline selling to the grant only when the location is enforced; in shadow it tracks.
    'enforced', coalesce((select l.channel_stock_mode = 'enforced' from public.inventory_locations l
                           where l.tenant_id = g.tenant_id and l.id = g.inventory_location_id), false),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
               'variantId', l.variant_id, 'grantedQuantity', l.granted_qty,
               'consumedQuantity', l.consumed_qty, 'releasedQuantity', l.released_qty) order by l.variant_id)
             from public.offline_pos_stock_grant_lines l where l.stock_grant_id = g.id), '[]'::jsonb))
    from public.offline_pos_stock_grants g where g.id = p_stock_grant_id;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Entry points
-- ---------------------------------------------------------------------------------------------------------

-- Close: the till reports its final offline sale ordinal for the grant. Idempotent for the same ordinal.
create function inventory_private.close_offline_stock_grant(p_tenant_id uuid, p_stock_grant_id uuid, p_final_ordinal integer)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_pos_stock_grants%rowtype;
begin
  if p_final_ordinal is null or p_final_ordinal < 0 then
    raise exception using errcode = '22023', message = 'final sale ordinal must be zero or more';
  end if;
  select * into v_grant from public.offline_pos_stock_grants g
   where g.tenant_id = p_tenant_id and g.id = p_stock_grant_id for update;
  if not found then raise exception using errcode = 'SG404', message = 'stock grant not found'; end if;
  if v_grant.status <> 'active' then
    if v_grant.status = 'closed' and v_grant.final_sale_ordinal = p_final_ordinal then
      return inventory_private.stock_grant_json(v_grant.id);
    end if;
    raise exception using errcode = 'SG409', message = 'stock grant already ended';
  end if;
  if not inventory_private.stock_grant_ordinals_complete(p_tenant_id, v_grant.offline_grant_id, p_final_ordinal) then
    raise exception using errcode = 'SG409', message = 'offline sales for this grant are not all synchronized';
  end if;
  perform inventory_private.stock_grant_release(p_tenant_id, v_grant.id, 'closed', p_final_ordinal);
  return inventory_private.stock_grant_json(v_grant.id);
end;
$function$;

-- Expiry sweep: release grants past expires_at + 5 minutes whose ingested ordinals have no gap.
create function inventory_private.release_expired_offline_stock_grants(p_tenant_id uuid, p_register_id uuid default null)
returns integer language plpgsql security definer set search_path = '' as $function$
declare v_grant record; v_count integer := 0;
begin
  for v_grant in
    select g.id, g.offline_grant_id from public.offline_pos_stock_grants g
     where g.tenant_id = p_tenant_id and g.status = 'active' and g.expires_at + interval '5 minutes' < now()
       and (p_register_id is null or g.register_id = p_register_id)
     order by g.id for update skip locked
  loop
    if inventory_private.stock_grant_ordinals_complete(p_tenant_id, v_grant.offline_grant_id, null) then
      perform inventory_private.stock_grant_release(p_tenant_id, v_grant.id, 'expired', null);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$function$;

-- Issue a stock grant for a freshly issued offline grant. Returns null at a legacy location.
-- p_lines: null = all free POS stock of the offline catalog's variants; else [{variantId, quantity}].
-- Optionally closes the stock grant of the register's previous offline grant first (same transaction).
create function inventory_private.issue_offline_stock_grant(
  p_tenant_id uuid, p_offline_grant_id uuid, p_lines jsonb,
  p_previous_offline_grant_id uuid, p_previous_final_ordinal integer
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_offline public.offline_grants%rowtype; v_mode text; v_existing uuid; v_stock_grant uuid; v_previous uuid;
  v_requested jsonb := '{}'::jsonb; v_variant uuid; v_qty bigint; v_free bigint; v_line jsonb;
begin
  select * into v_offline from public.offline_grants g where g.tenant_id = p_tenant_id and g.id = p_offline_grant_id;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;

  select s.id into v_existing from public.offline_pos_stock_grants s
   where s.tenant_id = p_tenant_id and s.offline_grant_id = p_offline_grant_id;
  if found then
    return inventory_private.stock_grant_json(v_existing); -- replay of the same bootstrap
  end if;

  if p_previous_offline_grant_id is not null then
    perform 1 from public.offline_grants g
     where g.tenant_id = p_tenant_id and g.id = p_previous_offline_grant_id and g.register_id = v_offline.register_id;
    if not found then raise exception using errcode = 'SG404', message = 'previous offline grant not found for this register'; end if;
    select s.id into v_previous from public.offline_pos_stock_grants s
     where s.tenant_id = p_tenant_id and s.offline_grant_id = p_previous_offline_grant_id and s.status = 'active';
    if v_previous is not null then
      perform inventory_private.close_offline_stock_grant(p_tenant_id, v_previous, p_previous_final_ordinal);
    end if;
  end if;
  perform inventory_private.release_expired_offline_stock_grants(p_tenant_id, v_offline.register_id);

  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = v_offline.inventory_location_id;
  if v_mode is distinct from 'shadow' and v_mode is distinct from 'enforced' then
    return null;
  end if;
  if exists (select 1 from public.offline_pos_stock_grants s
              where s.tenant_id = p_tenant_id and s.register_id = v_offline.register_id and s.status = 'active') then
    raise exception using errcode = 'SG409', message = 'this register still holds an open stock grant; close it first';
  end if;

  if p_lines is null then
    select coalesce(jsonb_object_agg(v.value->>'variantId', null), '{}'::jsonb) into v_requested
      from jsonb_array_elements(v_offline.catalog_snapshot) p(value),
           lateral jsonb_array_elements(p.value->'variants') v(value)
     where coalesce((v.value->>'active')::boolean, true);
  else
    if jsonb_typeof(p_lines) <> 'array' then
      raise exception using errcode = '22023', message = 'lines must be an array';
    end if;
    for v_line in select value from jsonb_array_elements(p_lines) loop
      v_qty := (v_line->>'quantity')::bigint;
      if v_qty is null or v_qty <= 0 or v_requested ? (v_line->>'variantId') then
        raise exception using errcode = '22023', message = 'each line needs a distinct variant and a positive quantity';
      end if;
      v_requested := v_requested || jsonb_build_object(v_line->>'variantId', v_qty);
    end loop;
  end if;

  -- Lock order: balances (by variant) -> location -> channel rows.
  perform 1 from public.inventory_balances b
   where b.tenant_id = p_tenant_id and b.inventory_location_id = v_offline.inventory_location_id
     and b.variant_id::text in (select jsonb_object_keys(v_requested))
   order by b.variant_id for update;
  perform 1 from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = v_offline.inventory_location_id for share;

  insert into public.offline_pos_stock_grants (tenant_id, offline_grant_id, device_id, register_id, inventory_location_id, expires_at)
  values (p_tenant_id, p_offline_grant_id, v_offline.device_id, v_offline.register_id, v_offline.inventory_location_id,
          v_offline.accepted_until)
  returning id into v_stock_grant;

  for v_variant in select k::uuid from jsonb_object_keys(v_requested) k order by 1 loop
    select b.on_hand_qty - b.reserved_qty into v_free from public.inventory_channel_balances b
     where b.tenant_id = p_tenant_id and b.inventory_location_id = v_offline.inventory_location_id
       and b.variant_id = v_variant and b.channel = 'pos';
    v_free := coalesce(v_free, 0);
    v_qty := case when jsonb_typeof(v_requested->v_variant::text) = 'number'
                  then (v_requested->>v_variant::text)::bigint else v_free end;
    if v_qty > v_free then
      raise exception using errcode = 'CH409', message = 'requested quantity exceeds free POS stock', detail = v_variant::text;
    end if;
    continue when v_qty <= 0;
    perform inventory_private.channel_lock_key(p_tenant_id, v_offline.inventory_location_id, v_variant);
    update public.inventory_channel_balances b
       set reserved_qty = b.reserved_qty + v_qty, version = b.version + 1, updated_at = now()
     where b.tenant_id = p_tenant_id and b.inventory_location_id = v_offline.inventory_location_id
       and b.variant_id = v_variant and b.channel = 'pos';
    insert into public.offline_pos_stock_grant_lines (tenant_id, stock_grant_id, variant_id, granted_qty)
    values (p_tenant_id, v_stock_grant, v_variant, v_qty);
  end loop;
  return inventory_private.stock_grant_json(v_stock_grant);
end;
$function$;

-- Ingestion hook: consume the till's grant for one offline sale. Returns null to proceed, or the
-- reconciliation reason when the sale must not move stock. Balances are already locked by the caller.
create function inventory_private.consume_offline_stock_grant(
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

  -- Enforced: every line must fit its grant line before anything is consumed.
  if v_mode = 'enforced' then
    for v_item in
      select (e.value->>'variantId')::uuid as variant_id, sum((e.value->>'quantity')::bigint) as qty
        from jsonb_array_elements(p_lines) e group by 1 order by 1
    loop
      select l.granted_qty - l.consumed_qty - l.released_qty into v_remaining
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
    -- Shadow: a line without enough grant falls back to free POS stock (logged by the channel trigger).
    continue when not found or v_line.granted_qty - v_line.consumed_qty - v_line.released_qty < v_item.qty;
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

-- ---------------------------------------------------------------------------------------------------------
-- Ownership, privileges
-- ---------------------------------------------------------------------------------------------------------
grant select on public.offline_grants, public.offline_sale_ingestions to inventory_writer;
create policy inventory_writer_offline_grant_read on public.offline_grants for select to inventory_writer using (true);
create policy inventory_writer_offline_ingestion_read on public.offline_sale_ingestions for select to inventory_writer using (true);

grant create on schema public, inventory_private to inventory_writer;
alter table public.offline_pos_stock_grants owner to inventory_writer;
alter table public.offline_pos_stock_grant_lines owner to inventory_writer;
alter table public.offline_pos_stock_grant_consumptions owner to inventory_writer;
alter table public.offline_pos_stock_grant_shortfalls owner to inventory_writer;
alter function inventory_private.stock_grant_ordinals_complete(uuid, uuid, integer) owner to inventory_writer;
alter function inventory_private.stock_grant_release(uuid, uuid, text, integer) owner to inventory_writer;
alter function inventory_private.stock_grant_json(uuid) owner to inventory_writer;
alter function inventory_private.close_offline_stock_grant(uuid, uuid, integer) owner to inventory_writer;
alter function inventory_private.release_expired_offline_stock_grants(uuid, uuid) owner to inventory_writer;
alter function inventory_private.issue_offline_stock_grant(uuid, uuid, jsonb, uuid, integer) owner to inventory_writer;
alter function inventory_private.consume_offline_stock_grant(uuid, uuid, uuid, jsonb, uuid) owner to inventory_writer;
revoke create on schema public, inventory_private from inventory_writer;

revoke all on function inventory_private.stock_grant_ordinals_complete(uuid, uuid, integer) from public;
revoke all on function inventory_private.stock_grant_release(uuid, uuid, text, integer) from public;
revoke all on function inventory_private.stock_grant_json(uuid) from public;
revoke all on function inventory_private.close_offline_stock_grant(uuid, uuid, integer) from public;
revoke all on function inventory_private.release_expired_offline_stock_grants(uuid, uuid) from public;
revoke all on function inventory_private.issue_offline_stock_grant(uuid, uuid, jsonb, uuid, integer) from public;
revoke all on function inventory_private.consume_offline_stock_grant(uuid, uuid, uuid, jsonb, uuid) from public;
grant execute on function inventory_private.consume_offline_stock_grant(uuid, uuid, uuid, jsonb, uuid) to offline_pos_writer;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      inventory_private.issue_offline_stock_grant(uuid, uuid, jsonb, uuid, integer),
      inventory_private.close_offline_stock_grant(uuid, uuid, integer),
      inventory_private.release_expired_offline_stock_grants(uuid, uuid),
      inventory_private.stock_grant_json(uuid)
    to service_role;
    grant select on public.offline_pos_stock_grants, public.offline_pos_stock_grant_lines,
      public.offline_pos_stock_grant_consumptions, public.offline_pos_stock_grant_shortfalls to service_role;
  end if;
end $b$;

-- ---------------------------------------------------------------------------------------------------------
-- Offline sale ingestion: identical to 20261108120000 plus the stock-grant hook after the canonical stock
-- check (only the marked block differs).
-- ---------------------------------------------------------------------------------------------------------
create or replace function offline_pos_private.record_offline_sale(p_tenant_id uuid,p_credential_id uuid,p_command jsonb,p_canonical text,p_fingerprint text,p_signature text)
returns table(ingestion_id uuid,sync_status text,order_id uuid,payment_id uuid,fulfillment_id uuid,reconciliation_id uuid,received_at timestamptz)
language plpgsql security definer set search_path='' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_sale_ingestions%rowtype; v_device_status text; v_element jsonb; v_snapshot jsonb;
 v_total numeric:=0; v_quantity bigint; v_variant uuid; v_price bigint; v_price_id uuid; v_order_lines jsonb:='[]'; v_fulfillment_lines jsonb:='[]';
 v_brand uuid; v_order uuid; v_payment uuid; v_fulfillment uuid; v_inventory_operation uuid; v_ingestion uuid; v_reconciliation uuid;
 v_sufficient boolean:=true; v_reason text; v_suffix text; v_received timestamptz:=now(); v_accepted timestamptz; v_sync uuid; v_line record;
 v_paid bigint; v_outstanding bigint; v_installment boolean; v_customer uuid; v_contact jsonb; v_settle bigint;
begin
 v_sync := (p_command->>'syncCommandId')::uuid;
 select * into v_existing from public.offline_sale_ingestions where tenant_id=p_tenant_id and sync_command_id=v_sync;
 if found then
   if v_existing.command_fingerprint<>p_fingerprint then raise exception using errcode='ID409',message='offline idempotency conflict'; end if;
   select r.id into v_reconciliation from public.offline_reconciliations r where r.tenant_id=p_tenant_id and r.ingestion_id=v_existing.id;
   return query select v_existing.id,v_existing.sync_status,v_existing.order_id,v_existing.payment_id,v_existing.fulfillment_id,v_reconciliation,v_existing.received_at; return;
 end if;
 select * into v_grant from public.offline_grants where tenant_id=p_tenant_id and id=(p_command->>'grantId')::uuid;
 if not found then raise exception using errcode='OG404',message='grant not found'; end if;
 if (p_command->>'deviceId')::uuid<>v_grant.device_id or (p_command->>'registerId')::uuid<>v_grant.register_id or p_command->>'currency'<>v_grant.currency then raise exception using errcode='OG403',message='grant binding mismatch'; end if;
 if (p_command->>'schemaVersion')::integer<>v_grant.schema_version then raise exception using errcode='OG422',message='schema version unsupported'; end if;
 v_accepted := (p_command->>'acceptedAt')::timestamptz;
 if v_accepted < v_grant.issued_at-interval '5 minutes' or v_accepted>v_grant.accepted_until or v_accepted>v_received+interval '5 minutes' then raise exception using errcode='OG410',message='acceptedAt outside grant authority'; end if;
 select d.status into v_device_status from public.devices d where d.tenant_id=p_tenant_id and d.id=v_grant.device_id;
 perform 1 from public.device_credentials c where c.tenant_id=p_tenant_id and c.id=p_credential_id and c.device_id=v_grant.device_id and c.valid_from<=v_accepted and (c.valid_to is null or c.valid_to>=v_accepted);
 if not found then raise exception using errcode='OS401',message='credential not valid at acceptance'; end if;
 if (p_command->>'offlineSaleOrdinal')::integer>v_grant.max_pending_offline_sales then raise exception using errcode='OL422',message='pending sale limit exceeded'; end if;
 for v_element in select value from pg_catalog.jsonb_array_elements(p_command->'lines') loop
   v_variant:=(v_element->>'variantId')::uuid; v_quantity:=(v_element->>'quantity')::bigint; v_price:=(v_element->>'grantedUnitPriceMinor')::bigint; v_price_id:=(v_element->>'priceId')::uuid;
   if v_quantity<=0 or v_quantity>v_grant.max_quantity_per_line then raise exception using errcode='OL422',message='line quantity limit exceeded'; end if;
   select variant into v_snapshot from (select variants.value variant from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) products(value), lateral pg_catalog.jsonb_array_elements(products.value->'variants') variants(value) where variants.value->>'variantId'=v_variant::text) q;
   if v_snapshot is null or (v_snapshot->>'authorizedUnitPriceMinor')::bigint<>v_price or (v_snapshot->>'priceId')::uuid<>v_price_id or not (v_snapshot->>'active')::boolean then raise exception using errcode='OG422',message='line not authorized by grant'; end if;
   select (product.value->>'brandId')::uuid into v_brand from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) product(value), lateral pg_catalog.jsonb_array_elements(product.value->'variants') variant(value) where variant.value->>'variantId'=v_variant::text;
   v_total:=v_total+v_quantity::numeric*v_price::numeric;
   v_order_lines:=v_order_lines||pg_catalog.jsonb_build_object('variant_id',v_variant,'product_id',(select (product.value->>'productId')::uuid from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) product(value), lateral pg_catalog.jsonb_array_elements(product.value->'variants') variant(value) where variant.value->>'variantId'=v_variant::text),'quantity',v_quantity,'unit_price_minor',v_price,'product_name',(select product.value->>'name' from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) product(value), lateral pg_catalog.jsonb_array_elements(product.value->'variants') variant(value) where variant.value->>'variantId'=v_variant::text),'variant_name',null,'sku',v_snapshot->>'sku','option_summary',v_snapshot->>'optionSummary');
 end loop;
 if v_total::bigint<>(p_command->>'totalMinor')::bigint then raise exception using errcode='OS422',message='offline monetary totals invalid'; end if;

 -- Deposit defaults to the full total (a normal sale); a smaller deposit is an installment.
 v_paid := coalesce((p_command->>'amountPaidMinor')::bigint, v_total::bigint);
 if v_paid < 0 or v_paid > v_total::bigint then raise exception using errcode='OS422',message='offline amount paid out of range'; end if;
 v_installment := v_paid < v_total::bigint;
 v_outstanding := v_total::bigint - v_paid;
 v_settle := v_paid;
 if v_installment then
   v_customer := nullif(p_command->>'customerId','')::uuid;
   if v_customer is null then raise exception using errcode='OS422',message='offline installment requires a customer'; end if;
   if v_paid < 1 then raise exception using errcode='OS422',message='offline installment requires a positive deposit'; end if;
   if coalesce((p_command->>'outstandingMinor')::bigint, -1) <> v_outstanding then raise exception using errcode='OS422',message='offline outstanding mismatch'; end if;
   if not exists(select 1 from public.customers where tenant_id=p_tenant_id and id=v_customer) then raise exception using errcode='OG404',message='customer not found'; end if;
   if v_outstanding > v_grant.max_offline_credit_exposure_minor then raise exception using errcode='OL422',message='offline credit limit exceeded'; end if;
   if coalesce((select sum((i.price_provenance->>'outstandingMinor')::bigint) from public.offline_sale_ingestions i where i.tenant_id=p_tenant_id and i.grant_id=v_grant.id),0)+v_outstanding>v_grant.max_offline_credit_exposure_minor then raise exception using errcode='OL422',message='offline cumulative credit exceeded'; end if;
 end if;

 -- Tenders/cash settle the amount collected now (deposit for an installment, else the full total).
 if p_command ? 'tenders' then
   if coalesce((select sum((t.value->>'amountMinor')::bigint) from pg_catalog.jsonb_array_elements(p_command->'tenders') t(value)),0)<>v_settle then raise exception using errcode='OS422',message='offline tenders do not sum to the amount settled'; end if;
 else
   if (p_command->>'cashReceivedMinor')::bigint-v_settle<>(p_command->>'changeMinor')::bigint or (p_command->>'cashReceivedMinor')::bigint<v_settle then raise exception using errcode='OS422',message='offline monetary totals invalid'; end if;
 end if;
 if v_total>v_grant.max_sale_amount_minor or (p_command->>'cumulativeExposureMinor')::bigint>v_grant.max_cumulative_exposure_minor or (p_command->>'cumulativeExposureMinor')::bigint<v_total then raise exception using errcode='OL422',message='offline exposure limit exceeded'; end if;
 if coalesce((select sum((i.price_provenance->>'totalMinor')::bigint) from public.offline_sale_ingestions i where i.tenant_id=p_tenant_id and i.grant_id=v_grant.id),0)+v_total>v_grant.max_cumulative_exposure_minor then raise exception using errcode='OL422',message='cumulative exposure exceeded'; end if;
 v_suffix:=pg_catalog.md5(p_tenant_id::text||':'||v_sync::text);
 v_order:=orders_private.create_order(p_tenant_id,'pos',v_grant.currency,v_brand,v_grant.branch_id,v_grant.register_id,v_grant.operator_membership_id,'offline-order:'||v_suffix,v_accepted,'Accepted offline; synchronized later.',v_order_lines);
 -- Capture the amount collected now (deposit for an installment, else the full total). Done BEFORE
 -- fulfillment, exactly as the connected path captures before fulfilling.
 if v_installment then
   if p_command ? 'tenders' then
     v_payment:=payments_private.capture_partial_payments(p_tenant_id,v_order,(select jsonb_agg(pg_catalog.jsonb_build_object('method',elem.value->>'method','amount_minor',(elem.value->>'amountMinor')::bigint) || case when elem.value->>'cashReceivedMinor' is not null then pg_catalog.jsonb_build_object('cash_received_minor',(elem.value->>'cashReceivedMinor')::bigint) else '{}'::jsonb end order by elem.ord) from pg_catalog.jsonb_array_elements(p_command->'tenders') with ordinality elem(value,ord)),v_grant.operator_membership_id,'offline-payment:'||v_suffix,v_paid);
   else
     v_payment:=payments_private.capture_partial_payments(p_tenant_id,v_order,pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('method','cash','amount_minor',v_paid,'cash_received_minor',(p_command->>'cashReceivedMinor')::bigint)),v_grant.operator_membership_id,'offline-payment:'||v_suffix,v_paid);
   end if;
 elsif p_command ? 'tenders' then
   v_payment:=payments_private.capture_payments(p_tenant_id,v_order,(select jsonb_agg(pg_catalog.jsonb_build_object('method',elem.value->>'method','amount_minor',(elem.value->>'amountMinor')::bigint) || case when elem.value->>'cashReceivedMinor' is not null then pg_catalog.jsonb_build_object('cash_received_minor',(elem.value->>'cashReceivedMinor')::bigint) else '{}'::jsonb end order by elem.ord) from pg_catalog.jsonb_array_elements(p_command->'tenders') with ordinality elem(value,ord)),v_grant.operator_membership_id,'offline-payment:'||v_suffix);
 else
   v_payment:=payments_private.capture_cash_payment(p_tenant_id,v_order,(p_command->>'cashReceivedMinor')::bigint,v_grant.operator_membership_id,'offline-payment:'||v_suffix);
 end if;
 if v_device_status='revoked' then v_sufficient:=false; v_reason:='device_revoked_at_ingestion';
 else
   for v_element in select value from pg_catalog.jsonb_array_elements(p_command->'lines') loop
     v_quantity:=inventory_private.lock_balance_for_offline_sale(p_tenant_id,(v_element->>'variantId')::uuid,v_grant.inventory_location_id);
     if coalesce(v_quantity,0)<(v_element->>'quantity')::bigint then v_sufficient:=false; end if;
   end loop;
   if not v_sufficient then v_reason:='insufficient_stock_at_ingestion'; end if;
 end if;
 -- ADR-042 §4 stock-grant hook (20261114160000). No-op at legacy locations.
 if v_sufficient then
   v_reason:=inventory_private.consume_offline_stock_grant(p_tenant_id,v_grant.id,v_grant.inventory_location_id,p_command->'lines',v_sync);
   if v_reason is not null then v_sufficient:=false; end if;
 end if;
 if v_sufficient then
   for v_line in select l.id,l.quantity from public.order_lines l where l.tenant_id=p_tenant_id and l.order_id=v_order order by l.line_number loop v_fulfillment_lines:=v_fulfillment_lines||pg_catalog.jsonb_build_object('order_line_id',v_line.id,'quantity',v_line.quantity); end loop;
   select f.fulfillment_id,f.inventory_operation_id into v_fulfillment,v_inventory_operation from fulfillments_private.record_fulfillment(p_tenant_id,v_order,v_grant.inventory_location_id,v_grant.operator_membership_id,'offline-fulfillment:'||v_suffix,v_received,v_fulfillment_lines) f;
 end if;
 -- Installment customer attach + debt recording run AFTER fulfillment (mirroring the connected record_sale
 -- ordering) so online_private.consume_reservations, gated on customer_id, treats this POS order as
 -- reservation-free and does not demand a non-existent stock reservation. Still unconditional within the
 -- transaction, so a needs_reconciliation installment also records the customer debt.
 if v_installment then
   select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('name',c.name,'email',c.email,'phone',c.phone)) into v_contact from public.customers c where c.tenant_id=p_tenant_id and c.id=v_customer;
   perform orders_private.attach_pos_customer(p_tenant_id,v_order,v_customer,v_contact);
   perform customers_ar_private.record_sale_debt(p_tenant_id,v_order,v_customer,v_grant.currency,v_total::bigint,v_paid,v_grant.operator_membership_id);
 end if;
 insert into public.offline_sale_ingestions(tenant_id,grant_id,device_id,credential_id,register_id,branch_id,inventory_location_id,local_sale_id,sync_command_id,command_fingerprint,canonical_command,device_signature_base64,accepted_at,received_at,order_id,payment_id,fulfillment_id,sync_status,price_provenance)
 values(p_tenant_id,v_grant.id,v_grant.device_id,p_credential_id,v_grant.register_id,v_grant.branch_id,v_grant.inventory_location_id,p_command->>'localSaleId',v_sync,p_fingerprint,p_canonical,p_signature,v_accepted,v_received,v_order,v_payment,v_fulfillment,case when v_sufficient then 'synced' else 'needs_reconciliation' end,pg_catalog.jsonb_build_object('grantId',v_grant.id,'snapshotId',v_grant.snapshot_id,'lines',p_command->'lines','totalMinor',v_total::bigint,'amountPaidMinor',v_paid,'outstandingMinor',v_outstanding)) returning id into v_ingestion;
 if not v_sufficient then
   insert into public.offline_reconciliations(tenant_id,ingestion_id,local_sale_id,order_id,payment_id,reason) values(p_tenant_id,v_ingestion,p_command->>'localSaleId',v_order,v_payment,v_reason) returning id into v_reconciliation;
   insert into public.offline_reconciliation_events(tenant_id,reconciliation_id,reason) values(p_tenant_id,v_reconciliation,v_reason);
 end if;
 return query select v_ingestion,case when v_sufficient then 'synced' else 'needs_reconciliation' end,v_order,v_payment,v_fulfillment,v_reconciliation,v_received;
exception when unique_violation then
 select * into v_existing from public.offline_sale_ingestions where tenant_id=p_tenant_id and sync_command_id=v_sync;
 if not found or v_existing.command_fingerprint<>p_fingerprint then raise exception using errcode='ID409',message='offline idempotency conflict'; end if;
 select id into v_reconciliation from public.offline_reconciliations where tenant_id=p_tenant_id and ingestion_id=v_existing.id;
 return query select v_existing.id,v_existing.sync_status,v_existing.order_id,v_existing.payment_id,v_existing.fulfillment_id,v_reconciliation,v_existing.received_at;
end;
$function$;
