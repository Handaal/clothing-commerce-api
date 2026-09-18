-- Only service_role can invoke placement. All internal helpers have a fixed search path and narrow grants.
create function online_private.resolve_context(p_tenant uuid,p_brand uuid)
returns public.storefront_checkout_settings language plpgsql security definer set search_path = '' as $function$
declare c public.storefront_checkout_settings;
begin
  select s.* into c from public.storefront_checkout_settings s
    join public.tenants t on t.id=s.tenant_id and t.status='active'
    join public.brands b on b.tenant_id=s.tenant_id and b.id=s.brand_id and b.status='active'
    join public.inventory_locations l on l.tenant_id=s.tenant_id and l.id=s.inventory_location_id
      and l.status='active' and l.is_sellable and l.is_fulfillment_enabled
    where s.tenant_id=p_tenant and s.brand_id=p_brand and s.cod_enabled
    for share of s,t,b,l;
  if not found then raise exception using errcode='OC001',message='checkout unavailable'; end if;
  return c;
end;
$function$;

create function online_private.resolve_line(p_tenant uuid,p_brand uuid,p_variant uuid,p_currency text,p_quantity bigint)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r record;
begin
  select v.id,v.product_id,v.sku,v.display_name,v.option_signature,p.name,pr.amount_minor into r
    from public.product_variants v
    join public.products p on p.tenant_id=v.tenant_id and p.id=v.product_id
    join public.variant_prices pr on pr.tenant_id=v.tenant_id and pr.variant_id=v.id
    where v.tenant_id=p_tenant and v.id=p_variant and p.brand_id=p_brand
      and v.status='active' and p.status='active' and p.storefront_status='published'
      and pr.status='active' and pr.currency=p_currency
    for share of p,v,pr;
  if not found then raise exception using errcode='OC002',message='variant not sellable'; end if;
  return jsonb_build_object('variant_id',r.id,'product_id',r.product_id,'sku',r.sku,
    'variant_name',r.display_name,'option_summary',r.option_signature,'product_name',r.name,
    'unit_price_minor',r.amount_minor,'quantity',p_quantity);
end;
$function$;
revoke all on function online_private.resolve_context(uuid,uuid), online_private.resolve_line(uuid,uuid,uuid,text,bigint) from public;
grant execute on function online_private.resolve_context(uuid,uuid), online_private.resolve_line(uuid,uuid,uuid,text,bigint) to online_writer;

create function online_private.place_checkout(p_key text,p_intent jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  t uuid := (p_intent->>'tenantId')::uuid;
  b uuid := (p_intent->>'brandId')::uuid;
  k text := lower(btrim(p_key));
  c public.storefront_checkout_settings;
  previous public.checkout_operations;
  line jsonb;
  resolved jsonb := '[]';
  total numeric := 0;
  physical bigint;
  committed bigint;
  customer uuid;
  v_order_id uuid;
  result jsonb;
begin
  if t is null or b is null or k is null or length(k) not between 1 and 200
    or jsonb_typeof(p_intent->'lines') is distinct from 'array'
    or jsonb_array_length(p_intent->'lines') not between 1 and 100
    or p_intent->>'paymentMethod' is distinct from 'cash_on_delivery'
    or jsonb_typeof(p_intent->'customer') is distinct from 'object'
    or jsonb_typeof(p_intent->'delivery') is distinct from 'object'
    or p_intent->>'expectedTotalMinor' is null or p_intent->>'expectedCurrency' is null then
    raise exception using errcode='22023',message='invalid checkout';
  end if;
  -- Compare the complete canonical JSON intent, not a lossy hash. Names/addresses are retry intent too.
  perform pg_advisory_xact_lock(hashtextextended('checkout:'||t::text||':'||k,0));
  select * into previous from public.checkout_operations where tenant_id=t and normalized_key=k;
  if found then
    if previous.intent is distinct from p_intent then raise exception using errcode='ID409',message='checkout intent conflict'; end if;
    return previous.result;
  end if;
  c := online_private.resolve_context(t,b);
  if c.currency is distinct from p_intent->>'expectedCurrency' then raise exception using errcode='OC004',message='currency changed'; end if;
  if (select count(*) <> count(distinct value->>'variantId') from jsonb_array_elements(p_intent->'lines')) then
    raise exception using errcode='22023',message='duplicate variant';
  end if;
  -- Resolve published prices and immutable snapshots before any business mutation.
  for line in select value from jsonb_array_elements(p_intent->'lines') order by value->>'variantId' loop
    if (line->>'quantity')::numeric not between 1 and 10000 or (line->>'quantity')::numeric <> trunc((line->>'quantity')::numeric) then
      raise exception using errcode='22023',message='invalid quantity';
    end if;
    line := online_private.resolve_line(t,b,(line->>'variantId')::uuid,c.currency,(line->>'quantity')::bigint);
    resolved := resolved || jsonb_build_array(line);
    total := total + (line->>'unit_price_minor')::numeric * (line->>'quantity')::numeric;
  end loop;
  if total > 9007199254740991 then raise exception using errcode='22023',message='total outside transport range'; end if;
  if total <> (p_intent->>'expectedTotalMinor')::numeric then
    raise exception using errcode='OC003',message='price changed',detail=total::text;
  end if;
  -- Allocate the canonical order before taking stock locks, matching POS's order-number -> stock
  -- lock order. Insufficient ATS rolls this whole transaction back, including the number and customer.
  -- Guest identity is unverified: never merge by name, email or phone. Exact checkout replay is reuse.
  insert into public.customers(tenant_id,name,email,phone)
    values(t,p_intent->'customer'->>'name',p_intent->'customer'->>'email',p_intent->'customer'->>'phone') returning id into customer;
  insert into public.customer_addresses(tenant_id,customer_id,address) values(t,customer,p_intent->'delivery');
  v_order_id := orders_private.create_order(t,'online',c.currency,b,null,null,null,
    'checkout:'||gen_random_uuid()::text,null,null,resolved);
  perform orders_private.attach_checkout_customer(t,v_order_id,customer,p_intent->'customer',p_intent->'delivery');
  perform commerce_locks.acquire_inventory_location_lifecycle_lock(t,c.inventory_location_id);
  -- Same canonical stock-key order as the physical ledger. A missing balance is zero, never sellable.
  for line in select value from jsonb_array_elements(resolved) order by value->>'variant_id' loop
    physical := inventory_private.lock_checkout_balance(t,(line->>'variant_id')::uuid,c.inventory_location_id);
    select coalesce(sum(quantity-consumed_quantity),0) into committed from public.stock_reservations
      where tenant_id=t and variant_id=(line->>'variant_id')::uuid and inventory_location_id=c.inventory_location_id and status='active';
    if physical-committed < (line->>'quantity')::bigint then
      raise exception using errcode='23514',message='insufficient available stock';
    end if;
  end loop;
  insert into public.stock_reservations(tenant_id,order_id,order_line_id,variant_id,inventory_location_id,quantity)
    select t,v_order_id,l.id,l.variant_id,c.inventory_location_id,l.quantity from public.order_lines l where l.tenant_id=t and l.order_id=v_order_id;
  perform payments_private.create_cod_payment(t,v_order_id);
  select jsonb_build_object('orderReference',o.order_number,'channel','online','status','placed','totalMinor',o.total_minor,'currency',o.currency,
    'payment',jsonb_build_object('method','cash_on_delivery','provider',null,'status','pending','amountMinor',o.total_minor,'currency',o.currency),
    'fulfillmentStatus','unfulfilled') into result from public.orders o where o.tenant_id=t and o.id=v_order_id;
  insert into public.checkout_operations(tenant_id,normalized_key,intent,order_id,result) values(t,k,p_intent,v_order_id,result);
  return result;
end;
$function$;

-- Physical stock can never be reduced below outstanding commitments by POS, transfer, issue or count.
-- This runs while the existing inventory writer holds the balance row lock.
create function online_private.protect_committed_stock()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare committed bigint;
begin
  select coalesce(sum(quantity-consumed_quantity),0) into committed from public.stock_reservations
    where tenant_id=new.tenant_id and variant_id=new.variant_id and inventory_location_id=new.inventory_location_id and status='active';
  if new.on_hand_quantity < committed then raise exception using errcode='23514',message='stock is committed to online orders'; end if;
  return new;
end;
$function$;
create trigger inventory_committed_stock before update on public.inventory_balances for each row execute function online_private.protect_committed_stock();

-- Called inside the existing fulfillment savepoint, before its canonical inventory issue.
-- Order execution lock is already held. Lock all balances first, matching the ledger's order.
create function online_private.consume_reservations(p_tenant uuid,p_order uuid,p_location uuid,p_lines jsonb)
returns void language plpgsql security definer set search_path = '' as $function$
declare line record; r public.stock_reservations;
begin
  if not exists(select 1 from public.orders where tenant_id=p_tenant and id=p_order and customer_id is not null) then return; end if;
  perform commerce_locks.acquire_inventory_location_lifecycle_lock(p_tenant,p_location);
  for line in select l.variant_id from public.order_lines l join jsonb_array_elements(p_lines) j on l.id=(j->>'order_line_id')::uuid
    where l.tenant_id=p_tenant and l.order_id=p_order order by l.variant_id loop
    perform inventory_private.lock_checkout_balance(p_tenant,line.variant_id,p_location);
  end loop;
  for line in select (j->>'order_line_id')::uuid id,(j->>'quantity')::bigint quantity from jsonb_array_elements(p_lines) j loop
    select * into r from public.stock_reservations where tenant_id=p_tenant and order_id=p_order and order_line_id=line.id for update;
    if not found or r.status <> 'active' or r.inventory_location_id <> p_location
      or (r.expires_at is not null and r.expires_at <= now()) or r.quantity-r.consumed_quantity < line.quantity then
      raise exception using errcode='23514',message='reservation unavailable at requested location';
    end if;
    update public.stock_reservations set consumed_quantity=consumed_quantity+line.quantity,
      status=case when consumed_quantity+line.quantity=quantity then 'consumed' else 'active' end,updated_at=now()
      where id=r.id;
  end loop;
end;
$function$;

-- Existing cancel_order owns the order lock and rejects any fulfilled order. Hook all cancellation paths.
create function online_private.release_cancelled_order()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.status='cancelled' and old.status='placed' and new.customer_id is not null then
    update public.stock_reservations set status='released',updated_at=now() where tenant_id=new.tenant_id and order_id=new.id and status='active';
    perform payments_private.transition_payment(new.tenant_id,new.id,'cancelled');
  end if;
  return new;
end;
$function$;
create trigger online_order_cancelled after update on public.orders for each row execute function online_private.release_cancelled_order();

-- Expiry is explicit: until this transaction commits, even overdue active holds count against ATS.
-- COD holds have no expiry; future payment attempts may opt into an expiry via a staged placement path.
create function online_private.expire_reservations(p_tenant uuid,p_order uuid)
returns boolean language plpgsql security definer set search_path = '' as $function$
begin
  perform commerce_locks.acquire_order_execution_lock(p_tenant,p_order);
  if not exists(select 1 from public.stock_reservations where tenant_id=p_tenant and order_id=p_order and status='active' and expires_at<=now()) then return false; end if;
  perform orders_private.cancel_order(p_tenant,p_order,null,'Stock reservation expired');
  update public.stock_reservations set status='expired',updated_at=now() where tenant_id=p_tenant and order_id=p_order and status='released';
  return true;
end;
$function$;

grant create on schema online_private to online_writer;
alter function online_private.place_checkout(text,jsonb) owner to online_writer;
alter function online_private.protect_committed_stock() owner to online_writer;
alter function online_private.consume_reservations(uuid,uuid,uuid,jsonb) owner to online_writer;
alter function online_private.release_cancelled_order() owner to online_writer;
alter function online_private.expire_reservations(uuid,uuid) owner to online_writer;
revoke create on schema online_private from online_writer;
revoke all on all functions in schema online_private from public;
grant usage on schema online_private to fulfillments_writer;
grant execute on function online_private.consume_reservations(uuid,uuid,uuid,jsonb) to fulfillments_writer;
do $block$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on schema online_private from anon;
    revoke all on all functions in schema online_private from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on schema online_private from authenticated;
    revoke all on all functions in schema online_private from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on all functions in schema online_private from service_role;
    grant usage on schema online_private to service_role;
    grant execute on function online_private.place_checkout(text,jsonb), online_private.expire_reservations(uuid,uuid) to service_role;
  end if;
end;
$block$;
