-- Phase 1B (Storefront program): delivery fees per delivery area.
--
-- A brand's Storefront can define delivery zones (e.g. Egypt's governorates, code "EG-C" = Cairo), each with
-- a delivery fee, plus an optional free-delivery threshold. When a brand has at least one active zone,
-- online checkout requires the shopper to choose a zone and charges its fee; with no zones configured the
-- fee is 0 (the pre-1B behaviour, so existing deployments keep working).
--
-- Accounting decision: the delivery fee is part of the order's payable total. The order identity becomes
--   total_minor = gross_subtotal_minor - discount_total_minor + delivery_fee_minor
-- so the COD payment amount and the order total stay one number. Promotions still discount goods only
-- (redeem runs before the fee is applied, while the fee is 0); returns refund line allocations, never the fee.
-- Known limitation: reporting "net" sums total_minor, so it includes delivery fees for online orders until
-- reporting gains a separate delivery column.
--
-- New internal SQLSTATE: OC006 delivery zone missing or unavailable (CheckoutError DELIVERY_ZONE_UNAVAILABLE).

-- ---------------------------------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------------------------------
create table public.storefront_delivery_zones (
  tenant_id uuid not null,
  brand_id uuid not null,
  code text not null,
  name text not null,
  fee_minor bigint not null,
  position integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, brand_id, code),
  constraint storefront_delivery_zones_brand_fk
    foreign key (tenant_id, brand_id) references public.brands (tenant_id, id) on delete restrict,
  constraint storefront_delivery_zones_code_valid check (code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  constraint storefront_delivery_zones_name_valid check (btrim(name) <> '' and length(name) <= 100),
  constraint storefront_delivery_zones_fee_range check (fee_minor between 0 and 100000000),
  constraint storefront_delivery_zones_position_nonnegative check (position >= 0)
);

comment on table public.storefront_delivery_zones is
  'Per-brand Storefront delivery areas and their fee (minor units, Storefront currency).';

alter table public.storefront_checkout_settings
  add column free_delivery_threshold_minor bigint,
  add constraint storefront_checkout_settings_free_delivery_threshold_range
    check (free_delivery_threshold_minor is null or free_delivery_threshold_minor between 0 and 100000000000);

comment on column public.storefront_checkout_settings.free_delivery_threshold_minor is
  'When set, orders whose goods total (after discount) reaches this amount ship free.';

alter table public.orders
  add column delivery_fee_minor bigint not null default 0,
  add constraint orders_delivery_fee_nonnegative check (delivery_fee_minor >= 0);

alter table public.orders drop constraint orders_net_total_identity;
alter table public.orders
  add constraint orders_net_total_identity
    check (total_minor = gross_subtotal_minor - discount_total_minor + delivery_fee_minor);

comment on column public.orders.delivery_fee_minor is
  'Delivery fee charged on an online order (0 for POS and pre-1B orders). Included in total_minor.';

-- Privileges: settings manage the zones; checkout reads them. Deny-by-default for clients.
alter table public.storefront_delivery_zones enable row level security;
revoke all on table public.storefront_delivery_zones from public;
do $block$
begin
  grant select, insert, update, delete on public.storefront_delivery_zones to settings_writer;
  create policy settings_writer_manage on public.storefront_delivery_zones
    for all to settings_writer using (true) with check (true);
  grant select on public.storefront_delivery_zones to online_writer;
  create policy online_writer_read on public.storefront_delivery_zones
    for select to online_writer using (true);
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on public.storefront_delivery_zones from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on public.storefront_delivery_zones from authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    revoke all on public.storefront_delivery_zones from service_role;
    grant select on public.storefront_delivery_zones to service_role;
  end if;
end;
$block$;

-- ---------------------------------------------------------------------------------------------------
-- Sanctioned fee writer (orders_writer, like apply_order_discount)
-- ---------------------------------------------------------------------------------------------------
create function orders_private.apply_delivery_fee(p_tenant uuid, p_order uuid, p_fee bigint)
returns void language plpgsql security definer set search_path = '' as $function$
declare v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where tenant_id = p_tenant and id = p_order for update;
  if not found then raise exception using errcode = '22023', message = 'order not found'; end if;
  if v_order.channel <> 'online' then
    raise exception using errcode = '22023', message = 'delivery fees apply to online orders only';
  end if;
  if p_fee is null or p_fee < 0 then
    raise exception using errcode = '22023', message = 'invalid delivery fee';
  end if;
  perform set_config('orders_private.allow_order_write', 'on', true);
  update public.orders
    set delivery_fee_minor = p_fee,
        total_minor = gross_subtotal_minor - discount_total_minor + p_fee,
        updated_at = now()
    where tenant_id = p_tenant and id = p_order;
  perform set_config('orders_private.allow_order_write', 'off', true);
end;
$function$;

grant create on schema orders_private to orders_writer;
alter function orders_private.apply_delivery_fee(uuid, uuid, bigint) owner to orders_writer;
revoke create on schema orders_private from orders_writer;
revoke all on function orders_private.apply_delivery_fee(uuid, uuid, bigint) from public;
grant execute on function orders_private.apply_delivery_fee(uuid, uuid, bigint) to online_writer;

-- ---------------------------------------------------------------------------------------------------
-- Delivery charge resolution (shared by quote and placement)
-- ---------------------------------------------------------------------------------------------------
-- Returns { configured, required, feeMinor (null while a zone must still be chosen), zone {code,name},
-- freeDeliveryThresholdMinor, freeApplied }. Raises OC006 for an unknown/inactive zone.
create function online_private.delivery_charge(
  p_tenant uuid, p_brand uuid, p_threshold bigint, p_zone text, p_goods_net bigint
) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_zone public.storefront_delivery_zones;
  v_configured boolean;
  v_free boolean;
  v_code text := nullif(upper(btrim(coalesce(p_zone, ''))), '');
begin
  select exists (
    select 1 from public.storefront_delivery_zones
    where tenant_id = p_tenant and brand_id = p_brand and active
  ) into v_configured;

  if not v_configured then
    return jsonb_build_object('configured', false, 'required', false, 'feeMinor', 0, 'zone', null,
      'freeDeliveryThresholdMinor', p_threshold, 'freeApplied', false);
  end if;
  if v_code is null then
    return jsonb_build_object('configured', true, 'required', true, 'feeMinor', null, 'zone', null,
      'freeDeliveryThresholdMinor', p_threshold, 'freeApplied', false);
  end if;

  select * into v_zone from public.storefront_delivery_zones
    where tenant_id = p_tenant and brand_id = p_brand and code = v_code and active;
  if not found then
    raise exception using errcode = 'OC006', message = 'delivery zone unavailable';
  end if;

  v_free := p_threshold is not null and p_goods_net >= p_threshold;
  return jsonb_build_object('configured', true, 'required', false,
    'feeMinor', case when v_free then 0 else v_zone.fee_minor end,
    'zone', jsonb_build_object('code', v_zone.code, 'name', v_zone.name),
    'freeDeliveryThresholdMinor', p_threshold, 'freeApplied', v_free and v_zone.fee_minor > 0);
end;
$function$;

grant create on schema online_private to online_writer;
alter function online_private.delivery_charge(uuid, uuid, bigint, text, bigint) owner to online_writer;
revoke create on schema online_private from online_writer;
revoke all on function online_private.delivery_charge(uuid, uuid, bigint, text, bigint) from public;

-- Public delivery options for the Storefront (active zones, fees, threshold). No checkout context needed.
create function online_private.delivery_options(p_tenant uuid, p_brand uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'currency', (select s.currency from public.storefront_checkout_settings s
                  where s.tenant_id = p_tenant and s.brand_id = p_brand),
    'freeDeliveryThresholdMinor', (select s.free_delivery_threshold_minor
                  from public.storefront_checkout_settings s
                  where s.tenant_id = p_tenant and s.brand_id = p_brand),
    'zones', coalesce((
      select jsonb_agg(jsonb_build_object('code', z.code, 'name', z.name, 'feeMinor', z.fee_minor)
                       order by z.position, z.name)
      from public.storefront_delivery_zones z
      where z.tenant_id = p_tenant and z.brand_id = p_brand and z.active
    ), '[]'::jsonb)
  );
$function$;

grant create on schema online_private to online_writer;
alter function online_private.delivery_options(uuid, uuid) owner to online_writer;
revoke create on schema online_private from online_writer;
revoke all on function online_private.delivery_options(uuid, uuid) from public;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function online_private.delivery_options(uuid, uuid) to service_role;
  end if;
end;
$block$;

-- ---------------------------------------------------------------------------------------------------
-- Quote: same as 20260924180300 plus delivery (zoneCode optional; totalMinor includes a known fee)
-- ---------------------------------------------------------------------------------------------------
create or replace function online_private.quote_checkout(p_intent jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  t uuid := (p_intent->>'tenantId')::uuid;
  b uuid := (p_intent->>'brandId')::uuid;
  promo_code text := nullif(btrim(p_intent->>'promotionCode'), '');
  c public.storefront_checkout_settings;
  line jsonb; resolved jsonb := '[]'; ord int := 0; gross numeric := 0; v_eval jsonb;
  v_discount bigint; v_net bigint; v_delivery jsonb;
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
  v_discount := coalesce((v_eval->>'discountTotalMinor')::bigint,0);
  v_net := gross::bigint - v_discount;
  v_delivery := online_private.delivery_charge(t, b, c.free_delivery_threshold_minor,
    p_intent->>'zoneCode', v_net);
  return jsonb_build_object('currency',c.currency,'grossSubtotalMinor',gross::bigint,
    'discountTotalMinor',v_discount,
    'totalMinor',v_net + coalesce((v_delivery->>'feeMinor')::bigint, 0),
    'codeStatus',v_eval->>'codeStatus',
    'promotion',case when (v_eval->>'applied')::boolean then jsonb_build_object(
      'promotionId',v_eval->>'promotionId','name',v_eval->>'promotionName','benefitType',v_eval->>'benefitType',
      'activation',case when nullif(v_eval->>'codeId','') is not null then 'code' else 'automatic' end,
      'code',v_eval->>'codeSnapshot','discountTotalMinor',(v_eval->>'discountTotalMinor')::bigint) else null end,
    'delivery', jsonb_build_object(
      'required', (v_delivery->>'required')::boolean,
      'feeMinor', v_delivery->'feeMinor',
      'zone', v_delivery->'zone',
      'freeDeliveryThresholdMinor', v_delivery->'freeDeliveryThresholdMinor',
      'freeApplied', (v_delivery->>'freeApplied')::boolean));
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Placement: same as 20260924180300 plus the delivery fee (applied after redemption, before the net
-- check and the COD payment, so payment amount = order total = goods net + delivery).
-- ---------------------------------------------------------------------------------------------------
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
  v_goods bigint;
  v_delivery jsonb;
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
  -- Delivery: priced on the goods net (after discount); a configured Storefront requires a zone.
  select total_minor into v_goods from public.orders where tenant_id=t and id=v_order_id;
  v_delivery := online_private.delivery_charge(t, b, c.free_delivery_threshold_minor,
    p_intent->'delivery'->>'zoneCode', v_goods);
  if (v_delivery->>'required')::boolean then
    raise exception using errcode='OC006',message='delivery zone required';
  end if;
  if (v_delivery->>'feeMinor')::bigint > 0 then
    perform orders_private.apply_delivery_fee(t, v_order_id, (v_delivery->>'feeMinor')::bigint);
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
    'deliveryFeeMinor',o.delivery_fee_minor,
    'deliveryZone',v_delivery->'zone',
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
grant create on schema online_private to online_writer;
alter function online_private.place_checkout(text,jsonb) owner to online_writer;
alter function online_private.quote_checkout(jsonb) owner to online_writer;
revoke create on schema online_private from online_writer;

-- ---------------------------------------------------------------------------------------------------
-- Settings: read / replace a brand's delivery zones + free-delivery threshold (settings.manage)
-- ---------------------------------------------------------------------------------------------------
create function settings_private.storefront_delivery_json(p_tenant uuid, p_brand uuid)
returns jsonb language sql stable security definer set search_path = '' as $f$
  select jsonb_build_object(
    'brandId', p_brand,
    'currency', s.currency,
    'freeDeliveryThresholdMinor', s.free_delivery_threshold_minor,
    'zones', coalesce((
      select jsonb_agg(jsonb_build_object('code', z.code, 'name', z.name, 'feeMinor', z.fee_minor,
        'active', z.active, 'position', z.position) order by z.position, z.name)
      from public.storefront_delivery_zones z
      where z.tenant_id = p_tenant and z.brand_id = p_brand
    ), '[]'::jsonb))
  from public.storefront_checkout_settings s
  where s.tenant_id = p_tenant and s.brand_id = p_brand
$f$;

create function settings_private.get_storefront_delivery(p_tenant uuid, p_brand uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare v jsonb;
begin
  v := settings_private.storefront_delivery_json(p_tenant, p_brand);
  if v is null then raise exception using errcode = 'ST404', message = 'storefront settings not found'; end if;
  return v;
end;
$f$;

-- p_input: { "freeDeliveryThresholdMinor": int|null, "zones": [{ code, name, feeMinor, active?, position? }] }
-- The zone list is the complete set (replace); orders keep their own zone snapshot, so removing a zone never
-- touches history.
create function settings_private.write_storefront_delivery(
  p_tenant uuid, p_brand uuid, p_actor uuid, p_key text, p_input jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $f$
declare
  v_intent jsonb; v_replay jsonb; v_zone jsonb; v_position integer := 0; v_threshold bigint;
begin
  v_intent := jsonb_build_object('op', 'write_storefront_delivery', 'brand', p_brand, 'actor', p_actor,
    'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  perform settings_private.only_keys(p_input, array['freeDeliveryThresholdMinor', 'zones']);
  if jsonb_typeof(p_input->'zones') is distinct from 'array' or jsonb_array_length(p_input->'zones') > 60 then
    raise exception using errcode = '22023', message = 'zones must be an array of at most 60 entries';
  end if;
  if not exists (
    select 1 from public.storefront_checkout_settings where tenant_id = p_tenant and brand_id = p_brand
  ) then
    raise exception using errcode = 'ST404', message = 'storefront settings not found';
  end if;
  if (select count(*) <> count(distinct upper(btrim(value->>'code'))) from jsonb_array_elements(p_input->'zones')) then
    raise exception using errcode = '22023', message = 'zone codes must be unique';
  end if;

  v_threshold := case when p_input ? 'freeDeliveryThresholdMinor'
                        and jsonb_typeof(p_input->'freeDeliveryThresholdMinor') <> 'null'
                      then (p_input->>'freeDeliveryThresholdMinor')::bigint else null end;
  update public.storefront_checkout_settings
    set free_delivery_threshold_minor = v_threshold
    where tenant_id = p_tenant and brand_id = p_brand;

  delete from public.storefront_delivery_zones where tenant_id = p_tenant and brand_id = p_brand;
  for v_zone in select value from jsonb_array_elements(p_input->'zones') loop
    if jsonb_typeof(v_zone) <> 'object' or (v_zone - array['code','name','feeMinor','active','position']) <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'invalid zone';
    end if;
    insert into public.storefront_delivery_zones (tenant_id, brand_id, code, name, fee_minor, position, active)
    values (p_tenant, p_brand, upper(btrim(v_zone->>'code')), btrim(v_zone->>'name'),
      (v_zone->>'feeMinor')::bigint, coalesce((v_zone->>'position')::integer, v_position),
      coalesce((v_zone->>'active')::boolean, true));
    v_position := v_position + 1;
  end loop;

  return settings_private.record(p_tenant, p_key, v_intent,
    settings_private.storefront_delivery_json(p_tenant, p_brand));
end;
$f$;

grant create on schema settings_private to settings_writer;
alter function settings_private.storefront_delivery_json(uuid, uuid) owner to settings_writer;
alter function settings_private.get_storefront_delivery(uuid, uuid) owner to settings_writer;
alter function settings_private.write_storefront_delivery(uuid, uuid, uuid, text, jsonb) owner to settings_writer;
revoke create on schema settings_private from settings_writer;
revoke all on function settings_private.storefront_delivery_json(uuid, uuid),
  settings_private.get_storefront_delivery(uuid, uuid),
  settings_private.write_storefront_delivery(uuid, uuid, uuid, text, jsonb)
  from public;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function settings_private.get_storefront_delivery(uuid, uuid),
      settings_private.write_storefront_delivery(uuid, uuid, uuid, text, jsonb) from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on function settings_private.get_storefront_delivery(uuid, uuid),
      settings_private.write_storefront_delivery(uuid, uuid, uuid, text, jsonb) from authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function settings_private.get_storefront_delivery(uuid, uuid),
      settings_private.write_storefront_delivery(uuid, uuid, uuid, text, jsonb) to service_role;
  end if;
end;
$block$;
