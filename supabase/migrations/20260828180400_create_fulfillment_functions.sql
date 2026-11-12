-- Phase 2E (5/7): sanctioned fulfillment functions.
--   * fulfillment_intent_fingerprint          -- the ONE canonical client-intent fingerprint definition.
--   * resolve_fulfillment_replay_target       -- narrow authorization-bootstrap preflight (no commercial data).
--   * record_fulfillment                      -- sole atomic Fulfillment+lines+inventory-issue path.
--
-- All are owned by fulfillments_writer so they write/read as a role that is not any client/application
-- role and bypass (never-forced) RLS on exactly the fulfillment tables. Definer functions run with an
-- empty search_path and full schema qualification and use no dynamic SQL. service_role EXECUTE grants
-- and the fulfillments_writer read policies on orders/order_lines are in migration 6; PUBLIC execute is
-- revoked here.
--
-- Custom SQLSTATEs are internal-only signals mapped to stable application errors by the repository:
--   ID409 = idempotency key reused with a different client intent
--   FF010 = order not found          FF011 = order not placed (cancelled)
--   FF012 = order line not in order  FF013 = over-fulfillment
--   FF020/FF021/FF022 (raised by record_fulfillment_issue) = location missing/inactive/not-enabled

-- Canonical CLIENT-INTENT fingerprint. Reads ONLY order_line_id + quantity from each line, in array
-- order (line order is part of the intent), plus the tenant, order, and location. It deliberately
-- excludes actor, timestamps, the derived variant, and any inventory/operation detail, so a retry with
-- the same logical intent replays. Shared by the preflight and record_fulfillment so the two never
-- drift.
create function fulfillments_private.fulfillment_intent_fingerprint(
  p_tenant_id uuid,
  p_order_id uuid,
  p_inventory_location_id uuid,
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
    || coalesce(p_order_id::text, '') || E'\n'
    || coalesce(p_inventory_location_id::text, '')
    || coalesce(
      (
        select pg_catalog.string_agg(
          E'\n' || (line.value ->> 'order_line_id') || ',' || (line.value ->> 'quantity'),
          '' order by line.ord
        )
        from pg_catalog.jsonb_array_elements(p_lines) with ordinality as line(value, ord)
      ),
      ''
    )
  );
$function$;

comment on function fulfillments_private.fulfillment_intent_fingerprint(uuid, uuid, uuid, jsonb) is
  'Canonical client-intent md5: tenant, order, location, then ordered (order_line_id, quantity) lines. Excludes actor/timestamps/derived variant/inventory detail.';

-- Narrow authorization-bootstrap preflight. Given the verified tenant, a normalized idempotency key,
-- and the client intent, it returns just enough to route replay authorization: the fulfillment/order/
-- location identifiers AND the ORDER's commercial routing (channel/brand/branch) needed to authorize
-- BOTH the commercial and custody authorities on replay. It NEVER returns quantities, movement detail,
-- timestamps, or any other commercial field, and it discloses identifiers ONLY when the fingerprint
-- matches -- i.e. to a caller who reproduced the exact original intent. On a same-key/different-intent
-- conflict it returns fingerprint_matches=false with all identifiers NULL. A missing/blank key or a
-- non-existent (tenant, key) returns zero rows (NONE), so it never signals cross-tenant existence.
create function fulfillments_private.resolve_fulfillment_replay_target(
  p_tenant_id uuid,
  p_normalized_key text,
  p_intent jsonb
)
returns table (
  fingerprint_matches boolean,
  fulfillment_id uuid,
  order_id uuid,
  inventory_location_id uuid,
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
  v_fulfillment_id uuid;
  v_order_id uuid;
  v_location_id uuid;
  v_existing_fingerprint text;
  v_channel text;
  v_brand_id uuid;
  v_branch_id uuid;
begin
  if p_tenant_id is null or p_normalized_key is null or v_key = '' then
    return; -- NONE
  end if;

  v_fingerprint := fulfillments_private.fulfillment_intent_fingerprint(
    p_tenant_id,
    nullif(p_intent ->> 'order_id', '')::uuid,
    nullif(p_intent ->> 'inventory_location_id', '')::uuid,
    coalesce(p_intent -> 'lines', '[]'::jsonb)
  );

  select f.id, f.order_id, f.inventory_location_id, f.payload_fingerprint
  into v_fulfillment_id, v_order_id, v_location_id, v_existing_fingerprint
  from public.fulfillments as f
  where f.tenant_id = p_tenant_id
    and f.normalized_idempotency_key = v_key;

  if not found then
    return; -- NONE
  end if;

  if v_existing_fingerprint is distinct from v_fingerprint then
    return query select false, null::uuid, null::uuid, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;

  -- Matching intent: resolve the persisted Order's immutable commercial routing for replay auth.
  select o.channel, o.brand_id, o.branch_id
  into v_channel, v_brand_id, v_branch_id
  from public.orders as o
  where o.tenant_id = p_tenant_id
    and o.id = v_order_id;

  return query select true, v_fulfillment_id, v_order_id, v_location_id, v_channel, v_brand_id, v_branch_id;
end;
$function$;

comment on function fulfillments_private.resolve_fulfillment_replay_target(uuid, text, jsonb) is
  'Authorization-bootstrap preflight. Returns only fulfillment/order/location identifiers plus the Order commercial routing, and only on fingerprint match; conflict returns identifiers NULL; missing key returns no rows. Never exposes quantities or movement detail.';

-- Sole atomic Fulfillment creation path. In ONE transaction it: validates structural input; enforces
-- authoritative tenant-scoped idempotency; acquires the shared order-execution advisory lock; re-reads
-- the Order (must be 'placed'); resolves each OrderLine, derives its variant, and rejects
-- over-fulfillment against the committed remainder; issues the inventory (which acquires the Location
-- lifecycle lock, requires active + fulfillment-enabled, and delegates to record_operation); and
-- inserts the Fulfillment and its lines. The inventory issue and the fulfillment rows commit together
-- or not at all -- the savepoint block guarantees a race loser's inventory issue is rolled back.
create function fulfillments_private.record_fulfillment(
  p_tenant_id uuid,
  p_order_id uuid,
  p_inventory_location_id uuid,
  p_actor_membership_id uuid,
  p_idempotency_key text,
  p_fulfilled_at timestamptz,
  p_lines jsonb
)
returns table (fulfillment_id uuid, inventory_operation_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_norm text := lower(btrim(p_idempotency_key));
  v_fingerprint text;
  v_existing_id uuid;
  v_existing_operation_id uuid;
  v_existing_fingerprint text;
  v_order_status text;
  v_fulfillment_id uuid;
  v_operation_id uuid;
  v_inventory_key text;
  v_resolved jsonb := '[]'::jsonb;
  v_movements jsonb := '[]'::jsonb;
  v_element jsonb;
  v_order_line_id uuid;
  v_quantity bigint;
  v_variant_id uuid;
  v_order_line_qty bigint;
  v_existing_qty bigint;
  v_line_number integer;
  v_seen uuid[] := array[]::uuid[];
begin
  if p_tenant_id is null or p_order_id is null or p_inventory_location_id is null then
    raise exception using errcode = '22004', message = 'tenant, order, and location are required';
  end if;

  if p_idempotency_key is null or v_norm = '' then
    raise exception using errcode = '22023', message = 'idempotency_key must not be blank';
  end if;

  if pg_catalog.jsonb_typeof(p_lines) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = '22023', message = 'a fulfillment must contain at least one line';
  end if;

  -- Structural line validation + duplicate-order-line rejection (defense-in-depth; the service also
  -- rejects duplicates before this call).
  for v_element in
    select value from pg_catalog.jsonb_array_elements(p_lines) as t(value)
  loop
    if (v_element ->> 'order_line_id') is null or (v_element ->> 'quantity') is null then
      raise exception using errcode = '22023', message = 'each line requires order_line_id and quantity';
    end if;
    v_order_line_id := (v_element ->> 'order_line_id')::uuid;
    v_quantity := (v_element ->> 'quantity')::bigint;
    if v_quantity <= 0 then
      raise exception using errcode = '22023', message = 'line quantity must be positive';
    end if;
    if v_order_line_id = any (v_seen) then
      raise exception using errcode = '22023', message = 'an order line may appear at most once in a fulfillment';
    end if;
    v_seen := v_seen || v_order_line_id;
  end loop;

  v_fingerprint := fulfillments_private.fulfillment_intent_fingerprint(
    p_tenant_id, p_order_id, p_inventory_location_id, p_lines
  );

  -- Idempotency fast path: a committed (tenant, key) replays to the same Fulfillment when the intent
  -- matches, or is a deterministic conflict when it does not.
  select f.id, f.inventory_operation_id, f.payload_fingerprint
  into v_existing_id, v_existing_operation_id, v_existing_fingerprint
  from public.fulfillments as f
  where f.tenant_id = p_tenant_id
    and f.normalized_idempotency_key = v_norm;
  if v_existing_id is not null then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'idempotency key reused with a different fulfillment intent';
    end if;
    return query select v_existing_id, v_existing_operation_id;
    return;
  end if;

  -- Shared order-execution lock: serializes ALL fulfillments of this Order with each other and with
  -- cancel_order, so the over-fulfillment remainder is stable and cancel-vs-fulfill cannot interleave.
  perform commerce_locks.acquire_order_execution_lock(p_tenant_id, p_order_id);

  -- Repeat the idempotency lookup under the lock (a concurrent same-key winner may have committed while
  -- we waited).
  select f.id, f.inventory_operation_id, f.payload_fingerprint
  into v_existing_id, v_existing_operation_id, v_existing_fingerprint
  from public.fulfillments as f
  where f.tenant_id = p_tenant_id
    and f.normalized_idempotency_key = v_norm;
  if v_existing_id is not null then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'idempotency key reused with a different fulfillment intent';
    end if;
    return query select v_existing_id, v_existing_operation_id;
    return;
  end if;

  -- Re-read the Order under the lock. It must exist and be 'placed'; a cancelled Order can never be
  -- fulfilled (the lock makes the cancelled+fulfilled state impossible).
  select o.status into v_order_status
  from public.orders as o
  where o.tenant_id = p_tenant_id
    and o.id = p_order_id;
  if not found then
    raise exception using errcode = 'FF010', message = 'order not found';
  end if;
  if v_order_status is distinct from 'placed' then
    raise exception using errcode = 'FF011', message = 'order is not placed; a cancelled order cannot be fulfilled';
  end if;

  -- Resolve each line to its OrderLine (same Order), derive the variant, and reject over-fulfillment
  -- against the committed remainder. Build the resolved list (request order) reused for movements and
  -- line inserts so the OrderLine is never re-queried.
  for v_element in
    select value
    from pg_catalog.jsonb_array_elements(p_lines) with ordinality as t(value, ord)
    order by ord
  loop
    v_order_line_id := (v_element ->> 'order_line_id')::uuid;
    v_quantity := (v_element ->> 'quantity')::bigint;

    select ol.variant_id, ol.quantity
    into v_variant_id, v_order_line_qty
    from public.order_lines as ol
    where ol.tenant_id = p_tenant_id
      and ol.order_id = p_order_id
      and ol.id = v_order_line_id;
    if not found then
      raise exception using errcode = 'FF012', message = 'order line does not belong to this order';
    end if;

    select coalesce(pg_catalog.sum(fl.quantity), 0)
    into v_existing_qty
    from public.fulfillment_lines as fl
    where fl.tenant_id = p_tenant_id
      and fl.order_line_id = v_order_line_id;

    if v_quantity > v_order_line_qty - v_existing_qty then
      raise exception using errcode = 'FF013', message = 'requested quantity exceeds the unfulfilled remainder of the order line';
    end if;

    v_resolved := v_resolved || pg_catalog.jsonb_build_object(
      'order_line_id', v_order_line_id,
      'variant_id', v_variant_id,
      'quantity', v_quantity
    );
    v_movements := v_movements || pg_catalog.jsonb_build_object(
      'variant_id', v_variant_id,
      'inventory_location_id', p_inventory_location_id,
      'quantity_delta', (- v_quantity)
    );
  end loop;

  -- Compact, bounded, deterministic internal inventory idempotency key. Fulfillment idempotency (the
  -- caller's key) is authoritative; this is only a downstream backstop for the delegated issue.
  v_inventory_key := 'fulfillment:' || pg_catalog.md5(p_tenant_id::text || ':' || v_norm);

  -- Savepoint block: the inventory issue and the fulfillment rows commit together. On a same-key race,
  -- the unique_violation rolls this subtransaction back -- undoing the inventory issue -- and the loser
  -- replays the winner (or is ID409 on a different intent).
  begin
    v_operation_id := inventory_private.record_fulfillment_issue(
      p_tenant_id,
      p_inventory_location_id,
      v_movements,
      p_actor_membership_id,
      v_inventory_key,
      p_fulfilled_at
    );

    insert into public.fulfillments (
      tenant_id, order_id, inventory_location_id, inventory_operation_id, actor_membership_id,
      idempotency_key, payload_fingerprint, fulfilled_at
    )
    values (
      p_tenant_id, p_order_id, p_inventory_location_id, v_operation_id, p_actor_membership_id,
      p_idempotency_key, v_fingerprint, coalesce(p_fulfilled_at, pg_catalog.now())
    )
    returning id into v_fulfillment_id;

    v_line_number := 0;
    for v_element in
      select value from pg_catalog.jsonb_array_elements(v_resolved) with ordinality as t(value, ord) order by ord
    loop
      v_line_number := v_line_number + 1;
      insert into public.fulfillment_lines (
        tenant_id, fulfillment_id, order_id, order_line_id, variant_id, line_number, quantity
      )
      values (
        p_tenant_id,
        v_fulfillment_id,
        p_order_id,
        (v_element ->> 'order_line_id')::uuid,
        (v_element ->> 'variant_id')::uuid,
        v_line_number,
        (v_element ->> 'quantity')::bigint
      );
    end loop;
  exception
    when unique_violation then
      -- Idempotency-race loser: resolve to the winner on matching intent, else deterministic conflict.
      -- The subtransaction rollback has already undone the inventory issue this loser performed.
      select f.id, f.inventory_operation_id, f.payload_fingerprint
      into v_existing_id, v_existing_operation_id, v_existing_fingerprint
      from public.fulfillments as f
      where f.tenant_id = p_tenant_id
        and f.normalized_idempotency_key = v_norm;
      if v_existing_id is null then
        raise;
      end if;
      if v_existing_fingerprint is distinct from v_fingerprint then
        raise exception using errcode = 'ID409', message = 'idempotency key reused with a different fulfillment intent';
      end if;
      return query select v_existing_id, v_existing_operation_id;
      return;
  end;

  return query select v_fulfillment_id, v_operation_id;
end;
$function$;

comment on function fulfillments_private.record_fulfillment(uuid, uuid, uuid, uuid, text, timestamptz, jsonb) is
  'Sole atomic Fulfillment+lines+inventory-issue path. Shared order-execution lock serializes all fulfillments of one Order and cancel_order; over-fulfillment is checked against the committed remainder; the inventory issue and fulfillment rows are one transaction. Authoritative tenant-scoped idempotency (ID409 on same-key/different-intent).';

-- Transfer ownership to fulfillments_writer, granting CREATE only for the transfer, exactly as the
-- tables.
grant create on schema public, fulfillments_private to fulfillments_writer;
alter function fulfillments_private.fulfillment_intent_fingerprint(uuid, uuid, uuid, jsonb) owner to fulfillments_writer;
alter function fulfillments_private.resolve_fulfillment_replay_target(uuid, text, jsonb) owner to fulfillments_writer;
alter function fulfillments_private.record_fulfillment(uuid, uuid, uuid, uuid, text, timestamptz, jsonb) owner to fulfillments_writer;
revoke create on schema public, fulfillments_private from fulfillments_writer;

-- Deny PUBLIC (and therefore anon/authenticated) execute. service_role grants are in migration 6.
revoke all on function fulfillments_private.fulfillment_intent_fingerprint(uuid, uuid, uuid, jsonb) from public;
revoke all on function fulfillments_private.resolve_fulfillment_replay_target(uuid, text, jsonb) from public;
revoke all on function fulfillments_private.record_fulfillment(uuid, uuid, uuid, uuid, text, timestamptz, jsonb) from public;
