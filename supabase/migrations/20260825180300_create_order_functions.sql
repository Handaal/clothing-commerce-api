-- Phase 2D (4/5): sanctioned order functions.
--   * order_intent_fingerprint       -- the ONE canonical client-intent fingerprint definition.
--   * resolve_idempotent_replay_target -- narrow authorization-bootstrap preflight (no commercial data).
--   * create_order                   -- sole atomic order+lines creation path (authoritative idempotency).
--   * cancel_order                   -- atomic, write-once placed->cancelled transition.
--
-- All are owned by orders_writer so they write/read as a role that is not any client/application role
-- and bypass (never-forced) RLS on exactly the order tables. Definer functions run with an empty
-- search_path and full schema qualification and use no dynamic SQL. service_role EXECUTE grants are in
-- migration 5; PUBLIC execute is revoked here.
--
-- Custom SQLSTATEs are internal-only signals mapped to stable application errors by the repository:
--   ID409 = idempotency key reused with a different client intent.

-- Canonical CLIENT-INTENT fingerprint. Reads ONLY variant_id + quantity from each line, in array
-- order (line/display order is part of the intent). It deliberately excludes resolved prices,
-- snapshots, notes, actor, and derived brand/branch, so a retry with the same logical intent replays
-- even after the catalog changed. Shared by the preflight and create_order so the two never drift.
create function orders_private.order_intent_fingerprint(
  p_tenant_id uuid,
  p_channel text,
  p_currency text,
  p_register_id uuid,
  p_lines jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.md5(
    p_tenant_id::text || E'\n'
    || coalesce(p_channel, '') || E'\n'
    || coalesce(p_currency, '') || E'\n'
    || coalesce(p_register_id::text, '')
    || coalesce(
      (
        select pg_catalog.string_agg(
          E'\n' || (line.value ->> 'variant_id') || ',' || (line.value ->> 'quantity'),
          '' order by line.ord
        )
        from pg_catalog.jsonb_array_elements(p_lines) with ordinality as line(value, ord)
      ),
      ''
    )
  );
$function$;

comment on function orders_private.order_intent_fingerprint(uuid, text, text, uuid, jsonb) is
  'Canonical client-intent md5: tenant, channel, currency, register, then ordered (variant_id, quantity) lines. Excludes prices/snapshots/notes/actor/derived brand+branch.';

-- Narrow authorization-bootstrap preflight. Given the verified tenant, a normalized idempotency key,
-- and the client intent, it returns just enough to route replay authorization. It NEVER returns lines,
-- prices, totals, notes, timestamps, or any other commercial field, and it discloses the routing
-- identifiers (order_id/channel/brand_id/branch_id) ONLY when the fingerprint matches -- i.e. to a
-- caller who reproduced the exact original intent. On a same-key/different-intent conflict it returns
-- fingerprint_matches=false with all identifiers NULL. A missing/blank key or a non-existent
-- (tenant, key) returns zero rows (NONE), so it never signals cross-tenant existence.
create function orders_private.resolve_idempotent_replay_target(
  p_tenant_id uuid,
  p_normalized_key text,
  p_intent jsonb
)
returns table (
  fingerprint_matches boolean,
  order_id uuid,
  channel text,
  brand_id uuid,
  branch_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_key text := lower(btrim(p_normalized_key));
  v_fingerprint text;
  v_id uuid;
  v_channel text;
  v_brand_id uuid;
  v_branch_id uuid;
  v_existing_fingerprint text;
begin
  if p_tenant_id is null or p_normalized_key is null or v_key = '' then
    return; -- NONE
  end if;

  v_fingerprint := orders_private.order_intent_fingerprint(
    p_tenant_id,
    p_intent ->> 'channel',
    p_intent ->> 'currency',
    nullif(p_intent ->> 'register_id', '')::uuid,
    coalesce(p_intent -> 'lines', '[]'::jsonb)
  );

  select o.id, o.channel, o.brand_id, o.branch_id, o.payload_fingerprint
  into v_id, v_channel, v_brand_id, v_branch_id, v_existing_fingerprint
  from public.orders as o
  where o.tenant_id = p_tenant_id
    and o.normalized_idempotency_key = v_key;

  if not found then
    return; -- NONE
  end if;

  if v_existing_fingerprint is not distinct from v_fingerprint then
    return query select true, v_id, v_channel, v_brand_id, v_branch_id;
  else
    return query select false, null::uuid, null::text, null::uuid, null::uuid;
  end if;
end;
$function$;

comment on function orders_private.resolve_idempotent_replay_target(uuid, text, jsonb) is
  'Authorization-bootstrap preflight. Returns only routing metadata and only on fingerprint match; conflict returns identifiers NULL; missing key returns no rows. Never exposes commercial order data.';

-- Sole atomic order creation path. The application passes already-authorized snapshots (prices,
-- product/variant names, sku, option summary); this function performs structural integrity only:
-- tenant-safe FKs (via constraints), single brand/currency, channel/branch/register consistency,
-- positive quantities, money-range checks, atomic order+lines insert, tenant-scoped idempotency, and
-- the per-tenant order-number counter. It resolves NO catalog/pricing and authorizes NO user.
create function orders_private.create_order(
  p_tenant_id uuid,
  p_channel text,
  p_currency text,
  p_brand_id uuid,
  p_branch_id uuid,
  p_register_id uuid,
  p_actor_membership_id uuid,
  p_idempotency_key text,
  p_placed_at timestamptz,
  p_notes text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  bigint_max constant numeric := 9223372036854775807;
  v_norm text := lower(btrim(p_idempotency_key));
  v_fingerprint text;
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_order_id uuid;
  v_order_number text;
  v_next bigint;
  v_element jsonb;
  v_quantity bigint;
  v_unit_price bigint;
  v_line_total numeric;
  v_total numeric := 0;
  v_line_number integer;
begin
  if p_tenant_id is null or p_brand_id is null then
    raise exception using errcode = '22004', message = 'tenant and brand are required';
  end if;

  if p_channel not in ('pos', 'online') then
    raise exception using errcode = '22023', message = 'channel must be pos or online';
  end if;

  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'currency must be an uppercase ISO 4217 code';
  end if;

  if p_channel = 'pos' and (p_branch_id is null or p_register_id is null) then
    raise exception using errcode = '22023', message = 'pos orders require a branch and a register';
  end if;

  if p_channel = 'online' and (p_branch_id is not null or p_register_id is not null) then
    raise exception using errcode = '22023', message = 'online orders must not carry a branch or register';
  end if;

  if pg_catalog.jsonb_typeof(p_lines) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = '22023', message = 'an order must contain at least one line';
  end if;

  if p_idempotency_key is not null and v_norm = '' then
    raise exception using errcode = '22023', message = 'idempotency_key must not be blank';
  end if;

  -- Pass 1: validate each line and accumulate the total using numeric (never unchecked bigint
  -- multiplication), rejecting any line or order total outside the bigint range.
  for v_element in
    select ordered.value
    from pg_catalog.jsonb_array_elements(p_lines) with ordinality as ordered(value, ord)
    order by ordered.ord
  loop
    if (v_element ->> 'variant_id') is null
      or (v_element ->> 'product_id') is null
      or (v_element ->> 'quantity') is null
      or (v_element ->> 'unit_price_minor') is null
      or (v_element ->> 'product_name') is null
      or (v_element ->> 'sku') is null then
      raise exception using errcode = '22023', message = 'each line requires variant, product, quantity, price, name, and sku';
    end if;

    v_quantity := (v_element ->> 'quantity')::bigint;
    v_unit_price := (v_element ->> 'unit_price_minor')::bigint;

    if v_quantity <= 0 then
      raise exception using errcode = '22023', message = 'line quantity must be positive';
    end if;
    if v_unit_price < 0 then
      raise exception using errcode = '22023', message = 'line unit price must be non-negative';
    end if;

    v_line_total := v_quantity::numeric * v_unit_price::numeric;
    if v_line_total > bigint_max then
      raise exception using errcode = '22003', message = 'line total exceeds the supported range';
    end if;

    v_total := v_total + v_line_total;
    if v_total > bigint_max then
      raise exception using errcode = '22003', message = 'order total exceeds the supported range';
    end if;
  end loop;

  v_fingerprint := orders_private.order_intent_fingerprint(
    p_tenant_id, p_channel, p_currency, p_register_id, p_lines
  );

  -- Idempotency fast path: a committed (tenant, key) replays to the same order when the client intent
  -- matches, or is a deterministic conflict when it does not.
  if p_idempotency_key is not null then
    select o.id, o.payload_fingerprint
    into v_existing_id, v_existing_fingerprint
    from public.orders as o
    where o.tenant_id = p_tenant_id
      and o.normalized_idempotency_key = v_norm;

    if v_existing_id is not null then
      if v_existing_fingerprint is distinct from v_fingerprint then
        raise exception using errcode = 'ID409', message = 'idempotency key reused with a different order intent';
      end if;
      return v_existing_id;
    end if;
  end if;

  -- Race path: two concurrent first submissions of the same key. The implicit savepoint of this
  -- BEGIN block means a unique-violation here rolls back the counter increment too, so an
  -- idempotency-race loser never burns an order number.
  begin
    -- Per-tenant order number: lock (or race-safely create) the counter row, then increment it in
    -- this transaction so a rollback rolls back the increment.
    loop
      perform 1 from public.order_number_sequences where tenant_id = p_tenant_id for update;
      exit when found;
      begin
        insert into public.order_number_sequences (tenant_id, next_value) values (p_tenant_id, 0);
        exit;
      exception
        when unique_violation then
          null; -- another session created it first; retry the locking select
      end;
    end loop;

    update public.order_number_sequences
      set next_value = next_value + 1, updated_at = pg_catalog.now()
      where tenant_id = p_tenant_id
      returning next_value into v_next;

    v_order_number := v_next::text;

    insert into public.orders (
      tenant_id, brand_id, branch_id, register_id, order_number, channel, status, currency,
      total_minor, actor_membership_id, idempotency_key, payload_fingerprint, notes, placed_at
    )
    values (
      p_tenant_id, p_brand_id, p_branch_id, p_register_id, v_order_number, p_channel, 'placed',
      p_currency, v_total::bigint, p_actor_membership_id, p_idempotency_key,
      case when p_idempotency_key is null then null else v_fingerprint end,
      p_notes, coalesce(p_placed_at, pg_catalog.now())
    )
    returning id into v_order_id;

    v_line_number := 0;
    for v_element in
      select ordered.value
      from pg_catalog.jsonb_array_elements(p_lines) with ordinality as ordered(value, ord)
      order by ordered.ord
    loop
      v_line_number := v_line_number + 1;
      v_quantity := (v_element ->> 'quantity')::bigint;
      v_unit_price := (v_element ->> 'unit_price_minor')::bigint;

      insert into public.order_lines (
        tenant_id, order_id, brand_id, product_id, variant_id, line_number, quantity,
        unit_price_minor, line_total_minor, product_name_snapshot, variant_name_snapshot,
        sku_snapshot, option_summary_snapshot
      )
      values (
        p_tenant_id, v_order_id, p_brand_id, (v_element ->> 'product_id')::uuid,
        (v_element ->> 'variant_id')::uuid, v_line_number, v_quantity, v_unit_price,
        (v_quantity::numeric * v_unit_price::numeric)::bigint,
        v_element ->> 'product_name', v_element ->> 'variant_name',
        v_element ->> 'sku', v_element ->> 'option_summary'
      );
    end loop;
  exception
    when unique_violation then
      -- Idempotency-race loser: resolve to the winner on matching intent, else deterministic conflict.
      if p_idempotency_key is null then
        raise;
      end if;
      select o.id, o.payload_fingerprint
      into v_existing_id, v_existing_fingerprint
      from public.orders as o
      where o.tenant_id = p_tenant_id
        and o.normalized_idempotency_key = v_norm;
      if v_existing_id is null then
        raise;
      end if;
      if v_existing_fingerprint is distinct from v_fingerprint then
        raise exception using errcode = 'ID409', message = 'idempotency key reused with a different order intent';
      end if;
      return v_existing_id;
  end;

  return v_order_id;
end;
$function$;

comment on function orders_private.create_order(uuid, text, text, uuid, uuid, uuid, uuid, text, timestamptz, text, jsonb) is
  'Sole atomic order+lines creation path. Authoritative tenant-scoped idempotency (ID409 on same-key/different-intent), per-tenant transactional order number, numeric money-range checks. Authorizes nothing and resolves no catalog data.';

-- Atomic, write-once placed->cancelled transition. Cancellation writes actor/time/reason exactly once;
-- a retry on an already-cancelled order returns the existing cancellation and never overwrites it,
-- even if the retry supplies a different reason. No payment/inventory/fulfillment side effects.
create function orders_private.cancel_order(
  p_tenant_id uuid,
  p_order_id uuid,
  p_cancelled_by_membership_id uuid,
  p_reason text
)
returns table (
  order_id uuid,
  status text,
  cancelled_at timestamptz,
  cancelled_by_membership_id uuid,
  cancellation_reason text,
  already_cancelled boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_status text;
  v_cancelled_at timestamptz;
  v_cancelled_by uuid;
  v_reason text;
begin
  if p_tenant_id is null or p_order_id is null then
    raise exception using errcode = '22004', message = 'tenant and order are required';
  end if;

  -- Permit the guarded UPDATE only for the remainder of this call.
  perform pg_catalog.set_config('orders_private.allow_order_write', 'on', true);

  update public.orders as o
    set status = 'cancelled',
        cancelled_at = pg_catalog.now(),
        cancelled_by_membership_id = p_cancelled_by_membership_id,
        cancellation_reason = p_reason,
        updated_at = pg_catalog.now()
    where o.tenant_id = p_tenant_id
      and o.id = p_order_id
      and o.status = 'placed'
    returning o.id, o.status, o.cancelled_at, o.cancelled_by_membership_id, o.cancellation_reason
    into v_id, v_status, v_cancelled_at, v_cancelled_by, v_reason;

  perform pg_catalog.set_config('orders_private.allow_order_write', 'off', true);

  if v_id is not null then
    return query select v_id, v_status, v_cancelled_at, v_cancelled_by, v_reason, false;
    return;
  end if;

  -- Not transitioned: either the order does not exist (no rows -> ORDER_NOT_FOUND) or it is already
  -- cancelled (return the preserved original metadata, write-once).
  select o.id, o.status, o.cancelled_at, o.cancelled_by_membership_id, o.cancellation_reason
  into v_id, v_status, v_cancelled_at, v_cancelled_by, v_reason
  from public.orders as o
  where o.tenant_id = p_tenant_id
    and o.id = p_order_id;

  if v_id is null then
    return;
  end if;

  return query select v_id, v_status, v_cancelled_at, v_cancelled_by, v_reason, true;
end;
$function$;

comment on function orders_private.cancel_order(uuid, uuid, uuid, text) is
  'Atomic write-once placed->cancelled transition. Re-cancelling returns the preserved original metadata. No payment/inventory/fulfillment side effects.';

-- Transfer ownership to orders_writer, granting CREATE only for the transfer, exactly as the tables.
grant create on schema public, orders_private to orders_writer;
alter function orders_private.order_intent_fingerprint(uuid, text, text, uuid, jsonb) owner to orders_writer;
alter function orders_private.resolve_idempotent_replay_target(uuid, text, jsonb) owner to orders_writer;
alter function orders_private.create_order(uuid, text, text, uuid, uuid, uuid, uuid, text, timestamptz, text, jsonb) owner to orders_writer;
alter function orders_private.cancel_order(uuid, uuid, uuid, text) owner to orders_writer;
revoke create on schema public, orders_private from orders_writer;

-- Deny PUBLIC (and therefore anon/authenticated) execute. service_role grants are in migration 5.
revoke all on function orders_private.order_intent_fingerprint(uuid, text, text, uuid, jsonb) from public;
revoke all on function orders_private.resolve_idempotent_replay_target(uuid, text, jsonb) from public;
revoke all on function orders_private.create_order(uuid, text, text, uuid, uuid, uuid, uuid, text, timestamptz, text, jsonb) from public;
revoke all on function orders_private.cancel_order(uuid, uuid, uuid, text) from public;
