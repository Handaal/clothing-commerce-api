-- Connected POS installment sales.
--
-- record_sale gains an optional trailing p_amount_paid_minor. When null (or equal to the authoritative
-- net total) behaviour is byte-identical to before: the sale is fully settled. When it is LESS than the
-- net total the sale is an installment: the customer is required, a positive deposit is captured now,
-- the goods are fulfilled as usual, and the unpaid remainder is recorded as a customer debt
-- (customers_ar_private.record_sale_debt). The deposit is captured through capture_partial_payments,
-- a sibling of capture_payments that balances the tenders against the deposit instead of the total.

grant create on schema public, payments_private to payments_writer;

-- Capture one-or-more cashier-confirmed tenders summing to an explicit target (the deposit), which must
-- be between 1 and the order total. Identical to capture_payments except the balancing check targets the
-- deposit rather than the full order total, so the order can remain partly unpaid.
create function payments_private.capture_partial_payments(
  p_tenant_id uuid,
  p_order_id uuid,
  p_tenders jsonb,
  p_captured_by_membership_id uuid,
  p_idempotency_key text,
  p_target_minor bigint
)
returns uuid
language plpgsql security definer set search_path = '' as $function$
declare
  v_group_key text := lower(btrim(p_idempotency_key));
  v_order_total bigint;
  v_currency text;
  v_fingerprint text;
  v_existing_primary uuid;
  v_existing_fingerprint text;
  v_sum bigint := 0;
  v_seen text[] := array[]::text[];
  v_element jsonb;
  v_method text;
  v_amount bigint;
  v_cash_received bigint;
  v_change bigint;
  v_seq smallint := 0;
  v_payment_id uuid;
  v_primary_id uuid;
begin
  if p_tenant_id is null or p_order_id is null or p_captured_by_membership_id is null
    or p_idempotency_key is null or v_group_key = '' or p_tenders is null or p_target_minor is null then
    raise exception using errcode = '22004', message = 'payment capture fields are required';
  end if;
  if pg_catalog.jsonb_typeof(p_tenders) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_tenders) = 0 then
    raise exception using errcode = '22023', message = 'at least one tender is required';
  end if;

  select o.total_minor, o.currency into v_order_total, v_currency
  from public.orders o where o.tenant_id = p_tenant_id and o.id = p_order_id;
  if not found then
    raise exception using errcode = 'FF010', message = 'order not found';
  end if;
  if p_target_minor <= 0 or p_target_minor > v_order_total then
    raise exception using errcode = '22023', message = 'deposit outside the payable range';
  end if;

  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || p_order_id::text || E'\n' || p_target_minor::text || E'\n' || coalesce((
      select pg_catalog.string_agg(
        E'\n' || (t.value ->> 'method') || ',' || (t.value ->> 'amount_minor') || ','
          || coalesce(t.value ->> 'cash_received_minor', ''),
        '' order by t.ord
      )
      from pg_catalog.jsonb_array_elements(p_tenders) with ordinality t(value, ord)
    ), '')
  );

  select p.id, p.payload_fingerprint into v_existing_primary, v_existing_fingerprint
  from public.payments p
  where p.tenant_id = p_tenant_id and p.tender_group_key = v_group_key
  order by case when p.method = 'cash' then 0 else 1 end, p.tender_sequence
  limit 1;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'payment idempotency conflict';
    end if;
    return v_existing_primary;
  end if;

  for v_element in
    select t.value from pg_catalog.jsonb_array_elements(p_tenders) with ordinality t(value, ord)
    order by t.ord
  loop
    v_method := v_element ->> 'method';
    if v_method is null or v_method not in ('cash', 'card', 'instapay', 'wallet') then
      raise exception using errcode = '22023', message = 'unsupported tender method';
    end if;
    if v_method = any(v_seen) then
      raise exception using errcode = '22023', message = 'a method may appear at most once per sale';
    end if;
    v_seen := v_seen || v_method;

    if v_element ->> 'amount_minor' is null then
      raise exception using errcode = '22023', message = 'tender amount is required';
    end if;
    v_amount := (v_element ->> 'amount_minor')::bigint;
    if v_amount <= 0 then
      raise exception using errcode = '22023', message = 'tender amount must be positive';
    end if;
    v_sum := v_sum + v_amount;
    v_seq := v_seq + 1;

    if v_method = 'cash' then
      v_cash_received := coalesce((v_element ->> 'cash_received_minor')::bigint, v_amount);
      if v_cash_received < v_amount then
        raise exception using errcode = 'PS030', message = 'cash received below cash tender amount';
      end if;
      v_change := v_cash_received - v_amount;
    else
      v_cash_received := v_amount;
      v_change := 0;
    end if;

    insert into public.payments (
      tenant_id, order_id, method, status, currency, amount_minor, cash_received_minor,
      change_minor, captured_by_membership_id, idempotency_key, payload_fingerprint,
      tender_sequence, tender_group_key
    ) values (
      p_tenant_id, p_order_id, v_method, 'captured', v_currency, v_amount, v_cash_received,
      v_change, p_captured_by_membership_id, p_idempotency_key || ':' || v_seq::text, v_fingerprint,
      v_seq, v_group_key
    ) returning id into v_payment_id;

    if v_method = 'cash' or v_primary_id is null then
      v_primary_id := v_payment_id;
    end if;
  end loop;

  if v_sum is distinct from p_target_minor then
    raise exception using errcode = 'PS031', message = 'tenders do not sum to the deposit';
  end if;
  return v_primary_id;
exception
  when unique_violation then
    select p.id, p.payload_fingerprint into v_existing_primary, v_existing_fingerprint
    from public.payments p
    where p.tenant_id = p_tenant_id and p.tender_group_key = v_group_key
    order by case when p.method = 'cash' then 0 else 1 end, p.tender_sequence
    limit 1;
    if v_existing_primary is null or v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'payment idempotency conflict';
    end if;
    return v_existing_primary;
end;
$function$;

alter function payments_private.capture_partial_payments(uuid, uuid, jsonb, uuid, text, bigint)
  owner to payments_writer;
revoke create on schema public, payments_private from payments_writer;
revoke all on function payments_private.capture_partial_payments(uuid, uuid, jsonb, uuid, text, bigint)
  from public;
grant execute on function payments_private.capture_partial_payments(uuid, uuid, jsonb, uuid, text, bigint)
  to pos_sales_writer;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function payments_private.capture_partial_payments(uuid, uuid, jsonb, uuid, text, bigint) to service_role';
  end if;
end;
$block$;

-- Recreate the replay pre-check so it folds the deposit into the fingerprint identically to record_sale
-- (below). Full sales omit amount_paid_minor and keep a byte-identical fingerprint.
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
    coalesce(p_intent -> 'lines', '[]'::jsonb), nullif(p_intent ->> 'promotion_code', ''),
    p_intent -> 'tenders');
  if p_intent ? 'amount_paid_minor' then
    v_fingerprint := pg_catalog.md5(v_fingerprint || E'\n' || (p_intent ->> 'amount_paid_minor'));
  end if;
  select * into v_sale from public.pos_sales s where s.tenant_id = p_tenant_id and s.normalized_idempotency_key = v_key;
  if not found then return; end if;
  if v_sale.payload_fingerprint is distinct from v_fingerprint then
    return query select false, null::uuid, v_sale.branch_id, v_sale.inventory_location_id;
  else
    return query select true, v_sale.id, v_sale.branch_id, v_sale.inventory_location_id;
  end if;
end;
$function$;

-- Recreate record_sale with the optional trailing p_amount_paid_minor (deposit). The full-payment path
-- is unchanged; only a new installment branch and the debt recording are added. Drop the prior 10-arg
-- overload first so the defaulted 11-arg signature is unambiguous for named-parameter RPC callers.
grant create on schema pos_sales_private to pos_sales_writer;

drop function if exists pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb);

create function pos_sales_private.record_sale(
  p_tenant_id uuid, p_register_id uuid, p_actor_membership_id uuid, p_idempotency_key text,
  p_expected_total_minor bigint, p_cash_received_minor bigint, p_lines jsonb,
  p_promotion_code text default null, p_tenders jsonb default null, p_customer jsonb default null,
  p_amount_paid_minor bigint default null
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
  v_promo jsonb; v_net bigint; v_customer_id uuid; v_paid bigint; v_tenders jsonb;
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
    or (p_customer is not null and pg_catalog.jsonb_typeof(p_customer) is distinct from 'object')
    or (p_amount_paid_minor is not null and p_amount_paid_minor < 0) then
    raise exception using errcode = '22023', message = 'invalid POS sale input';
  end if;

  v_fingerprint := pos_sales_private.sale_intent_fingerprint(
    p_tenant_id, p_register_id, p_expected_total_minor, p_cash_received_minor, p_lines, promo_code,
    p_tenders);
  -- An installment intent is a distinct sale even with an otherwise-identical basket; fold the deposit
  -- into the fingerprint so full and installment replays never collide (full sales stay byte-identical).
  if p_amount_paid_minor is not null then
    v_fingerprint := pg_catalog.md5(v_fingerprint || E'\n' || p_amount_paid_minor::text);
  end if;
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

  -- Deposit defaults to the full net (a normal sale). A smaller deposit is an installment sale.
  v_paid := coalesce(p_amount_paid_minor, v_net);
  if v_paid > v_net then
    raise exception using errcode = '22023', message = 'amount paid exceeds total';
  end if;

  if v_paid < v_net then
    -- Installment: a customer and a positive deposit are mandatory (pos_sales.payment_id is NOT NULL).
    if p_customer is null then
      raise exception using errcode = 'PS032', message = 'installment sale requires a customer';
    end if;
    if v_paid <= 0 then
      raise exception using errcode = 'PS033', message = 'installment requires a positive deposit';
    end if;
    if p_tenders is null then
      if p_cash_received_minor < v_paid then
        raise exception using errcode = 'PS030', message = 'cash received below amount paid';
      end if;
      v_tenders := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'method', 'cash', 'amount_minor', v_paid, 'cash_received_minor', p_cash_received_minor));
    else
      v_tenders := p_tenders;
    end if;
    v_payment_id := payments_private.capture_partial_payments(
      p_tenant_id, v_order_id, v_tenders, p_actor_membership_id,
      'pos-sale-payment:' || v_child_suffix, v_paid);
  elsif p_tenders is null then
    -- Cash-only full path, unchanged.
    if p_cash_received_minor < v_net then
      raise exception using errcode = 'PS030', message = 'cash received below total';
    end if;
    v_payment_id := payments_private.capture_cash_payment(
      p_tenant_id, v_order_id, p_cash_received_minor, p_actor_membership_id,
      'pos-sale-payment:' || v_child_suffix);
  else
    -- Split-tender full path, unchanged.
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

  -- Optional customer capture (required above for installments). Done last so it cannot affect pricing,
  -- promotion redemption, or payment. A bad name/phone fails the whole sale.
  if p_customer is not null then
    v_customer_id := orders_private.upsert_pos_customer(
      p_tenant_id, p_customer ->> 'name', p_customer ->> 'phone');
    perform orders_private.attach_pos_customer(
      p_tenant_id, v_order_id, v_customer_id,
      pg_catalog.jsonb_build_object(
        'name', p_customer ->> 'name', 'email', p_customer ->> 'email', 'phone', p_customer ->> 'phone'));
    -- Record the unpaid remainder as a customer debt.
    if v_paid < v_net then
      perform customers_ar_private.record_sale_debt(
        p_tenant_id, v_order_id, v_customer_id, v_currency, v_net, v_paid, p_actor_membership_id);
    end if;
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

alter function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb, bigint)
  owner to pos_sales_writer;
revoke create on schema pos_sales_private from pos_sales_writer;
revoke all on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb, bigint) from public;
grant execute on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb, bigint)
  to pos_sales_writer;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb, bigint) from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb, bigint) from authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb, text, jsonb, jsonb, bigint) to service_role';
  end if;
end;
$block$;
