-- ADR-042 §3 — WEBSITE / POS STOCK CHANNEL POOLS (additive, feature-gated, nothing activated).
--
-- Canonical physical truth stays public.inventory_balances.on_hand_quantity (ADR-017). This migration adds a
-- governed PARTITION of that number into three buckets per (tenant, location, variant):
--   website | pos | unallocated
-- Invariant at a non-legacy location, checked per key at commit in 'enforced' mode:
--   website.on_hand + pos.on_hand + unallocated.on_hand = inventory_balances.on_hand_quantity
--   0 <= reserved_qty <= on_hand_qty on every channel row
-- Website reservations are NOT stored here: they are derived live from public.stock_reservations (active,
-- quantity - consumed_quantity), so there is exactly one source for them. reserved_qty is reserved for POS
-- offline stock grants (ADR-042 §4, a later migration) and is 0 until then.
--
-- Modes (public.inventory_locations.channel_stock_mode):
--   legacy   (default) today's behaviour; no channel rows, no triggers do any work.
--   shadow   channel rows are maintained from every canonical ledger write and admin allocations, but nothing
--            customer-facing reads them and nothing is ever refused because of them. A write that cannot be
--            attributed or would overdraw a bucket is logged in inventory_channel_divergences instead.
--   enforced the invariant is enforced at commit and an overdraw/unattributable write is refused. Entering
--            'enforced' is LOCKED in this migration (inventory_private.channel_feature_gate) until the storefront
--            read path, POS grants and acceptance evidence exist. No location can reach it by API.
--
-- Channel attribution of canonical ledger writes (ADR-042 §3.3, owner D-1):
--   issue linked to a fulfillment of an order with channel 'pos'    -> pos
--   issue linked to a fulfillment of an order with channel 'online' -> website
--   receipt from an accepted return ('return:<id>') of a POS order   -> pos (sellable restock only reaches here)
--   receipt from an accepted return of an online order              -> unallocated (no owner rule; safe default)
--   any other positive movement (receipt, opening, adjustment, correction, transfer in) -> unallocated
--   any other negative movement -> unallocated if it has enough, otherwise unattributable (refused in enforced)
-- Attribution runs in a DEFERRED constraint trigger so it sees the fulfillment/return row created after the
-- ledger write in the same transaction. A small pending table keeps per-key processing correct when one
-- transaction writes several movements for the same key, and vanishes with rolled-back subtransactions.
-- Additive and forward-only: no existing function, table or historical migration is modified.

-- ---------------------------------------------------------------------------------------------------------
-- Location mode + global enforcement gate
-- ---------------------------------------------------------------------------------------------------------
alter table public.inventory_locations
  add column channel_stock_mode text not null default 'legacy',
  add constraint inventory_locations_channel_stock_mode_valid
    check (channel_stock_mode in ('legacy', 'shadow', 'enforced'));

comment on column public.inventory_locations.channel_stock_mode is
  'ADR-042 Website/POS channel stock mode: legacy (default, unchanged behaviour) | shadow (maintained, never refuses) | enforced (invariant enforced). Changed only through inventory_private.set_channel_stock_mode.';

create table inventory_private.channel_feature_gate (
  singleton boolean primary key default true check (singleton),
  enforcement_unlocked boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into inventory_private.channel_feature_gate (singleton) values (true);
comment on table inventory_private.channel_feature_gate is
  'Deployment-wide lock on the enforced channel stock mode. Stays false until the storefront read path, POS stock grants and acceptance evidence ship (ADR-042 activation gate). Changed only by a reviewed migration.';

-- ---------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------
create table public.inventory_channel_balances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  inventory_location_id uuid not null,
  variant_id uuid not null,
  channel text not null,
  on_hand_qty bigint not null default 0,
  reserved_qty bigint not null default 0,
  version bigint not null default 0,
  last_ledger_entry_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_channel_balances_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint inventory_channel_balances_location_fk foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations (tenant_id, id) on delete restrict,
  constraint inventory_channel_balances_variant_fk foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete restrict,
  constraint inventory_channel_balances_channel_valid check (channel in ('website', 'pos', 'unallocated')),
  constraint inventory_channel_balances_on_hand_nonnegative check (on_hand_qty >= 0),
  constraint inventory_channel_balances_reserved_bounds check (reserved_qty >= 0 and reserved_qty <= on_hand_qty),
  constraint inventory_channel_balances_unallocated_unreserved check (channel <> 'unallocated' or reserved_qty = 0),
  constraint inventory_channel_balances_version_nonnegative check (version >= 0),
  constraint inventory_channel_balances_key_unique unique (tenant_id, inventory_location_id, variant_id, channel)
);
create index inventory_channel_balances_variant_idx
  on public.inventory_channel_balances (tenant_id, variant_id);

comment on table public.inventory_channel_balances is
  'ADR-042 partition of inventory_balances.on_hand_quantity into website/pos/unallocated buckets. Not a second stock truth: buckets must sum to the canonical balance.';

create table public.inventory_allocation_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  inventory_location_id uuid not null,
  run_type text not null,
  actor_membership_id uuid,
  reason text,
  idempotency_key text,
  normalized_idempotency_key text generated always as (lower(btrim(idempotency_key))) stored,
  payload_fingerprint text,
  lines jsonb not null,
  created_at timestamptz not null default now(),
  constraint inventory_allocation_runs_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint inventory_allocation_runs_location_fk foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations (tenant_id, id) on delete restrict,
  constraint inventory_allocation_runs_actor_fk foreign key (tenant_id, actor_membership_id)
    references public.memberships (tenant_id, id) on delete restrict,
  constraint inventory_allocation_runs_type_valid check (run_type in ('initialize', 'allocate', 'mode_change')),
  constraint inventory_allocation_runs_reason_valid check (reason is null or length(btrim(reason)) between 1 and 500),
  constraint inventory_allocation_runs_key_valid check (
    (idempotency_key is null and payload_fingerprint is null)
    or (normalized_idempotency_key <> '' and length(idempotency_key) <= 200 and payload_fingerprint ~ '^[a-f0-9]{32}$')),
  constraint inventory_allocation_runs_lines_array check (jsonb_typeof(lines) = 'array'),
  constraint inventory_allocation_runs_tenant_id_unique unique (tenant_id, id)
);
create unique index inventory_allocation_runs_idempotency_idx
  on public.inventory_allocation_runs (tenant_id, normalized_idempotency_key)
  where idempotency_key is not null;

comment on table public.inventory_allocation_runs is
  'Append-only audit of every channel initialization, admin Website/POS split and mode change (actor, reason, before/after per variant).';

create table public.inventory_channel_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  inventory_location_id uuid not null,
  variant_id uuid not null,
  channel text not null,
  event_type text not null,
  quantity_delta bigint not null,
  allocation_run_id uuid,
  inventory_operation_id uuid,
  inventory_movement_id uuid,
  actor_membership_id uuid,
  recorded_at timestamptz not null default now(),
  constraint inventory_channel_ledger_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint inventory_channel_ledger_location_fk foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations (tenant_id, id) on delete restrict,
  constraint inventory_channel_ledger_variant_fk foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete restrict,
  constraint inventory_channel_ledger_run_fk foreign key (tenant_id, allocation_run_id)
    references public.inventory_allocation_runs (tenant_id, id) on delete restrict,
  constraint inventory_channel_ledger_operation_fk foreign key (tenant_id, inventory_operation_id)
    references public.inventory_operations (tenant_id, id) on delete restrict,
  constraint inventory_channel_ledger_movement_fk foreign key (tenant_id, inventory_movement_id)
    references public.inventory_movements (tenant_id, id) on delete restrict,
  constraint inventory_channel_ledger_channel_valid check (channel in ('website', 'pos', 'unallocated')),
  constraint inventory_channel_ledger_event_valid check (event_type in (
    'opening_allocation', 'allocation', 'pos_sale', 'website_sale', 'pos_return_restock',
    'return_restock_unallocated', 'stock_in', 'stock_out')),
  constraint inventory_channel_ledger_delta_nonzero check (quantity_delta <> 0),
  constraint inventory_channel_ledger_source_present check (
    (allocation_run_id is not null) <> (inventory_movement_id is not null)),
  constraint inventory_channel_ledger_movement_once unique (tenant_id, inventory_movement_id),
  constraint inventory_channel_ledger_run_line_once unique (tenant_id, allocation_run_id, variant_id, channel)
);
create index inventory_channel_ledger_key_idx
  on public.inventory_channel_ledger (tenant_id, inventory_location_id, variant_id, recorded_at);

comment on table public.inventory_channel_ledger is
  'Append-only audit of every channel bucket change: allocation transfers and channel attribution of canonical ledger movements. Each canonical movement is attributed at most once.';

create table public.inventory_channel_divergences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  inventory_location_id uuid not null,
  variant_id uuid not null,
  inventory_movement_id uuid not null,
  code text not null,
  quantity_delta bigint not null,
  detail jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  constraint inventory_channel_divergences_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint inventory_channel_divergences_movement_fk foreign key (tenant_id, inventory_movement_id)
    references public.inventory_movements (tenant_id, id) on delete restrict,
  constraint inventory_channel_divergences_code_valid check (code in ('CH_UNATTRIBUTED', 'CH_INSUFFICIENT')),
  constraint inventory_channel_divergences_movement_once unique (tenant_id, inventory_movement_id)
);

comment on table public.inventory_channel_divergences is
  'Shadow-mode log of canonical movements that could not be applied to a channel bucket. Never blocks a sale. A later admin allocation re-derives unallocated and heals the key.';

-- Transaction-scoped work queue for the deferred attribution trigger (rows exist only inside a transaction).
create table inventory_private.channel_pending_movements (
  inventory_movement_id uuid primary key,
  tenant_id uuid not null,
  inventory_location_id uuid not null,
  variant_id uuid not null
);
create index channel_pending_movements_key_idx
  on inventory_private.channel_pending_movements (tenant_id, inventory_location_id, variant_id);

-- Immutable audit tables.
create trigger inventory_channel_ledger_immutable before update or delete on public.inventory_channel_ledger
  for each row execute function inventory_private.forbid_ledger_mutation();
create trigger inventory_channel_divergences_immutable before update or delete on public.inventory_channel_divergences
  for each row execute function inventory_private.forbid_ledger_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------------

-- Active online (website) reservations still outstanding for a stock key.
create function inventory_private.channel_website_reserved(p_tenant_id uuid, p_location_id uuid, p_variant_id uuid)
returns bigint language sql stable security definer set search_path = '' as $function$
  select coalesce(sum(r.quantity - r.consumed_quantity), 0)::bigint
    from public.stock_reservations r
   where r.tenant_id = p_tenant_id and r.inventory_location_id = p_location_id
     and r.variant_id = p_variant_id and r.status = 'active';
$function$;

-- Create the three bucket rows for a key if missing (all zero), then lock them in canonical order.
create function inventory_private.channel_lock_key(p_tenant_id uuid, p_location_id uuid, p_variant_id uuid)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  insert into public.inventory_channel_balances (tenant_id, inventory_location_id, variant_id, channel)
  select p_tenant_id, p_location_id, p_variant_id, c.channel
    from (values ('pos'), ('unallocated'), ('website')) as c(channel)
  on conflict (tenant_id, inventory_location_id, variant_id, channel) do nothing;
  perform 1 from public.inventory_channel_balances b
   where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id and b.variant_id = p_variant_id
   order by b.channel
   for update;
end;
$function$;

-- canonical - (website + pos + unallocated) for one key; 0 means the invariant holds.
create function inventory_private.channel_key_mismatch(p_tenant_id uuid, p_location_id uuid, p_variant_id uuid)
returns bigint language sql stable security definer set search_path = '' as $function$
  select coalesce((select ib.on_hand_quantity from public.inventory_balances ib
                    where ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id
                      and ib.variant_id = p_variant_id), 0)
       - coalesce((select sum(b.on_hand_qty) from public.inventory_channel_balances b
                    where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
                      and b.variant_id = p_variant_id), 0);
$function$;

-- Apply a delta to one bucket. Returns false (no change) if it would overdraw the bucket or its reservation.
create function inventory_private.channel_try_apply(
  p_tenant_id uuid, p_location_id uuid, p_variant_id uuid, p_channel text, p_delta bigint, p_ledger_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $function$
declare v_row public.inventory_channel_balances%rowtype;
begin
  select * into v_row from public.inventory_channel_balances b
   where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
     and b.variant_id = p_variant_id and b.channel = p_channel;
  if v_row.on_hand_qty + p_delta < v_row.reserved_qty then
    return false;
  end if;
  update public.inventory_channel_balances
     set on_hand_qty = on_hand_qty + p_delta, version = version + 1, updated_at = now(),
         last_ledger_entry_id = p_ledger_id
   where id = v_row.id;
  return true;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Ledger attribution triggers
-- ---------------------------------------------------------------------------------------------------------

-- Immediate: queue the movement if its location participates. FOR SHARE on the location row serializes with a
-- concurrent mode change (which takes a row update lock) without serializing sales with each other.
create function inventory_private.channel_queue_movement()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_mode text;
begin
  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = new.tenant_id and l.id = new.inventory_location_id
   for share;
  if v_mode is distinct from 'legacy' then
    insert into inventory_private.channel_pending_movements
      (inventory_movement_id, tenant_id, inventory_location_id, variant_id)
    values (new.id, new.tenant_id, new.inventory_location_id, new.variant_id);
  end if;
  return null;
end;
$function$;

-- Deferred (at commit): attribute this movement, then — once no movement for the key is still pending — check
-- the invariant in enforced mode.
create function inventory_private.channel_attribute_movement()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_pending inventory_private.channel_pending_movements%rowtype;
  v_mode text; v_op_type text; v_op_key text; v_order_channel text; v_return_channel text;
  v_channel text; v_event text; v_ledger uuid; v_ok boolean; v_mismatch bigint;
begin
  delete from inventory_private.channel_pending_movements p
   where p.inventory_movement_id = new.id
  returning * into v_pending;
  if not found then
    return null; -- legacy location, or already processed
  end if;

  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = new.tenant_id and l.id = new.inventory_location_id;
  select o.operation_type, o.normalized_idempotency_key into v_op_type, v_op_key
    from public.inventory_operations o where o.tenant_id = new.tenant_id and o.id = new.operation_id;

  perform inventory_private.channel_lock_key(new.tenant_id, new.inventory_location_id, new.variant_id);

  if v_op_type = 'issue' then
    select ord.channel into v_order_channel
      from public.fulfillments f
      join public.orders ord on ord.tenant_id = f.tenant_id and ord.id = f.order_id
     where f.tenant_id = new.tenant_id and f.inventory_operation_id = new.operation_id;
    if v_order_channel = 'pos' then v_channel := 'pos'; v_event := 'pos_sale';
    elsif v_order_channel = 'online' then v_channel := 'website'; v_event := 'website_sale';
    end if;
  elsif v_op_type = 'receipt' and v_op_key like 'return:%' and new.quantity_delta > 0 then
    select r.channel into v_return_channel from public.returns r
     where r.tenant_id = new.tenant_id and r.inventory_operation_id = new.operation_id;
    if v_return_channel = 'pos' then v_channel := 'pos'; v_event := 'pos_return_restock';
    elsif v_return_channel = 'online' then v_channel := 'unallocated'; v_event := 'return_restock_unallocated';
    end if;
  elsif new.quantity_delta > 0 then
    v_channel := 'unallocated'; v_event := 'stock_in';
  else
    v_channel := 'unallocated'; v_event := 'stock_out';
  end if;

  if v_channel is null then
    if v_mode = 'enforced' then
      raise exception using errcode = 'CH422', message = 'stock movement has no channel attribution';
    end if;
    insert into public.inventory_channel_divergences
      (tenant_id, inventory_location_id, variant_id, inventory_movement_id, code, quantity_delta, detail)
    values (new.tenant_id, new.inventory_location_id, new.variant_id, new.id, 'CH_UNATTRIBUTED', new.quantity_delta,
            jsonb_build_object('operationType', v_op_type));
    return null;
  end if;

  v_ledger := gen_random_uuid();
  v_ok := inventory_private.channel_try_apply(new.tenant_id, new.inventory_location_id, new.variant_id,
            v_channel, new.quantity_delta, v_ledger);
  if not v_ok then
    if v_mode = 'enforced' then
      raise exception using errcode = 'CH409', message = 'channel stock insufficient',
        detail = v_channel;
    end if;
    insert into public.inventory_channel_divergences
      (tenant_id, inventory_location_id, variant_id, inventory_movement_id, code, quantity_delta, detail)
    values (new.tenant_id, new.inventory_location_id, new.variant_id, new.id, 'CH_INSUFFICIENT', new.quantity_delta,
            jsonb_build_object('channel', v_channel, 'operationType', v_op_type));
    return null;
  end if;

  insert into public.inventory_channel_ledger
    (id, tenant_id, inventory_location_id, variant_id, channel, event_type, quantity_delta,
     inventory_operation_id, inventory_movement_id)
  values (v_ledger, new.tenant_id, new.inventory_location_id, new.variant_id, v_channel, v_event,
          new.quantity_delta, new.operation_id, new.id);

  if v_mode = 'enforced' and not exists (
       select 1 from inventory_private.channel_pending_movements p
        where p.tenant_id = new.tenant_id and p.inventory_location_id = new.inventory_location_id
          and p.variant_id = new.variant_id) then
    v_mismatch := inventory_private.channel_key_mismatch(new.tenant_id, new.inventory_location_id, new.variant_id);
    if v_mismatch <> 0 then
      raise exception using errcode = 'CH500', message = 'channel stock invariant violated',
        detail = v_mismatch::text;
    end if;
  end if;
  return null;
end;
$function$;

create trigger inventory_movements_channel_queue
  after insert on public.inventory_movements
  for each row execute function inventory_private.channel_queue_movement();

create constraint trigger inventory_movements_channel_attribute
  after insert on public.inventory_movements
  deferrable initially deferred
  for each row execute function inventory_private.channel_attribute_movement();

-- ---------------------------------------------------------------------------------------------------------
-- Initialization (legacy -> shadow). Puts ALL existing on-hand in 'unallocated': no guessed split.
-- ---------------------------------------------------------------------------------------------------------
create function inventory_private.initialize_channel_stock(
  p_tenant_id uuid, p_location_id uuid, p_actor_membership_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $function$
declare v_mode text; v_run uuid; v_key record; v_lines jsonb := '[]'::jsonb;
begin
  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = p_location_id;
  if not found then raise exception using errcode = 'CH404', message = 'inventory location not found'; end if;
  if v_mode <> 'legacy' then raise exception using errcode = 'CH409', message = 'channel stock already initialized'; end if;

  -- Global lock order (same as every sale): balance rows (by variant) BEFORE the location row.
  for v_key in
    select ib.variant_id, ib.on_hand_quantity from public.inventory_balances ib
     where ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id
     order by ib.variant_id
     for update
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('variantId', v_key.variant_id, 'unallocated', v_key.on_hand_quantity));
  end loop;
  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = p_location_id
   for update;
  if v_mode <> 'legacy' then raise exception using errcode = 'CH409', message = 'channel stock already initialized'; end if;

  insert into public.inventory_allocation_runs (tenant_id, inventory_location_id, run_type, actor_membership_id, reason, lines)
  values (p_tenant_id, p_location_id, 'initialize', p_actor_membership_id, 'Channel stock initialization (all stock unallocated)', v_lines)
  returning id into v_run;

  for v_key in
    select ib.variant_id, ib.on_hand_quantity from public.inventory_balances ib
     where ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id
     order by ib.variant_id
  loop
    perform inventory_private.channel_lock_key(p_tenant_id, p_location_id, v_key.variant_id);
    if v_key.on_hand_quantity <> 0 then
      update public.inventory_channel_balances b
         set on_hand_qty = v_key.on_hand_quantity, version = b.version + 1, updated_at = now()
       where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
         and b.variant_id = v_key.variant_id and b.channel = 'unallocated';
      insert into public.inventory_channel_ledger
        (tenant_id, inventory_location_id, variant_id, channel, event_type, quantity_delta, allocation_run_id, actor_membership_id)
      values (p_tenant_id, p_location_id, v_key.variant_id, 'unallocated', 'opening_allocation',
              v_key.on_hand_quantity, v_run, p_actor_membership_id);
    end if;
  end loop;

  update public.inventory_locations set channel_stock_mode = 'shadow'
   where tenant_id = p_tenant_id and id = p_location_id;
  return v_run;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Admin Website/POS split. Lines: [{"variantId", "websiteQuantity", "posQuantity", "expectedBalanceVersion"?}]
-- Sets absolute targets; unallocated = canonical - website - pos (which also heals a shadow divergence).
-- ---------------------------------------------------------------------------------------------------------
create function inventory_private.allocate_channel_stock(
  p_tenant_id uuid, p_location_id uuid, p_actor_membership_id uuid, p_reason text,
  p_idempotency_key text, p_lines jsonb
) returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_mode text; v_run uuid; v_existing_fp text; v_fp text; v_canonical_text text;
  v_line jsonb; v_variant uuid; v_web bigint; v_pos bigint; v_expected bigint;
  v_on_hand bigint; v_version bigint; v_web_reserved bigint; v_pos_reserved bigint;
  v_before jsonb; v_after_lines jsonb := '[]'::jsonb; v_cur record; v_target bigint; v_delta bigint;
  v_norm text := lower(btrim(p_idempotency_key));
begin
  if p_idempotency_key is null or v_norm = '' or length(p_idempotency_key) > 200 then
    raise exception using errcode = '22023', message = 'idempotency_key is required';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'reason is required';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 1000 then
    raise exception using errcode = '22023', message = 'between 1 and 1000 allocation lines are required';
  end if;

  -- Canonical, order-independent fingerprint (lines sorted by variant).
  select string_agg(x.value ->> 'variantId' || ',' || coalesce(x.value ->> 'websiteQuantity', '') || ','
                    || coalesce(x.value ->> 'posQuantity', '') || ',' || coalesce(x.value ->> 'expectedBalanceVersion', ''),
                    E'\n' order by x.value ->> 'variantId')
    into v_canonical_text from jsonb_array_elements(p_lines) x;
  v_fp := md5(p_tenant_id::text || E'\n' || p_location_id::text || E'\n' || coalesce(p_actor_membership_id::text, '')
              || E'\n' || btrim(p_reason) || E'\n' || v_canonical_text);

  perform pg_advisory_xact_lock(hashtextextended('channel-allocation:' || p_tenant_id::text || ':' || v_norm, 0));
  select r.id, r.payload_fingerprint into v_run, v_existing_fp from public.inventory_allocation_runs r
   where r.tenant_id = p_tenant_id and r.normalized_idempotency_key = v_norm;
  if v_run is not null then
    if v_existing_fp <> v_fp then
      raise exception using errcode = 'ID409', message = 'idempotency key reused with a different payload';
    end if;
    return v_run;
  end if;

  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = p_location_id;
  if not found then raise exception using errcode = 'CH404', message = 'inventory location not found'; end if;
  if v_mode = 'legacy' then raise exception using errcode = 'CH412', message = 'channel stock not initialized for this location'; end if;

  -- Validate shape and reject duplicate variants before taking any lock.
  if (select count(*) from jsonb_array_elements(p_lines)) <>
     (select count(distinct x.value ->> 'variantId') from jsonb_array_elements(p_lines) x) then
    raise exception using errcode = '22023', message = 'duplicate variant in allocation';
  end if;
  for v_line in select x.value from jsonb_array_elements(p_lines) x loop
    if jsonb_typeof(v_line) <> 'object' or (v_line ->> 'variantId') is null
       or coalesce(v_line ->> 'websiteQuantity', '') !~ '^[0-9]{1,15}$'
       or coalesce(v_line ->> 'posQuantity', '') !~ '^[0-9]{1,15}$'
       or (v_line ? 'expectedBalanceVersion' and coalesce(v_line ->> 'expectedBalanceVersion', '') !~ '^[0-9]{1,18}$') then
      raise exception using errcode = '22023', message = 'invalid allocation line';
    end if;
  end loop;

  -- Global lock order: every listed balance row (by variant), THEN the location row, then channel rows.
  perform 1 from public.inventory_balances ib
   where ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id
     and ib.variant_id in (select (x.value ->> 'variantId')::uuid from jsonb_array_elements(p_lines) x)
   order by ib.variant_id
   for update;
  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = p_location_id
   for share;
  if v_mode = 'legacy' then raise exception using errcode = 'CH412', message = 'channel stock not initialized for this location'; end if;

  insert into public.inventory_allocation_runs
    (tenant_id, inventory_location_id, run_type, actor_membership_id, reason, idempotency_key, payload_fingerprint, lines)
  values (p_tenant_id, p_location_id, 'allocate', p_actor_membership_id, btrim(p_reason), p_idempotency_key, v_fp, '[]'::jsonb)
  returning id into v_run;

  -- Lock canonical rows first, in record_operation's order, so the split cannot race a sale or an order.
  for v_line in select x.value from jsonb_array_elements(p_lines) x order by (x.value ->> 'variantId')::uuid loop
    v_variant := (v_line ->> 'variantId')::uuid;
    v_web := (v_line ->> 'websiteQuantity')::bigint;
    v_pos := (v_line ->> 'posQuantity')::bigint;
    v_expected := nullif(v_line ->> 'expectedBalanceVersion', '')::bigint;

    select ib.on_hand_quantity, ib.version into v_on_hand, v_version from public.inventory_balances ib
     where ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id and ib.variant_id = v_variant
     for update;
    if not found then
      -- No balance row yet. Whether the variant exists in this tenant is proven by the channel rows' foreign
      -- key below (inventory_writer has no catalog read grant, by design).
      v_on_hand := 0; v_version := 0;
    end if;
    if v_expected is not null and v_expected <> v_version then
      raise exception using errcode = 'CH409', message = 'stock changed since it was read; reload and retry',
        detail = v_variant::text;
    end if;
    if v_web + v_pos > v_on_hand then
      raise exception using errcode = 'CH422', message = 'allocation exceeds on-hand stock', detail = v_variant::text;
    end if;

    begin
      perform inventory_private.channel_lock_key(p_tenant_id, p_location_id, v_variant);
    exception when foreign_key_violation then
      raise exception using errcode = 'CH404', message = 'variant not found', detail = v_variant::text;
    end;
    v_web_reserved := inventory_private.channel_website_reserved(p_tenant_id, p_location_id, v_variant);
    select b.reserved_qty into v_pos_reserved from public.inventory_channel_balances b
     where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id and b.variant_id = v_variant and b.channel = 'pos';
    if v_web < v_web_reserved then
      raise exception using errcode = 'CH422', message = 'website allocation below open website reservations', detail = v_variant::text;
    end if;
    if v_pos < v_pos_reserved then
      raise exception using errcode = 'CH422', message = 'pos allocation below reserved pos stock', detail = v_variant::text;
    end if;

    select jsonb_object_agg(b.channel, b.on_hand_qty) into v_before from public.inventory_channel_balances b
     where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id and b.variant_id = v_variant;

    for v_cur in
      select b.channel, b.on_hand_qty from public.inventory_channel_balances b
       where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id and b.variant_id = v_variant
       order by b.channel
    loop
      v_target := case v_cur.channel when 'website' then v_web when 'pos' then v_pos else v_on_hand - v_web - v_pos end;
      v_delta := v_target - v_cur.on_hand_qty;
      if v_delta <> 0 then
        update public.inventory_channel_balances b
           set on_hand_qty = v_target, version = b.version + 1, updated_at = now()
         where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
           and b.variant_id = v_variant and b.channel = v_cur.channel;
        insert into public.inventory_channel_ledger
          (tenant_id, inventory_location_id, variant_id, channel, event_type, quantity_delta, allocation_run_id, actor_membership_id)
        values (p_tenant_id, p_location_id, v_variant, v_cur.channel, 'allocation', v_delta, v_run, p_actor_membership_id);
      end if;
    end loop;

    v_after_lines := v_after_lines || jsonb_build_array(jsonb_build_object(
      'variantId', v_variant, 'canonicalOnHand', v_on_hand, 'balanceVersion', v_version, 'before', v_before,
      'after', jsonb_build_object('website', v_web, 'pos', v_pos, 'unallocated', v_on_hand - v_web - v_pos)));
  end loop;

  -- Runs are append-only. The before/after evidence is only known after the locks above, so it is written onto
  -- the run exactly once, inside this transaction, through the single permitted path (channel_finalize_run).
  perform inventory_private.channel_finalize_run(v_run, v_after_lines);
  return v_run;
end;
$function$;

-- The only permitted mutation of an allocation run: filling its evidence once, inside the creating transaction.
create function inventory_private.channel_finalize_run(p_run_id uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  perform set_config('inventory_private.allow_run_finalize', p_run_id::text, true);
  update public.inventory_allocation_runs set lines = p_lines where id = p_run_id and lines = '[]'::jsonb;
  perform set_config('inventory_private.allow_run_finalize', '', true);
end;
$function$;

-- Runs are immutable except for that single finalize of a just-created run.
create function inventory_private.guard_allocation_run_mutation()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if tg_op = 'UPDATE'
     and pg_catalog.current_setting('inventory_private.allow_run_finalize', true) = old.id::text
     and old.lines = '[]'::jsonb
     -- Generated columns are not yet computed in a BEFORE trigger's NEW, so they are excluded.
     and (pg_catalog.to_jsonb(new) - 'lines' - 'normalized_idempotency_key')
         = (pg_catalog.to_jsonb(old) - 'lines' - 'normalized_idempotency_key') then
    return new;
  end if;
  raise exception using errcode = '55000', message = 'inventory allocation runs are append-only';
end;
$function$;
create trigger inventory_allocation_runs_immutable before update or delete on public.inventory_allocation_runs
  for each row execute function inventory_private.guard_allocation_run_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- Reconciliation, availability and mode change
-- ---------------------------------------------------------------------------------------------------------
create function inventory_private.channel_reconciliation(p_tenant_id uuid, p_location_id uuid)
returns table(variant_id uuid, canonical_on_hand bigint, website_on_hand bigint, pos_on_hand bigint,
              unallocated_on_hand bigint, mismatch bigint, explicitly_allocated boolean)
language sql stable security definer set search_path = '' as $function$
  with keys as (
    select ib.variant_id from public.inventory_balances ib
     where ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id
    union
    select b.variant_id from public.inventory_channel_balances b
     where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
  )
  select k.variant_id,
         coalesce(ib.on_hand_quantity, 0),
         coalesce(sum(b.on_hand_qty) filter (where b.channel = 'website'), 0)::bigint,
         coalesce(sum(b.on_hand_qty) filter (where b.channel = 'pos'), 0)::bigint,
         coalesce(sum(b.on_hand_qty) filter (where b.channel = 'unallocated'), 0)::bigint,
         (coalesce(ib.on_hand_quantity, 0) - coalesce(sum(b.on_hand_qty), 0))::bigint,
         exists (select 1 from public.inventory_allocation_runs r, jsonb_array_elements(r.lines) l
                       where r.tenant_id = p_tenant_id and r.inventory_location_id = p_location_id
                         and r.run_type = 'allocate' and (l.value ->> 'variantId')::uuid = k.variant_id)
    from keys k
    left join public.inventory_balances ib
      on ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id and ib.variant_id = k.variant_id
    left join public.inventory_channel_balances b
      on b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id and b.variant_id = k.variant_id
   group by k.variant_id, ib.on_hand_quantity;
$function$;

create function inventory_private.channel_availability(p_tenant_id uuid, p_location_id uuid)
returns table(variant_id uuid, mode text, canonical_on_hand bigint,
              website_on_hand bigint, website_reserved bigint, website_available bigint,
              pos_on_hand bigint, pos_reserved bigint, pos_available bigint, unallocated_on_hand bigint,
              mismatch bigint, explicitly_allocated boolean)
language sql stable security definer set search_path = '' as $function$
  select r.variant_id, l.channel_stock_mode, r.canonical_on_hand,
         r.website_on_hand,
         inventory_private.channel_website_reserved(p_tenant_id, p_location_id, r.variant_id),
         greatest(r.website_on_hand - inventory_private.channel_website_reserved(p_tenant_id, p_location_id, r.variant_id), 0),
         r.pos_on_hand,
         coalesce(pb.reserved_qty, 0),
         greatest(r.pos_on_hand - coalesce(pb.reserved_qty, 0), 0),
         r.unallocated_on_hand,
         r.mismatch,
         r.explicitly_allocated
    from inventory_private.channel_reconciliation(p_tenant_id, p_location_id) r
    join public.inventory_locations l on l.tenant_id = p_tenant_id and l.id = p_location_id
    left join public.inventory_channel_balances pb
      on pb.tenant_id = p_tenant_id and pb.inventory_location_id = p_location_id
     and pb.variant_id = r.variant_id and pb.channel = 'pos';
$function$;

-- shadow -> enforced requires the deployment gate, zero mismatches and every stocked variant explicitly split.
-- enforced -> shadow is allowed (canonical stock remains the truth). Nothing returns to legacy.
create function inventory_private.set_channel_stock_mode(
  p_tenant_id uuid, p_location_id uuid, p_mode text, p_actor_membership_id uuid, p_reason text
) returns text language plpgsql security definer set search_path = '' as $function$
declare v_mode text; v_unlocked boolean; v_bad bigint; v_unsplit bigint;
begin
  if p_mode not in ('shadow', 'enforced') then
    raise exception using errcode = '22023', message = 'mode must be shadow or enforced';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'reason is required';
  end if;
  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = p_location_id;
  if not found then raise exception using errcode = 'CH404', message = 'inventory location not found'; end if;
  if v_mode = 'legacy' then raise exception using errcode = 'CH412', message = 'initialize channel stock first'; end if;
  if v_mode = p_mode then return v_mode; end if;
  if p_mode = 'enforced' then
    select g.enforcement_unlocked into v_unlocked from inventory_private.channel_feature_gate g;
    if not coalesce(v_unlocked, false) then
      raise exception using errcode = 'CH423', message = 'enforced channel stock is not available in this deployment';
    end if;
    -- Global lock order: balance rows before the location row.
    perform 1 from public.inventory_balances ib
     where ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id
     order by ib.variant_id for update;
  end if;
  select l.channel_stock_mode into v_mode from public.inventory_locations l
   where l.tenant_id = p_tenant_id and l.id = p_location_id
   for update;
  if v_mode = p_mode then return v_mode; end if;

  if p_mode = 'enforced' then
    select count(*) filter (where r.mismatch <> 0),
           count(*) filter (where r.canonical_on_hand > 0 and not r.explicitly_allocated)
      into v_bad, v_unsplit
      from inventory_private.channel_reconciliation(p_tenant_id, p_location_id) r;
    if v_bad > 0 then
      raise exception using errcode = 'CH409', message = 'channel stock does not reconcile', detail = v_bad::text;
    end if;
    if v_unsplit > 0 then
      raise exception using errcode = 'CH409', message = 'stocked variants without an explicit Website/POS split',
        detail = v_unsplit::text;
    end if;
  end if;

  update public.inventory_locations set channel_stock_mode = p_mode
   where tenant_id = p_tenant_id and id = p_location_id;
  insert into public.inventory_allocation_runs (tenant_id, inventory_location_id, run_type, actor_membership_id, reason, lines)
  values (p_tenant_id, p_location_id, 'mode_change', p_actor_membership_id, btrim(p_reason),
          jsonb_build_array(jsonb_build_object('from', v_mode, 'to', p_mode)));
  return p_mode;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Read access the attribution trigger needs (same pattern as earlier cross-domain reads).
-- ---------------------------------------------------------------------------------------------------------
grant select on public.orders, public.fulfillments, public.returns, public.stock_reservations to inventory_writer;
create policy inventory_writer_order_read on public.orders for select to inventory_writer using (true);
create policy inventory_writer_fulfillment_read on public.fulfillments for select to inventory_writer using (true);
create policy inventory_writer_return_read on public.returns for select to inventory_writer using (true);
create policy inventory_writer_reservation_read on public.stock_reservations for select to inventory_writer using (true);
-- The location mode lives on a table inventory_writer does not own.
grant select, update (channel_stock_mode) on public.inventory_locations to inventory_writer;
do $b$ begin
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'inventory_locations'
                   and policyname = 'inventory_writer_location_channel_mode') then
    create policy inventory_writer_location_channel_mode on public.inventory_locations
      for all to inventory_writer using (true) with check (true);
  end if;
end $b$;

-- ---------------------------------------------------------------------------------------------------------
-- Ownership + least privilege (grant -> transfer -> revoke), mirroring 20260821180000.
-- ---------------------------------------------------------------------------------------------------------
grant create on schema public, inventory_private to inventory_writer;
alter table public.inventory_channel_balances owner to inventory_writer;
alter table public.inventory_channel_ledger owner to inventory_writer;
alter table public.inventory_allocation_runs owner to inventory_writer;
alter table public.inventory_channel_divergences owner to inventory_writer;
alter table inventory_private.channel_pending_movements owner to inventory_writer;
alter table inventory_private.channel_feature_gate owner to inventory_writer;
alter function inventory_private.channel_website_reserved(uuid, uuid, uuid) owner to inventory_writer;
alter function inventory_private.channel_lock_key(uuid, uuid, uuid) owner to inventory_writer;
alter function inventory_private.channel_key_mismatch(uuid, uuid, uuid) owner to inventory_writer;
alter function inventory_private.channel_try_apply(uuid, uuid, uuid, text, bigint, uuid) owner to inventory_writer;
alter function inventory_private.channel_queue_movement() owner to inventory_writer;
alter function inventory_private.channel_attribute_movement() owner to inventory_writer;
alter function inventory_private.initialize_channel_stock(uuid, uuid, uuid) owner to inventory_writer;
alter function inventory_private.allocate_channel_stock(uuid, uuid, uuid, text, text, jsonb) owner to inventory_writer;
alter function inventory_private.channel_finalize_run(uuid, jsonb) owner to inventory_writer;
alter function inventory_private.guard_allocation_run_mutation() owner to inventory_writer;
alter function inventory_private.channel_reconciliation(uuid, uuid) owner to inventory_writer;
alter function inventory_private.channel_availability(uuid, uuid) owner to inventory_writer;
alter function inventory_private.set_channel_stock_mode(uuid, uuid, text, uuid, text) owner to inventory_writer;
revoke create on schema public, inventory_private from inventory_writer;

alter table public.inventory_channel_balances enable row level security;
alter table public.inventory_channel_ledger enable row level security;
alter table public.inventory_allocation_runs enable row level security;
alter table public.inventory_channel_divergences enable row level security;
alter table inventory_private.channel_pending_movements enable row level security;
alter table inventory_private.channel_feature_gate enable row level security;

revoke all on table public.inventory_channel_balances, public.inventory_channel_ledger,
  public.inventory_allocation_runs, public.inventory_channel_divergences,
  inventory_private.channel_pending_movements, inventory_private.channel_feature_gate from public;
revoke all on function inventory_private.channel_website_reserved(uuid, uuid, uuid) from public;
revoke all on function inventory_private.channel_lock_key(uuid, uuid, uuid) from public;
revoke all on function inventory_private.channel_key_mismatch(uuid, uuid, uuid) from public;
revoke all on function inventory_private.channel_try_apply(uuid, uuid, uuid, text, bigint, uuid) from public;
revoke all on function inventory_private.channel_queue_movement() from public;
revoke all on function inventory_private.channel_attribute_movement() from public;
revoke all on function inventory_private.initialize_channel_stock(uuid, uuid, uuid) from public;
revoke all on function inventory_private.allocate_channel_stock(uuid, uuid, uuid, text, text, jsonb) from public;
revoke all on function inventory_private.channel_finalize_run(uuid, jsonb) from public;
revoke all on function inventory_private.guard_allocation_run_mutation() from public;
revoke all on function inventory_private.channel_reconciliation(uuid, uuid) from public;
revoke all on function inventory_private.channel_availability(uuid, uuid) from public;
revoke all on function inventory_private.set_channel_stock_mode(uuid, uuid, text, uuid, text) from public;

do $b$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    -- The server reads channel state and calls only the three management entry points + two read functions.
    execute 'grant select on public.inventory_channel_balances, public.inventory_channel_ledger, public.inventory_allocation_runs, public.inventory_channel_divergences to service_role';
    execute 'grant execute on function inventory_private.initialize_channel_stock(uuid, uuid, uuid) to service_role';
    execute 'grant execute on function inventory_private.allocate_channel_stock(uuid, uuid, uuid, text, text, jsonb) to service_role';
    execute 'grant execute on function inventory_private.set_channel_stock_mode(uuid, uuid, text, uuid, text) to service_role';
    execute 'grant execute on function inventory_private.channel_reconciliation(uuid, uuid) to service_role';
    execute 'grant execute on function inventory_private.channel_availability(uuid, uuid) to service_role';
  end if;
end $b$;
