-- Phase 2P-A (4): wire the promotion engine into the two connected placement paths (Storefront online
-- checkout and connected POS sale). Both consume the SAME promotions_private.redeem inside their
-- existing atomic, idempotent transaction: create Order (gross) -> redeem (applies net) -> validate the
-- client's expected NET total -> continue reservations/payment. Offline POS is untouched.
--
-- Backward compatibility: the promotion code is read from the existing intent payload (checkout) or a
-- new trailing parameter (POS); when absent, behavior and fingerprints are byte-identical to before.

-- ============================ Storefront online checkout ============================
create or replace function online_private.place_checkout(p_key text, p_intent jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  t uuid := (p_intent->>'tenantId')::uuid;
  b uuid := (p_intent->>'brandId')::uuid;
  k text := lower(btrim(p_key));
  promo_code text := nullif(btrim(p_intent->>'promotionCode'), '');
  c public.storefront_checkout_settings;
  previous public.checkout_operations;
  line jsonb;
  resolved jsonb := '[]';
  total numeric := 0;
  physical bigint;
  committed bigint;
  customer uuid;
  v_order_id uuid;
  v_promo jsonb;
  v_net bigint;
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
  for line in select value from jsonb_array_elements(p_intent->'lines') order by value->>'variantId' loop
    if (line->>'quantity')::numeric not between 1 and 10000 or (line->>'quantity')::numeric <> trunc((line->>'quantity')::numeric) then
      raise exception using errcode='22023',message='invalid quantity';
    end if;
    line := online_private.resolve_line(t,b,(line->>'variantId')::uuid,c.currency,(line->>'quantity')::bigint);
    resolved := resolved || jsonb_build_array(line);
    total := total + (line->>'unit_price_minor')::numeric * (line->>'quantity')::numeric;
  end loop;
  if total > 9007199254740991 then raise exception using errcode='22023',message='total outside transport range'; end if;
  -- Order is created at gross; the sanctioned redeem applies the single best-eligible promotion and moves
  -- the net total. The client's expected NET is validated AFTER redemption, so a stale expected total
  -- (price OR promotion changed) deterministically re-quotes via OC003.
  insert into public.customers(tenant_id,name,email,phone)
    values(t,p_intent->'customer'->>'name',p_intent->'customer'->>'email',p_intent->'customer'->>'phone') returning id into customer;
  insert into public.customer_addresses(tenant_id,customer_id,address) values(t,customer,p_intent->'delivery');
  v_order_id := orders_private.create_order(t,'online',c.currency,b,null,null,null,
    'checkout:'||gen_random_uuid()::text,null,null,resolved);
  perform orders_private.attach_checkout_customer(t,v_order_id,customer,p_intent->'customer',p_intent->'delivery');
  v_promo := promotions_private.redeem(t, v_order_id, promo_code);
  if promo_code is not null and (v_promo->>'applied')::boolean is distinct from true then
    raise exception using errcode='OC005',message='promotion not applicable';
  end if;
  select total_minor into v_net from public.orders where tenant_id=t and id=v_order_id;
  if v_net <> (p_intent->>'expectedTotalMinor')::numeric then
    raise exception using errcode='OC003',message='price changed',detail=v_net::text;
  end if;
  perform commerce_locks.acquire_inventory_location_lifecycle_lock(t,c.inventory_location_id);
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
    'grossSubtotalMinor',o.gross_subtotal_minor,'discountTotalMinor',o.discount_total_minor,
    'promotion',case when (v_promo->>'applied')::boolean then jsonb_build_object(
      'promotionId',v_promo->>'promotionId','name',v_promo->>'promotionName','benefitType',v_promo->>'benefitType',
      'activation',case when nullif(v_promo->>'codeId','') is not null then 'code' else 'automatic' end,
      'code',v_promo->>'codeSnapshot','discountTotalMinor',(v_promo->>'discountTotalMinor')::bigint) else null end,
    'payment',jsonb_build_object('method','cash_on_delivery','provider',null,'status','pending','amountMinor',o.total_minor,'currency',o.currency),
    'fulfillmentStatus','unfulfilled') into result from public.orders o where o.tenant_id=t and o.id=v_order_id;
  insert into public.checkout_operations(tenant_id,normalized_key,intent,order_id,result) values(t,k,p_intent,v_order_id,result);
  return result;
end;
$function$;
grant usage on schema promotions_private to online_writer;

-- A non-consuming Storefront/POS pricing quote over the SAME engine. Never mutates.
create function online_private.quote_checkout(p_intent jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  t uuid := (p_intent->>'tenantId')::uuid;
  b uuid := (p_intent->>'brandId')::uuid;
  promo_code text := nullif(btrim(p_intent->>'promotionCode'), '');
  c public.storefront_checkout_settings;
  line jsonb; resolved jsonb := '[]'; ord int := 0; gross numeric := 0; v_eval jsonb;
begin
  if t is null or b is null or jsonb_typeof(p_intent->'lines') is distinct from 'array'
    or jsonb_array_length(p_intent->'lines') not between 1 and 100 then
    raise exception using errcode='22023',message='invalid quote';
  end if;
  c := online_private.resolve_context(t,b);
  if (select count(*) <> count(distinct value->>'variantId') from jsonb_array_elements(p_intent->'lines')) then
    raise exception using errcode='22023',message='duplicate variant';
  end if;
  for line in select value from jsonb_array_elements(p_intent->'lines') order by value->>'variantId' loop
    if (line->>'quantity')::numeric not between 1 and 10000 or (line->>'quantity')::numeric <> trunc((line->>'quantity')::numeric) then
      raise exception using errcode='22023',message='invalid quantity';
    end if;
    ord := ord + 1;
    line := online_private.resolve_line(t,b,(line->>'variantId')::uuid,c.currency,(line->>'quantity')::bigint);
    resolved := resolved || jsonb_build_array(jsonb_build_object('ord',ord,'variantId',line->>'variant_id',
      'productId',line->>'product_id','quantity',(line->>'quantity')::bigint,
      'lineTotalMinor',(line->>'unit_price_minor')::bigint*(line->>'quantity')::bigint));
    gross := gross + (line->>'unit_price_minor')::numeric * (line->>'quantity')::numeric;
  end loop;
  v_eval := promotions_private.evaluate(t,'online',c.currency,b,null,resolved,promo_code);
  return jsonb_build_object('currency',c.currency,'grossSubtotalMinor',gross::bigint,
    'discountTotalMinor',coalesce((v_eval->>'discountTotalMinor')::bigint,0),
    'totalMinor',gross::bigint-coalesce((v_eval->>'discountTotalMinor')::bigint,0),
    'codeStatus',v_eval->>'codeStatus',
    'promotion',case when (v_eval->>'applied')::boolean then jsonb_build_object(
      'promotionId',v_eval->>'promotionId','name',v_eval->>'promotionName','benefitType',v_eval->>'benefitType',
      'activation',case when nullif(v_eval->>'codeId','') is not null then 'code' else 'automatic' end,
      'code',v_eval->>'codeSnapshot','discountTotalMinor',(v_eval->>'discountTotalMinor')::bigint) else null end);
end;
$function$;
grant create on schema online_private to online_writer;
alter function online_private.place_checkout(text,jsonb) owner to online_writer;
alter function online_private.quote_checkout(jsonb) owner to online_writer;
revoke create on schema online_private from online_writer;
revoke all on function online_private.quote_checkout(jsonb) from public;
do $b$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function online_private.quote_checkout(jsonb) to service_role;
  end if;
end $b$;

-- ============================ Connected POS sale ============================
-- Promotion-aware fingerprint: the code is appended ONLY when present, so pre-promotion sales replay
-- byte-identically.
create or replace function pos_sales_private.sale_intent_fingerprint(
  p_tenant_id uuid, p_register_id uuid, p_expected_total_minor bigint,
  p_cash_received_minor bigint, p_lines jsonb, p_promotion_code text default null
) returns text language sql immutable security invoker set search_path = '' as $function$
  select pg_catalog.md5(
    p_tenant_id::text || E'\n' || coalesce(p_register_id::text, '') || E'\n'
    || coalesce(p_expected_total_minor::text, '') || E'\n'
    || coalesce(p_cash_received_minor::text, '')
    || coalesce((
      select pg_catalog.string_agg(
        E'\n' || (line.value ->> 'variant_id') || ',' || (line.value ->> 'quantity'),
        '' order by line.ord
      )
      from pg_catalog.jsonb_array_elements(p_lines) with ordinality line(value, ord)
    ), '')
    || case when nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_promotion_code,''))),'') is not null
         then E'\npromo:' || pg_catalog.upper(pg_catalog.btrim(p_promotion_code)) else '' end
  );
$function$;

create or replace function pos_sales_private.resolve_replay_target(
  p_tenant_id uuid, p_normalized_key text, p_intent jsonb
) returns table (fingerprint_matches boolean, sale_id uuid, branch_id uuid, inventory_location_id uuid)
language plpgsql security definer set search_path = '' as $function$
declare v_key text := lower(btrim(p_normalized_key)); v_fingerprint text; v_sale public.pos_sales%rowtype;
begin
  if p_tenant_id is null or p_normalized_key is null or v_key = '' then return; end if;
  v_fingerprint := pos_sales_private.sale_intent_fingerprint(
    p_tenant_id, nullif(p_intent ->> 'register_id', '')::uuid,
    (p_intent ->> 'expected_total_minor')::bigint, (p_intent ->> 'cash_received_minor')::bigint,
    coalesce(p_intent -> 'lines', '[]'::jsonb), nullif(p_intent ->> 'promotion_code', ''));
  select * into v_sale from public.pos_sales s where s.tenant_id = p_tenant_id and s.normalized_idempotency_key = v_key;
  if not found then return; end if;
  if v_sale.payload_fingerprint is distinct from v_fingerprint then
    return query select false, null::uuid, v_sale.branch_id, v_sale.inventory_location_id;
  else
    return query select true, v_sale.id, v_sale.branch_id, v_sale.inventory_location_id;
  end if;
end;
$function$;

create or replace function pos_sales_private.record_sale(
  p_tenant_id uuid, p_register_id uuid, p_actor_membership_id uuid, p_idempotency_key text,
  p_expected_total_minor bigint, p_cash_received_minor bigint, p_lines jsonb,
  p_promotion_code text default null
) returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  bigint_max constant numeric := 9223372036854775807;
  v_key text := lower(btrim(p_idempotency_key));
  promo_code text := nullif(btrim(p_promotion_code), '');
  v_fingerprint text; v_existing_id uuid; v_existing_fingerprint text;
  v_branch_id uuid; v_location_id uuid; v_currency text; v_status text; v_fulfillment_enabled boolean;
  v_element jsonb; v_variant_id uuid; v_product_id uuid; v_brand_id uuid; v_first_brand_id uuid;
  v_variant_status text; v_price bigint; v_quantity bigint; v_total numeric := 0;
  v_product_name text; v_variant_name text; v_sku text;
  v_order_lines jsonb := '[]'::jsonb; v_fulfillment_lines jsonb := '[]'::jsonb;
  v_order_id uuid; v_payment_id uuid; v_fulfillment_id uuid; v_inventory_operation_id uuid;
  v_sale_id uuid; v_child_suffix text; v_seen uuid[] := array[]::uuid[]; v_order_line record;
  v_promo jsonb; v_net bigint;
begin
  if p_tenant_id is null or p_register_id is null or p_actor_membership_id is null
    or p_idempotency_key is null or v_key = '' or p_expected_total_minor is null
    or p_cash_received_minor is null then
    raise exception using errcode = '22004', message = 'POS sale fields are required';
  end if;
  if p_expected_total_minor < 0 or p_cash_received_minor < 0
    or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = '22023', message = 'invalid POS sale input';
  end if;

  v_fingerprint := pos_sales_private.sale_intent_fingerprint(
    p_tenant_id, p_register_id, p_expected_total_minor, p_cash_received_minor, p_lines, promo_code);
  select s.id, s.payload_fingerprint into v_existing_id, v_existing_fingerprint
  from public.pos_sales s where s.tenant_id = p_tenant_id and s.normalized_idempotency_key = v_key;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'POS sale idempotency conflict';
    end if;
    return v_existing_id;
  end if;

  select r.branch_id, r.default_inventory_location_id, r.selling_currency, r.status
  into v_branch_id, v_location_id, v_currency, v_status
  from public.registers r where r.tenant_id = p_tenant_id and r.id = p_register_id;
  if not found then raise exception using errcode = 'PS010', message = 'register not found'; end if;
  if v_status is distinct from 'active' then raise exception using errcode = 'PS011', message = 'register inactive'; end if;
  select b.status into v_status from public.branches b where b.tenant_id = p_tenant_id and b.id = v_branch_id;
  if v_status is distinct from 'active' then raise exception using errcode = 'PS012', message = 'branch inactive'; end if;
  select l.status, l.is_fulfillment_enabled into v_status, v_fulfillment_enabled
  from public.inventory_locations l where l.tenant_id = p_tenant_id and l.id = v_location_id;
  if v_status is distinct from 'active' then raise exception using errcode = 'PS013', message = 'location inactive'; end if;
  if v_fulfillment_enabled is distinct from true then raise exception using errcode = 'PS014', message = 'location cannot fulfill'; end if;

  for v_element in
    select line.value from pg_catalog.jsonb_array_elements(p_lines) with ordinality line(value, ord) order by line.ord
  loop
    if v_element ->> 'variant_id' is null or v_element ->> 'quantity' is null then
      raise exception using errcode = '22023', message = 'each line requires variant and quantity';
    end if;
    v_variant_id := (v_element ->> 'variant_id')::uuid;
    v_quantity := (v_element ->> 'quantity')::bigint;
    if v_quantity <= 0 or v_variant_id = any(v_seen) then
      raise exception using errcode = '22023', message = 'invalid or duplicate POS sale line';
    end if;
    v_seen := v_seen || v_variant_id;
    select pv.product_id, pv.status, pv.display_name, pv.sku, p.brand_id, p.name, vp.amount_minor
    into v_product_id, v_variant_status, v_variant_name, v_sku, v_brand_id, v_product_name, v_price
    from public.product_variants pv
    join public.products p on p.tenant_id = pv.tenant_id and p.id = pv.product_id
    join public.variant_prices vp on vp.tenant_id = pv.tenant_id
      and vp.variant_id = pv.id and vp.currency = v_currency and vp.status = 'active'
    where pv.tenant_id = p_tenant_id and pv.id = v_variant_id;
    if not found then
      if exists (select 1 from public.product_variants pv where pv.tenant_id = p_tenant_id and pv.id = v_variant_id) then
        raise exception using errcode = 'PS022', message = 'active price not found';
      end if;
      raise exception using errcode = 'PS020', message = 'variant not found';
    end if;
    if v_variant_status is distinct from 'active' then raise exception using errcode = 'PS021', message = 'variant inactive'; end if;
    if v_first_brand_id is null then v_first_brand_id := v_brand_id;
    elsif v_first_brand_id is distinct from v_brand_id then raise exception using errcode = 'PS024', message = 'cross-brand sale'; end if;
    v_total := v_total + v_quantity::numeric * v_price::numeric;
    if v_total > bigint_max then raise exception using errcode = '22003', message = 'sale total outside range'; end if;
    v_order_lines := v_order_lines || pg_catalog.jsonb_build_object(
      'variant_id', v_variant_id, 'product_id', v_product_id, 'quantity', v_quantity,
      'unit_price_minor', v_price, 'product_name', v_product_name, 'variant_name', v_variant_name,
      'sku', v_sku, 'option_summary', v_element ->> 'option_summary');
  end loop;

  if not exists (select 1 from public.branch_brands bb
    where bb.tenant_id = p_tenant_id and bb.branch_id = v_branch_id and bb.brand_id = v_first_brand_id) then
    raise exception using errcode = 'PS023', message = 'brand not carried';
  end if;

  v_child_suffix := pg_catalog.md5(p_tenant_id::text || ':' || v_key);
  v_order_id := orders_private.create_order(
    p_tenant_id, 'pos', v_currency, v_first_brand_id, v_branch_id, p_register_id,
    p_actor_membership_id, 'pos-sale-order:' || v_child_suffix, null, null, v_order_lines);
  -- Redeem the best-eligible promotion, then validate the client's expected NET (server-authoritative).
  v_promo := promotions_private.redeem(p_tenant_id, v_order_id, promo_code);
  if promo_code is not null and (v_promo->>'applied')::boolean is distinct from true then
    raise exception using errcode = 'PS025', message = 'promotion not applicable';
  end if;
  select total_minor into v_net from public.orders where tenant_id = p_tenant_id and id = v_order_id;
  if v_net is distinct from p_expected_total_minor then
    raise exception using errcode = 'PS409', message = 'authoritative price changed', detail = v_net::text;
  end if;
  if p_cash_received_minor < v_net then
    raise exception using errcode = 'PS030', message = 'cash received below total';
  end if;

  v_payment_id := payments_private.capture_cash_payment(
    p_tenant_id, v_order_id, p_cash_received_minor, p_actor_membership_id, 'pos-sale-payment:' || v_child_suffix);
  for v_order_line in
    select ol.id, ol.quantity from public.order_lines ol
    where ol.tenant_id = p_tenant_id and ol.order_id = v_order_id order by ol.line_number
  loop
    v_fulfillment_lines := v_fulfillment_lines || pg_catalog.jsonb_build_object(
      'order_line_id', v_order_line.id, 'quantity', v_order_line.quantity);
  end loop;
  select f.fulfillment_id, f.inventory_operation_id into v_fulfillment_id, v_inventory_operation_id
  from fulfillments_private.record_fulfillment(
    p_tenant_id, v_order_id, v_location_id, p_actor_membership_id,
    'pos-sale-fulfillment:' || v_child_suffix, null, v_fulfillment_lines) f;

  begin
    insert into public.pos_sales (
      tenant_id, register_id, branch_id, inventory_location_id, order_id, payment_id,
      fulfillment_id, idempotency_key, payload_fingerprint
    ) values (
      p_tenant_id, p_register_id, v_branch_id, v_location_id, v_order_id, v_payment_id,
      v_fulfillment_id, p_idempotency_key, v_fingerprint
    ) returning id into v_sale_id;
  exception when unique_violation then
    select s.id, s.payload_fingerprint into v_existing_id, v_existing_fingerprint
    from public.pos_sales s where s.tenant_id = p_tenant_id and s.normalized_idempotency_key = v_key;
    if v_existing_id is null or v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'POS sale idempotency conflict';
    end if;
    return v_existing_id;
  end;
  return v_sale_id;
end;
$function$;

grant usage on schema promotions_private to pos_sales_writer;
grant execute on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text) to pos_sales_writer;
do $b$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text) to service_role;
  end if;
end $b$;
