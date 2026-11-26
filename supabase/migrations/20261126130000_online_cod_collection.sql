-- Online orders: record that a cash-on-delivery order was delivered and its cash collected.
--
-- Until now an online order's cash_on_delivery Payment stayed `pending` forever: nothing marked the
-- courier's cash as received. So the shopper's tracking never reached "Delivered", staff could not
-- refund a returned online order (returns require a captured payment: PAYMENT_NOT_CAPTURED), and no
-- record said who took the money.
--
-- orders_private.collect_cash_on_delivery(tenant, order, actor) is that step. Under the shared
-- order-execution lock (serialized with fulfilment, cancellation and returns) it requires an ONLINE,
-- placed order whose every line is fully shipped and whose payment is cash on delivery, then moves the
-- payment pending|authorized -> captured, stamping captured_at and the collecting staff membership.
-- Collecting again is an idempotent replay ('already_collected'). The amount is the payment's own
-- amount, fixed at checkout to the order total (delivery fee included); nothing about money is
-- client-supplied. Authorization (orders.fulfill on the order brand) happens in the API before this.
--
-- The payment row update runs inside payments_private.capture_cod_payment, owned by payments_writer,
-- because the payments mutation guard only admits sanctioned transitions made as payments_writer.

-- SQLSTATEs (mapped to stable API codes by the orders repository):
--   CD404 order not found · CD409 order cancelled · CD422 not an online cash-on-delivery order
--   CD423 not every item has shipped yet

grant create on schema payments_private to payments_writer;

create function payments_private.capture_cod_payment(p_tenant uuid, p_order uuid, p_actor uuid)
returns text
language plpgsql security definer set search_path = '' as $function$
declare v public.payments;
begin
  select * into v from public.payments
  where tenant_id = p_tenant and order_id = p_order and method = 'cash_on_delivery'
  for update;
  if not found then
    raise exception using errcode = 'CD422', message = 'order has no cash-on-delivery payment';
  end if;
  if v.status = 'captured' then
    return 'already_collected';
  end if;
  if v.status not in ('pending', 'authorized') then
    raise exception using errcode = 'CD422', message = 'payment cannot be collected';
  end if;
  perform pg_catalog.set_config('payments_private.allow_transition', 'on', true);
  update public.payments
    set status = 'captured',
        captured_at = pg_catalog.now(),
        captured_by_membership_id = p_actor,
        updated_at = pg_catalog.now()
    where tenant_id = p_tenant and id = v.id;
  perform pg_catalog.set_config('payments_private.allow_transition', 'off', true);
  return 'collected';
end;
$function$;

alter function payments_private.capture_cod_payment(uuid, uuid, uuid) owner to payments_writer;
revoke create on schema payments_private from payments_writer;
revoke all on function payments_private.capture_cod_payment(uuid, uuid, uuid) from public;

create function orders_private.collect_cash_on_delivery(
  p_tenant_id uuid,
  p_order_id uuid,
  p_collected_by_membership_id uuid
)
returns text
language plpgsql security definer set search_path = '' as $function$
declare
  o public.orders;
  v_unshipped boolean;
begin
  if p_tenant_id is null or p_order_id is null or p_collected_by_membership_id is null then
    raise exception using errcode = '22004', message = 'tenant, order and collector are required';
  end if;

  perform commerce_locks.acquire_order_execution_lock(p_tenant_id, p_order_id);

  select * into o from public.orders where tenant_id = p_tenant_id and id = p_order_id;
  if not found then
    raise exception using errcode = 'CD404', message = 'order not found';
  end if;
  if o.channel <> 'online' then
    raise exception using errcode = 'CD422', message = 'only online orders are collected on delivery';
  end if;
  if o.status = 'cancelled' then
    raise exception using errcode = 'CD409', message = 'order is cancelled';
  end if;

  select exists (
    select 1 from public.order_lines l
    where l.tenant_id = p_tenant_id and l.order_id = p_order_id
      and l.quantity > coalesce((
        select sum(fl.quantity) from public.fulfillment_lines fl
        where fl.tenant_id = p_tenant_id and fl.order_line_id = l.id), 0)
  ) into v_unshipped;
  if v_unshipped then
    raise exception using errcode = 'CD423', message = 'not every item has shipped yet';
  end if;

  return payments_private.capture_cod_payment(p_tenant_id, p_order_id, p_collected_by_membership_id);
end;
$function$;

comment on function orders_private.collect_cash_on_delivery(uuid, uuid, uuid) is
  'Delivered + cash collected for a fully shipped ONLINE cash-on-delivery order: captures its payment (who/when), serialized under the order-execution lock. Idempotent (already_collected).';

revoke all on function orders_private.collect_cash_on_delivery(uuid, uuid, uuid) from public;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function orders_private.collect_cash_on_delivery(uuid, uuid, uuid) from anon';
    execute 'revoke all on function payments_private.capture_cod_payment(uuid, uuid, uuid) from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function orders_private.collect_cash_on_delivery(uuid, uuid, uuid) from authenticated';
    execute 'revoke all on function payments_private.capture_cod_payment(uuid, uuid, uuid) from authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function orders_private.collect_cash_on_delivery(uuid, uuid, uuid) to service_role';
  end if;
end;
$block$;
