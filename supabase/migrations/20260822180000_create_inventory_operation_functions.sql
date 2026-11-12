-- Phase 2C: inventory operation functions (opening + count adjustment) and the generic 'issue' exit.
-- These are the application-boundary primitives that let the future commerce domains express stock
-- intent without ever touching the raw Phase 2B ledger. Both new functions are SECURITY DEFINER,
-- owned by the dedicated inventory_writer role, run with an empty search_path and full schema
-- qualification, use no dynamic SQL, and are the only additional paths able to write inventory. The
-- privilege boundary is unchanged: service_role holds SELECT plus EXECUTE on the sanctioned
-- functions and no direct table DML.
--
-- Two correctness guarantees cannot be provided from the application over PostgREST (one RPC per
-- call, no shared transaction across a read and a write), so they are enforced here inside a single
-- locked transaction:
--   * record_opening establishes initial stock exactly once by checking for ANY prior movement
--     history under the balance-row lock (historical truth, not balance-row absence).
--   * record_count_adjustment reconciles to an ABSOLUTE counted quantity with optimistic version
--     concurrency: it rejects a stale count whose expected balance version no longer matches, so a
--     concurrent movement between the operator's read and the write can never apply a stale delta.
-- Custom SQLSTATEs are internal-only signals mapped to stable application errors by the repository:
--   IN001 = opening already exists (prior movement history)
--   IN002 = concurrent modification (balance version mismatch)
-- Idempotency reuses the existing ID409 signal for a reused key carrying a different payload.

-- Extend the reserved operation classification with the generic physical exit 'issue'. This is a
-- fix-forward change to the existing CHECK; the merged Phase 2B migration is never rewritten. 'issue'
-- means "approved physical stock left this location" (waste, sample, manual removal, operational
-- consumption); it is deliberately NOT 'sale' and carries no order/fulfillment workflow.
set role inventory_writer;
alter table public.inventory_operations
  drop constraint inventory_operations_type_valid;
alter table public.inventory_operations
  add constraint inventory_operations_type_valid check (
    operation_type in (
      'opening', 'adjustment', 'correction', 'receipt', 'sale', 'return', 'transfer', 'issue'
    )
  );
reset role;

-- record_opening runs as inventory_writer and delegates the ledger write to record_operation in this
-- private schema, so the writer role needs USAGE here to resolve the qualified call. It already owns
-- record_operation (hence may execute it); this grant only lets it reference the schema. inventory_writer
-- remains non-login and is granted to no client or application role, so the boundary is unchanged.
grant usage on schema inventory_private to inventory_writer;

comment on column public.inventory_operations.operation_type is
  'Reserved audit classification. Phase 2C producers use opening/adjustment/receipt/issue/transfer; correction/sale/return remain reserved for later workflow domains. issue is a generic physical exit, never a sale.';

-- One-time opening initialization. Establishes a stock key''s first history exactly once. It locks
-- (or race-safely creates) the single balance key, then, UNDER that lock, rejects the opening if any
-- movement already exists for the key -- unless this is an idempotent replay of the same key, which
-- resolves to the original operation. The actual operation + movement + balance write is delegated to
-- the audited record_operation so the ledger, fingerprint, and idempotency semantics stay identical.
create function inventory_private.record_opening(
  p_tenant_id uuid,
  p_variant_id uuid,
  p_inventory_location_id uuid,
  p_quantity bigint,
  p_actor_membership_id uuid default null,
  p_idempotency_key text default null,
  p_occurred_at timestamptz default null,
  p_notes text default null
)
returns table (operation_id uuid, previous_on_hand bigint, on_hand bigint, version bigint)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_normalized_key text := lower(btrim(p_idempotency_key));
  v_movements jsonb;
  v_operation_id uuid;
  v_history_exists boolean;
  v_keyed_operation_exists boolean;
  v_previous bigint;
  v_on_hand bigint;
  v_version bigint;
begin
  if p_tenant_id is null or p_variant_id is null or p_inventory_location_id is null then
    raise exception using errcode = '22004', message = 'tenant, variant, and location are required';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception using errcode = '22023', message = 'opening quantity must be positive';
  end if;

  if p_idempotency_key is not null and v_normalized_key = '' then
    raise exception using errcode = '22023', message = 'idempotency_key must not be blank';
  end if;

  -- Permit projection writes only for the remainder of this atomic call (the row creation below and,
  -- transitively, the delegated record_operation both need this transaction-local flag).
  perform pg_catalog.set_config('inventory_private.allow_balance_write', 'on', true);

  -- Obtain a real row lock on the single balance key, creating it race-safely at zero if absent. This
  -- is the same canonical lock every mutation of this key takes, so two concurrent openings serialize
  -- here rather than both slipping past a lock-free history check.
  loop
    perform 1
    from public.inventory_balances
    where tenant_id = p_tenant_id
      and variant_id = p_variant_id
      and inventory_location_id = p_inventory_location_id
    for update;

    exit when found;

    begin
      insert into public.inventory_balances (
        tenant_id, variant_id, inventory_location_id, on_hand_quantity, version
      )
      values (p_tenant_id, p_variant_id, p_inventory_location_id, 0, 0);
      exit;
    exception
      when unique_violation then
        null; -- another session created it first; retry the locking select
    end;
  end loop;

  select exists (
    select 1
    from public.inventory_movements
    where tenant_id = p_tenant_id
      and variant_id = p_variant_id
      and inventory_location_id = p_inventory_location_id
  )
  into v_history_exists;

  if v_history_exists then
    -- A key with history may only "re-open" as an idempotent replay of the same key. Any other
    -- attempt (a different key, or the same key with a different payload) is rejected: same-key
    -- different-payload is surfaced by record_operation as ID409, everything else as IN001.
    v_keyed_operation_exists := false;
    if p_idempotency_key is not null then
      select exists (
        select 1
        from public.inventory_operations
        where tenant_id = p_tenant_id
          and normalized_idempotency_key = v_normalized_key
      )
      into v_keyed_operation_exists;
    end if;

    if not v_keyed_operation_exists then
      raise exception using
        errcode = 'IN001',
        message = 'opening stock already exists for this variant and location';
    end if;
  end if;

  -- Capture the on-hand before this operation (0 for a genuine first opening) while still holding the
  -- lock, so the result can report an authoritative previous value.
  select balance.on_hand_quantity
  into v_previous
  from public.inventory_balances as balance
  where balance.tenant_id = p_tenant_id
    and balance.variant_id = p_variant_id
    and balance.inventory_location_id = p_inventory_location_id;

  v_movements := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'variant_id', p_variant_id,
      'inventory_location_id', p_inventory_location_id,
      'quantity_delta', p_quantity
    )
  );

  -- Delegate the ledger write (or idempotent replay / ID409) to the audited mutation path.
  v_operation_id := inventory_private.record_operation(
    p_tenant_id,
    'opening',
    v_movements,
    p_actor_membership_id,
    p_idempotency_key,
    p_occurred_at,
    p_notes
  );

  select balance.on_hand_quantity, balance.version
  into v_on_hand, v_version
  from public.inventory_balances as balance
  where balance.tenant_id = p_tenant_id
    and balance.variant_id = p_variant_id
    and balance.inventory_location_id = p_inventory_location_id;

  return query select v_operation_id, coalesce(v_previous, 0::bigint), v_on_hand, v_version;
end;
$function$;

comment on function inventory_private.record_opening(uuid, uuid, uuid, bigint, uuid, text, timestamptz, text) is
  'One-time stock initialization. Rejects (IN001) when prior movement history exists for the key, except idempotent replays. Delegates the ledger write to record_operation; returns the authoritative operation id, on-hand, and version.';

-- Absolute counted-quantity reconciliation with optimistic version concurrency. The caller expresses
-- "the physical count is N" plus the balance version it read; the function derives the delta under the
-- balance-row lock and rejects a stale count (IN002) if the version changed. A count equal to current
-- on-hand is a deterministic no-op that records no zero movement. It is self-contained (not delegated)
-- because the idempotency identity is the caller''s inputs (counted quantity + expected version), not
-- the derived delta.
create function inventory_private.record_count_adjustment(
  p_tenant_id uuid,
  p_variant_id uuid,
  p_inventory_location_id uuid,
  p_counted_quantity bigint,
  p_expected_version bigint,
  p_actor_membership_id uuid default null,
  p_idempotency_key text default null,
  p_occurred_at timestamptz default null,
  p_notes text default null
)
returns table (operation_id uuid, previous_on_hand bigint, on_hand bigint, version bigint, changed boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_normalized_key text := lower(btrim(p_idempotency_key));
  v_fingerprint text;
  v_existing_fingerprint text;
  v_operation_id uuid;
  v_previous bigint;
  v_current bigint;
  v_version bigint;
  v_delta bigint;
  v_changed boolean;
begin
  if p_tenant_id is null or p_variant_id is null or p_inventory_location_id is null then
    raise exception using errcode = '22004', message = 'tenant, variant, and location are required';
  end if;

  if p_counted_quantity is null or p_counted_quantity < 0 then
    raise exception using errcode = '22023', message = 'counted quantity must be zero or greater';
  end if;

  if p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'expected version must be zero or greater';
  end if;

  if p_idempotency_key is not null and v_normalized_key = '' then
    raise exception using errcode = '22023', message = 'idempotency_key must not be blank';
  end if;

  -- Caller-stable idempotency identity: the physical count and the version it was taken against,
  -- never the derived delta (which depends on transient current state and would break replay).
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n'
    || 'adjustment' || E'\n'
    || coalesce(p_actor_membership_id::text, '') || E'\n'
    || 'count' || E'\n'
    || p_variant_id::text || ',' || p_inventory_location_id::text || ','
    || p_counted_quantity::text || ',' || p_expected_version::text
  );

  -- Idempotency fast path: a recorded (tenant, key) replays to the original operation when the
  -- payload matches and is a deterministic ID409 when it does not. Checked before the version guard
  -- so a post-success retry replays instead of failing the (now advanced) version comparison.
  if p_idempotency_key is not null then
    select operation.id, operation.payload_fingerprint
    into v_operation_id, v_existing_fingerprint
    from public.inventory_operations as operation
    where operation.tenant_id = p_tenant_id
      and operation.normalized_idempotency_key = v_normalized_key;

    if v_operation_id is not null then
      if v_existing_fingerprint is distinct from v_fingerprint then
        raise exception using
          errcode = 'ID409',
          message = 'idempotency key reused with a different payload';
      end if;

      select balance.on_hand_quantity, balance.version
      into v_current, v_version
      from public.inventory_balances as balance
      where balance.tenant_id = p_tenant_id
        and balance.variant_id = p_variant_id
        and balance.inventory_location_id = p_inventory_location_id;

      -- The idempotency lookup deliberately precedes the version comparison, so a post-success retry
      -- replays even after a later movement advanced the version (never IN002). A changed count owns
      -- exactly one movement; a no-op observation owns none, so replay reports the original changed
      -- flag by movement existence rather than assuming true.
      select exists (
        select 1
        from public.inventory_movements as movement
        where movement.tenant_id = p_tenant_id
          and movement.operation_id = v_operation_id
      )
      into v_changed;

      return query select
        v_operation_id,
        coalesce(v_current, 0::bigint),
        coalesce(v_current, 0::bigint),
        coalesce(v_version, 0::bigint),
        v_changed;
      return;
    end if;
  end if;

  perform pg_catalog.set_config('inventory_private.allow_balance_write', 'on', true);

  -- Lock (or race-safely create) the single balance key so the version read and the write are atomic.
  loop
    perform 1
    from public.inventory_balances
    where tenant_id = p_tenant_id
      and variant_id = p_variant_id
      and inventory_location_id = p_inventory_location_id
    for update;

    exit when found;

    begin
      insert into public.inventory_balances (
        tenant_id, variant_id, inventory_location_id, on_hand_quantity, version
      )
      values (p_tenant_id, p_variant_id, p_inventory_location_id, 0, 0);
      exit;
    exception
      when unique_violation then
        null;
    end;
  end loop;

  select balance.on_hand_quantity, balance.version
  into v_current, v_version
  from public.inventory_balances as balance
  where balance.tenant_id = p_tenant_id
    and balance.variant_id = p_variant_id
    and balance.inventory_location_id = p_inventory_location_id;

  v_previous := v_current;

  -- Optimistic concurrency on the monotonic version (not on-hand, so ABA cannot mask a change).
  if v_version is distinct from p_expected_version then
    raise exception using
      errcode = 'IN002',
      message = 'inventory balance changed since it was read; refresh and retry the count';
  end if;

  v_delta := p_counted_quantity - v_current;

  -- Append the operation envelope for BOTH a changed count and a deterministic no-op. A no-op records
  -- "the physical count was observed and already matched the system" as an audit/idempotency envelope
  -- with no movement and no balance change, so its idempotency key is durably consumed exactly like a
  -- changed count (same key replays; same key + different payload is ID409). A concurrent
  -- first-submission of the same key is resolved like record_operation. The envelope is inserted
  -- before the movement/balance write so a no-op and a changed count share one identity path.
  begin
    insert into public.inventory_operations (
      tenant_id, operation_type, actor_membership_id, idempotency_key, payload_fingerprint,
      occurred_at, recorded_at, notes
    )
    values (
      p_tenant_id, 'adjustment', p_actor_membership_id, p_idempotency_key, v_fingerprint,
      coalesce(p_occurred_at, pg_catalog.now()), pg_catalog.now(), p_notes
    )
    returning id into v_operation_id;
  exception
    when unique_violation then
      if p_idempotency_key is null then
        raise;
      end if;
      select operation.id, operation.payload_fingerprint
      into v_operation_id, v_existing_fingerprint
      from public.inventory_operations as operation
      where operation.tenant_id = p_tenant_id
        and operation.normalized_idempotency_key = v_normalized_key;
      if v_existing_fingerprint is distinct from v_fingerprint then
        raise exception using
          errcode = 'ID409',
          message = 'idempotency key reused with a different payload';
      end if;
      -- The concurrent winner recorded the identical count; return its result without re-applying.
      -- Its changed flag is derived from movement existence (a no-op winner owns no movement).
      select balance.on_hand_quantity, balance.version
      into v_current, v_version
      from public.inventory_balances as balance
      where balance.tenant_id = p_tenant_id
        and balance.variant_id = p_variant_id
        and balance.inventory_location_id = p_inventory_location_id;
      select exists (
        select 1
        from public.inventory_movements as movement
        where movement.tenant_id = p_tenant_id
          and movement.operation_id = v_operation_id
      )
      into v_changed;
      return query select v_operation_id, v_previous, v_current, v_version, v_changed;
      return;
  end;

  if v_delta = 0 then
    -- Durable no-op: the envelope above is persisted, but no movement is written and the balance and
    -- version are unchanged. InventoryOperation is the command/event record; InventoryMovement is the
    -- physical-quantity source of truth, so "no physical change" means no movement.
    perform pg_catalog.set_config('inventory_private.allow_balance_write', 'off', true);
    return query select v_operation_id, v_previous, v_current, v_version, false;
    return;
  end if;

  -- Changed count: advance the balance to the absolute counted quantity and append one movement.
  -- Qualify the right-hand version so it resolves to the table column, never the OUT parameter of the
  -- same name; then advance the locals we already hold rather than RETURNING into ambiguous names.
  update public.inventory_balances
    set on_hand_quantity = p_counted_quantity,
        version = public.inventory_balances.version + 1,
        updated_at = pg_catalog.now()
    where tenant_id = p_tenant_id
      and variant_id = p_variant_id
      and inventory_location_id = p_inventory_location_id;

  v_current := p_counted_quantity;
  v_version := v_version + 1;

  insert into public.inventory_movements (
    tenant_id, operation_id, variant_id, inventory_location_id, quantity_delta, line_number
  )
  values (
    p_tenant_id, v_operation_id, p_variant_id, p_inventory_location_id, v_delta, 1
  );

  perform pg_catalog.set_config('inventory_private.allow_balance_write', 'off', true);

  return query select v_operation_id, v_previous, v_current, v_version, true;
end;
$function$;

comment on function inventory_private.record_count_adjustment(uuid, uuid, uuid, bigint, bigint, uuid, text, timestamptz, text) is
  'Reconciles a stock key to an absolute counted quantity with optimistic version concurrency (IN002 on a stale version). A count equal to current on-hand is a durable no-op: it persists one InventoryOperation (the audit/idempotency envelope) with NO movement and an unchanged balance/version, so its key is consumed exactly like a changed count. Idempotency identity is the caller inputs, not the derived delta.';

-- Transfer ownership of the two new functions to inventory_writer so they write as the same dedicated
-- role that owns the tables, while service_role (their only caller) holds no direct table DML.
-- ALTER FUNCTION ... OWNER TO requires the new owner to hold CREATE on the schema; grant it only for
-- the duration of the transfer and revoke immediately after, exactly as the Phase 2B migration does,
-- so inventory_writer keeps no standing CREATE and the privilege boundary is unchanged.
grant create on schema inventory_private to inventory_writer;
alter function inventory_private.record_opening(uuid, uuid, uuid, bigint, uuid, text, timestamptz, text)
  owner to inventory_writer;
alter function inventory_private.record_count_adjustment(uuid, uuid, uuid, bigint, bigint, uuid, text, timestamptz, text)
  owner to inventory_writer;
revoke create on schema inventory_private from inventory_writer;

-- Deny PUBLIC (and therefore anon/authenticated) execute on the new functions. The service-role grant
-- is established in the companion Phase 2C grants migration.
revoke all on function inventory_private.record_opening(uuid, uuid, uuid, bigint, uuid, text, timestamptz, text) from public;
revoke all on function inventory_private.record_count_adjustment(uuid, uuid, uuid, bigint, bigint, uuid, text, timestamptz, text) from public;
