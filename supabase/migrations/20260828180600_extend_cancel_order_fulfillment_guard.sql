-- Phase 2E (7/7): extend the Phase 2D orders_private.cancel_order NARROWLY so cancellation is
-- serialized with Fulfillment creation and is refused once any Fulfillment exists.
--
-- This is a fix-forward CREATE OR REPLACE of the existing function; the merged Phase 2D migration is
-- never rewritten. Two changes, nothing else:
--   1. Acquire the SHARED order-execution advisory lock (the same key construction record_fulfillment
--      uses) at the very start, so cancel-vs-fulfill can never interleave.
--   2. Under that lock, if ANY Fulfillment exists for the Order, reject with ORDER_ALREADY_FULFILLED
--      (FF030) BEFORE the placed->cancelled transition.
-- Everything else is preserved exactly: the guarded-UPDATE allow flag, the write-once cancellation
-- semantics, and the already-cancelled replay that returns the ORIGINAL actor/time/reason unchanged.
--
-- Custom SQLSTATE (internal-only, mapped by the orders repository):
--   FF030 = order has one or more Fulfillments and cannot be cancelled
--
-- The function is owned by orders_writer; replace it AS that role (the Phase 2D migration granted the
-- migration role SET ROLE on it) so ownership is preserved. CREATE OR REPLACE requires CREATE on the
-- schema, so grant it only for the duration of the replace and revoke immediately after, exactly as the
-- Phase 2D migrations do for ownership transfers. orders_writer already holds USAGE/EXECUTE on the
-- shared lock helper (migration 3) and SELECT + a read policy on public.fulfillments (migration 6).
grant create on schema orders_private to orders_writer;
set role orders_writer;

create or replace function orders_private.cancel_order(
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

  -- Shared order-execution lock (same key as record_fulfillment). This serializes cancellation with
  -- Fulfillment creation for the Order: either the Fulfillment commits first and this cancel then sees
  -- it and fails, or this cancel commits first and a concurrent Fulfillment then sees the cancelled
  -- Order and fails. The "cancelled Order + Fulfillment" state is therefore impossible.
  perform commerce_locks.acquire_order_execution_lock(p_tenant_id, p_order_id);

  -- Under the lock: an Order with ANY Fulfillment can never be cancelled. A cancelled Order has no
  -- Fulfillment (they are mutually exclusive), so this never blocks an already-cancelled replay.
  if exists (
    select 1 from public.fulfillments as f
    where f.tenant_id = p_tenant_id and f.order_id = p_order_id
  ) then
    raise exception using
      errcode = 'FF030',
      message = 'order has one or more fulfillments and cannot be cancelled';
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

reset role;
revoke create on schema orders_private from orders_writer;

comment on function orders_private.cancel_order(uuid, uuid, uuid, text) is
  'Atomic write-once placed->cancelled transition, serialized with Fulfillment creation via the shared order-execution advisory lock and refused once any Fulfillment exists (ORDER_ALREADY_FULFILLED). Re-cancelling returns the preserved original metadata. No payment/inventory side effects.';
