-- Fix forward: preserve canonical fulfillment, adding reservation consumption in its rollback savepoint.
grant create on schema fulfillments_private to fulfillments_writer;
set role fulfillments_writer;
create or replace function fulfillments_private.record_fulfillment(
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
    perform online_private.consume_reservations(p_tenant_id,p_order_id,p_inventory_location_id,p_lines);
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

reset role;
revoke create on schema fulfillments_private from fulfillments_writer;
