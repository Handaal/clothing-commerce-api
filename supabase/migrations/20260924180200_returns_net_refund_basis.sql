-- Phase 2P-A (3/3): make Returns financially correct for discounted Orders WITHOUT redesigning Returns.
--
-- The ONLY authoritative change: the refundable basis per OrderLine becomes the NET line amount
-- (gross line_total minus the immutable allocated discount from order_line_adjustments), distributed
-- across units by the same largest-remainder rule used at sale time:
--
--   net_line_minor = line_total_minor - allocated_discount_minor
--   base_net_unit  = floor(net_line_minor / quantity)
--   remainder      = net_line_minor % quantity
--   the first `remainder` units (stable order) refund base+1; the rest refund base.
--
-- Cumulative refund of units (already_returned .. already_returned+n) is:
--   base*n + ( least(already+n, remainder) - least(already, remainder) )
--
-- For undiscounted orders allocated=0 → net=gross → base=unit_price, remainder=0 → base*n =
-- unit_price*n: byte-identical to prior behavior. Refund never reads the mutable live Promotion.

grant select on public.order_line_adjustments to returns_writer;
create policy returns_writer_line_adjustment_read on public.order_line_adjustments
  for select to returns_writer using (true);

create or replace function returns_private.accept_return(
  p_tenant uuid, p_order uuid, p_actor uuid, p_source text, p_key text, p_intent jsonb
) returns jsonb
language plpgsql security definer set search_path='' as $f$
declare o public.orders; p public.payments; s public.return_settings; old public.returns;
 l public.order_lines; item jsonb; amount bigint:=0; qty bigint; fulfilled bigint; returned bigint;
 rid uuid:=gen_random_uuid(); loc uuid; operation uuid; moves jsonb:='[]'; eligibility jsonb;
 mode text:=p_intent->>'refundMode'; reference text:=p_intent->>'settlementReference';
 alloc bigint; net_line bigint; base_unit bigint; rem bigint; line_refund bigint;
begin
 if p_actor is null or p_key is null or length(btrim(p_key)) not between 1 and 200 or p_source not in ('admin-mobile','pos','management')
 or jsonb_typeof(p_intent->'lines') is distinct from 'array' or jsonb_array_length(p_intent->'lines') not between 1 and 100
 or mode is null or mode not in ('pending','manual_confirmed') then raise exception using errcode='RT400',message='invalid return'; end if;
 perform pg_advisory_xact_lock(hashtextextended('return_key:'||p_tenant::text||':'||lower(btrim(p_key)),0));
 select * into old from public.returns where tenant_id=p_tenant and normalized_key=lower(btrim(p_key));
 if found then
  if old.order_id<>p_order or old.intent is distinct from p_intent then raise exception using errcode='ID409',message='changed return intent'; end if;
  return returns_private.return_detail(p_tenant,old.id);
 end if;
 perform commerce_locks.acquire_order_execution_lock(p_tenant,p_order);
 select * into o from public.orders where tenant_id=p_tenant and id=p_order;
 if not found then raise exception using errcode='RT404',message='order not found'; end if;
 select * into s from public.return_settings where tenant_id=p_tenant;
 eligibility:=returns_private.return_eligibility(p_tenant,p_order);
 if eligibility->>'reason' is not null then raise exception using errcode='RT422',message=eligibility->>'reason'; end if;
 select * into p from public.payments where tenant_id=p_tenant and order_id=p_order;
 if p.currency<>o.currency then raise exception using errcode='RT409',message='payment currency mismatch'; end if;
 if (select count(distinct x->>'orderLineId') from jsonb_array_elements(p_intent->'lines') x)<>jsonb_array_length(p_intent->'lines') then raise exception using errcode='RT400',message='duplicate lines'; end if;
 loc:=(p_intent->>'inventoryLocationId')::uuid;
 if exists(select 1 from jsonb_array_elements(p_intent->'lines') x where x->>'disposition'='restock') then
  if loc is null then raise exception using errcode='RT400',message='restock location required'; end if;
  perform commerce_locks.acquire_inventory_location_lifecycle_lock(p_tenant,loc);
  if not exists(select 1 from public.inventory_locations where tenant_id=p_tenant and id=loc and status='active' and is_sellable) then raise exception using errcode='RTLOC',message='restock location unavailable'; end if;
 elsif loc is not null then raise exception using errcode='RT400',message='non-restock has no stock location'; end if;
 for item in select value from jsonb_array_elements(p_intent->'lines') loop
  if item->>'quantity' is null or (item->>'quantity') !~ '^[1-9][0-9]*$' or item->>'reason' is null or length(btrim(item->>'reason')) not between 1 and 500 or item->>'disposition' is null or item->>'disposition' not in ('restock','non_restock') then raise exception using errcode='RT400',message='invalid line'; end if;
  qty:=(item->>'quantity')::bigint;
  select * into l from public.order_lines where tenant_id=p_tenant and order_id=p_order and id=(item->>'orderLineId')::uuid;
  if not found then raise exception using errcode='RTLIN',message='line does not belong to order'; end if;
  if s.allowed_reasons is not null and not (item->>'reason'=any(s.allowed_reasons)) then raise exception using errcode='RT422',message='RETURN_REASON_NOT_ALLOWED'; end if;
  select coalesce(sum(quantity),0) into fulfilled from public.fulfillment_lines where tenant_id=p_tenant and order_line_id=l.id;
  select coalesce(sum(quantity),0) into returned from public.return_lines where tenant_id=p_tenant and order_line_id=l.id;
  if qty>least(l.quantity,fulfilled)-returned then raise exception using errcode='RTQTY',message='return quantity exceeds eligibility'; end if;
  -- NET refundable basis: gross line minus immutable allocated discount, spread by largest remainder.
  select coalesce(sum(discount_minor),0) into alloc from public.order_line_adjustments where tenant_id=p_tenant and order_line_id=l.id;
  net_line:=l.line_total_minor-alloc;
  base_unit:=net_line/l.quantity; rem:=net_line%l.quantity;
  line_refund:=base_unit*qty+(least(returned+qty,rem)-least(returned,rem));
  amount:=amount+line_refund;
  if item->>'disposition'='restock' then moves:=moves||jsonb_build_array(jsonb_build_object('variant_id',l.variant_id,'inventory_location_id',loc,'quantity_delta',qty)); end if;
 end loop;
 if amount>(eligibility->>'maxRefundableMinor')::bigint then raise exception using errcode='RT409',message='refund ceiling exceeded'; end if;
 if mode='manual_confirmed' then
  if p.method='electronic' or not s.manual_refunds_enabled or (s.max_manual_refund_minor is not null and amount>s.max_manual_refund_minor) then raise exception using errcode='RT422',message='MANUAL_REFUND_NOT_ALLOWED'; end if;
  if reference is null or length(btrim(reference)) not between 1 and 200 then raise exception using errcode='RT400',message='settlement attestation required'; end if;
 elsif reference is not null then raise exception using errcode='RT400',message='pending is not settlement'; end if;
 if jsonb_array_length(moves)>0 then
  select jsonb_agg(x order by x->>'variant_id') into moves from jsonb_array_elements(moves) x;
  operation:=inventory_private.record_operation(p_tenant,'receipt',moves,p_actor,'return:'||rid::text,null,'Accepted merchandise return');
 end if;
 insert into public.returns(id,tenant_id,order_id,channel,source,actor_membership_id,currency,amount_minor,inventory_location_id,inventory_operation_id,normalized_key,intent,policy_snapshot)
 values(rid,p_tenant,p_order,o.channel,p_source,p_actor,o.currency,amount,loc,operation,lower(btrim(p_key)),p_intent,to_jsonb(s));
 for item in select value from jsonb_array_elements(p_intent->'lines') loop
  select * into l from public.order_lines where tenant_id=p_tenant and order_id=p_order and id=(item->>'orderLineId')::uuid;
  qty:=(item->>'quantity')::bigint;
  select coalesce(sum(quantity),0) into returned from public.return_lines where tenant_id=p_tenant and order_line_id=l.id;
  select coalesce(sum(discount_minor),0) into alloc from public.order_line_adjustments where tenant_id=p_tenant and order_line_id=l.id;
  net_line:=l.line_total_minor-alloc;
  base_unit:=net_line/l.quantity; rem:=net_line%l.quantity;
  line_refund:=base_unit*qty+(least(returned+qty,rem)-least(returned,rem));
  insert into public.return_lines(tenant_id,return_id,order_id,order_line_id,variant_id,quantity,reason,disposition,amount_minor)
  values(p_tenant,rid,p_order,l.id,l.variant_id,qty,item->>'reason',item->>'disposition',line_refund);
 end loop;
 insert into public.refunds(tenant_id,order_id,return_id,payment_id,method,status,amount_minor,currency,settlement_reference,settled_by_membership_id,settled_at)
 values(p_tenant,p_order,rid,p.id,p.method,case when mode='manual_confirmed' then 'succeeded' else 'pending' end,amount,o.currency,reference,case when mode='manual_confirmed' then p_actor end,case when mode='manual_confirmed' then now() end);
 return returns_private.return_detail(p_tenant,rid);
end $f$;
