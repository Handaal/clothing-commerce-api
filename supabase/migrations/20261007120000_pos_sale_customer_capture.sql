-- Capture an optional customer on the connected POS sale.
--
-- record_sale gains an optional trailing p_customer jsonb ({name, phone}). When null, behaviour is
-- byte-identical to before. When present, the customer is matched within the tenant by normalized phone
-- (create-or-match) and linked to the order with a {name, phone} contact snapshot. Customer identity is
-- advisory metadata: it is NOT part of the sale fingerprint (a replay with the same key keeps the
-- first-attached customer) and it is attached only AFTER pricing, payment, and fulfillment so it can
-- never influence promotion redemption or the authoritative total.

-- public.customers is owned by online_writer with (unforced) RLS, so only online_writer may insert it.
-- The POS upsert helper is therefore owned by online_writer; the attach helper that touches orders stays
-- owned by orders_writer. Both live in orders_private and are granted to pos_sales_writer to call.
grant create on schema orders_private to orders_writer, online_writer;
-- Undo a grant from an earlier iteration of this migration: orders_writer cannot satisfy customers RLS
-- anyway, so it never needed direct customers access.
revoke insert, select on public.customers from orders_writer;

drop function if exists orders_private.upsert_pos_customer(uuid, text, text);
drop function if exists orders_private.attach_pos_customer(uuid, uuid, uuid, jsonb);

-- 1. Match-or-create a customer by normalized phone, scoped to the tenant. Owned by online_writer (the
--    customers table owner, which bypasses its RLS). Phone must normalize to E.164; name 1..200 chars.
--    An existing match is returned as-is (the stored name is not clobbered by a later typo at the register).
create function orders_private.upsert_pos_customer(p_tenant uuid, p_name text, p_phone text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_norm text := pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^+0-9]', '', 'g');
  v_id uuid;
begin
  if v_name = '' or pg_catalog.length(v_name) > 200 then
    raise exception using errcode = '22023', message = 'customer name is required';
  end if;
  if v_norm !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception using errcode = '22023', message = 'customer phone must be E.164';
  end if;
  select c.id into v_id from public.customers c
    where c.tenant_id = p_tenant and c.normalized_phone = v_norm limit 1;
  if found then return v_id; end if;
  insert into public.customers(tenant_id, name, phone)
    values (p_tenant, v_name, v_norm) returning id into v_id;
  return v_id;
end;
$function$;
alter function orders_private.upsert_pos_customer(uuid, text, text) owner to online_writer;
revoke all on function orders_private.upsert_pos_customer(uuid, text, text) from public;
grant execute on function orders_private.upsert_pos_customer(uuid, text, text) to pos_sales_writer;

-- 2. Attach a matched/created customer to a POS order with a contact snapshot. Mirrors
--    attach_checkout_customer but for channel='pos' (POS sales carry no delivery). Owned by orders_writer.
create function orders_private.attach_pos_customer(p_tenant uuid, p_order uuid, p_customer uuid, p_contact jsonb)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  perform pg_catalog.set_config('orders_private.allow_order_write', 'on', true);
  update public.orders set customer_id = p_customer, customer_snapshot = p_contact
    where tenant_id = p_tenant and id = p_order and channel = 'pos' and customer_id is null;
  if not found then
    raise exception using errcode = '22023', message = 'pos customer already attached';
  end if;
  perform pg_catalog.set_config('orders_private.allow_order_write', 'off', true);
end;
$function$;
alter function orders_private.attach_pos_customer(uuid, uuid, uuid, jsonb) owner to orders_writer;
revoke all on function orders_private.attach_pos_customer(uuid, uuid, uuid, jsonb) from public;
grant execute on function orders_private.attach_pos_customer(uuid, uuid, uuid, jsonb) to pos_sales_writer;

revoke create on schema orders_private from orders_writer, online_writer;

-- 2b. Customer linkage was originally online-only. Allow a POS branch too: a pos order may carry a
--     customer_id + contact snapshot (name/email/phone) but never a delivery snapshot. The null-all and
--     online branches are preserved exactly.
alter table public.orders drop constraint if exists orders_checkout_snapshots_consistent;
alter table public.orders add constraint orders_checkout_snapshots_consistent check (
  (customer_id is null and customer_snapshot is null and delivery_snapshot is null)
  or (channel = 'online' and customer_id is not null and customer_snapshot is not null
      and delivery_snapshot is not null and jsonb_typeof(customer_snapshot) = 'object'
      and jsonb_typeof(delivery_snapshot) = 'object')
  or (channel = 'pos' and customer_id is not null and customer_snapshot is not null
      and delivery_snapshot is null and jsonb_typeof(customer_snapshot) = 'object')
);

-- 3. Recreate record_sale with the optional trailing p_customer. The fingerprint and replay-target
--    helpers are unchanged (customer is not fingerprinted), so only record_sale is replaced.
grant create on schema pos_sales_private to pos_sales_writer;

drop function if exists pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb);
drop function if exists pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb);

create function pos_sales_private.record_sale(
  p_tenant_id uuid, p_register_id uuid, p_actor_membership_id uuid, p_idempotency_key text,
  p_expected_total_minor bigint, p_cash_received_minor bigint, p_lines jsonb,
  p_promotion_code text default null, p_tenders jsonb default null, p_customer jsonb default null
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
  v_promo jsonb; v_net bigint; v_customer_id uuid;
begin
  if p_tenant_id is null or p_register_id is null or p_actor_membership_id is null
    or p_idempotency_key is null or v_key = '' or p_expected_total_minor is null
    or (p_tenders is null and p_cash_received_minor is null) then
    raise exception using errcode = '22004', message = 'POS sale fields are required';
  end if;
  if p_expected_total_minor < 0 or coalesce(p_cash_received_minor, 0) < 0
    or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_lines) = 0
    or (p_tenders is not null and pg_catalog.jsonb_typeof(p_tenders) is distinct from 'array')
    or (p_customer is not null and pg_catalog.jsonb_typeof(p_customer) is distinct from 'object') then
    raise exception using errcode = '22023', message = 'invalid POS sale input';
  end if;

  v_fingerprint := pos_sales_private.sale_intent_fingerprint(
    p_tenant_id, p_register_id, p_expected_total_minor, p_cash_received_minor, p_lines, promo_code,
    p_tenders);
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
  v_promo := promotions_private.redeem(p_tenant_id, v_order_id, promo_code);
  if promo_code is not null and (v_promo->>'applied')::boolean is distinct from true then
    raise exception using errcode = 'PS025', message = 'promotion not applicable';
  end if;
  select total_minor into v_net from public.orders where tenant_id = p_tenant_id and id = v_order_id;
  if v_net is distinct from p_expected_total_minor then
    raise exception using errcode = 'PS409', message = 'authoritative price changed', detail = v_net::text;
  end if;

  if p_tenders is null then
    -- Cash-only path, unchanged: one captured cash payment covering the net total.
    if p_cash_received_minor < v_net then
      raise exception using errcode = 'PS030', message = 'cash received below total';
    end if;
    v_payment_id := payments_private.capture_cash_payment(
      p_tenant_id, v_order_id, p_cash_received_minor, p_actor_membership_id,
      'pos-sale-payment:' || v_child_suffix);
  else
    -- Split tender: capture_payments validates the tenders sum to the authoritative net total.
    v_payment_id := payments_private.capture_payments(
      p_tenant_id, v_order_id, p_tenders, p_actor_membership_id,
      'pos-sale-payment:' || v_child_suffix);
  end if;

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

  -- Optional customer capture: match-or-create by phone, then attach a contact snapshot. Done last so
  -- it cannot affect pricing, promotion redemption, or payment. A bad name/phone fails the whole sale.
  if p_customer is not null then
    v_customer_id := orders_private.upsert_pos_customer(
      p_tenant_id, p_customer ->> 'name', p_customer ->> 'phone');
    perform orders_private.attach_pos_customer(
      p_tenant_id, v_order_id, v_customer_id,
      pg_catalog.jsonb_build_object(
        'name', p_customer ->> 'name', 'email', p_customer ->> 'email', 'phone', p_customer ->> 'phone'));
  end if;

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

alter function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb)
  owner to pos_sales_writer;
revoke create on schema pos_sales_private from pos_sales_writer;

revoke all on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb) from public;
grant execute on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb)
  to pos_sales_writer;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb) from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb) from authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb) to service_role';
  end if;
end;
$block$;
