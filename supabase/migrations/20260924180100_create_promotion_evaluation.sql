-- Phase 2P-A (2/3): the SINGLE shared promotion engine.
--
--   promotions_private.evaluate        -- non-consuming, deterministic best-eligible-saving selection +
--                                         largest-remainder allocation. Used by BOTH quote and placement.
--   orders_private.apply_order_discount -- sanctioned net-total writer (owned by orders_writer).
--   promotions_private.redeem          -- consuming: re-derives from immutable order_lines under row
--                                         locks, increments capacity, snapshots adjustments + redemption.
--
-- Server-authoritative money: clients never author discount/allocation/eligibility. redeem ignores any
-- client figure and recomputes from the committed order_lines + live config under lock.

-- Line input shape (both quote and placement): jsonb array of
--   { "ord": int, "variantId": uuid, "productId": uuid, "quantity": bigint, "lineTotalMinor": bigint }
-- ord is the stable allocation order (line_number at placement; array index at quote time).

create function promotions_private.line_matches_targets(
  p_tenant uuid, p_promotion uuid, p_product uuid, p_variant uuid
) returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.promotion_targets t
    where t.tenant_id = p_tenant and t.promotion_id = p_promotion
      and ((t.variant_id is not null and t.variant_id = p_variant)
        or (t.product_id is not null and t.product_id = p_product))
  );
$function$;

-- Deterministic best-eligible-saving selection. Never mutates. Returns the winning promotion, the
-- computed discount, and the per-line allocation, or applied=false when nothing qualifies.
create function promotions_private.evaluate(
  p_tenant uuid,
  p_channel text,
  p_currency text,
  p_brand uuid,
  p_branch uuid,
  p_lines jsonb,
  p_code text
) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_now timestamptz := now();
  v_code_norm text := nullif(upper(btrim(coalesce(p_code, ''))), '');
  v_gross bigint := 0;
  v_line jsonb;
  v_code_status text := case when v_code_norm is null then 'none' else 'invalid' end;
  -- winner accumulators
  v_best_promo public.promotions%rowtype;
  v_best_code public.promotion_codes%rowtype;
  v_best_source text;            -- 'automatic' | 'code'
  v_best_discount bigint := 0;
  v_best_basis bigint := 0;
  v_have_best boolean := false;
  -- candidate iteration
  v_promo public.promotions%rowtype;
  v_code public.promotion_codes%rowtype;
  v_source text;
  v_basis bigint;
  v_discount bigint;
  v_better boolean;
  v_result jsonb;
  v_allocations jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('applied', false, 'codeStatus', v_code_status, 'grossSubtotalMinor', 0,
      'discountTotalMinor', 0, 'eligibleBasisMinor', 0, 'allocations', '[]'::jsonb);
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_gross := v_gross + (v_line->>'lineTotalMinor')::bigint;
  end loop;

  -- Build the candidate set: every eligible automatic promotion, plus the single entered code's
  -- promotion. Both are scored; only the greatest eligible saving is applied (no stacking).
  for v_promo in
    select * from public.promotions p
    where p.tenant_id = p_tenant and p.status = 'active' and p.activation_type = 'automatic'
      and (p.starts_at is null or p.starts_at <= v_now)
      and (p.ends_at is null or p.ends_at > v_now)
      and (p.channel is null or p.channel = p_channel)
      and (p.brand_id is null or p.brand_id = p_brand)
      and (p.branch_id is null or p.branch_id = p_branch)
      and (p.global_redemption_limit is null or p.redemption_count < p.global_redemption_limit)
      and (p.benefit_type <> 'fixed_amount' or p.benefit_currency = p_currency)
    union all
    select p.* from public.promotions p
    join public.promotion_codes c on c.tenant_id = p.tenant_id and c.promotion_id = p.id
    where v_code_norm is not null and c.tenant_id = p_tenant and c.normalized_code = v_code_norm
      and c.status = 'active' and p.status = 'active' and p.activation_type = 'code'
      and (p.starts_at is null or p.starts_at <= v_now)
      and (p.ends_at is null or p.ends_at > v_now)
      and (p.channel is null or p.channel = p_channel)
      and (p.brand_id is null or p.brand_id = p_brand)
      and (p.branch_id is null or p.branch_id = p_branch)
      and (p.global_redemption_limit is null or p.redemption_count < p.global_redemption_limit)
      and (c.max_redemptions is null or c.redemption_count < c.max_redemptions)
      and (p.benefit_type <> 'fixed_amount' or p.benefit_currency = p_currency)
  loop
    v_source := case when v_promo.activation_type = 'code' then 'code' else 'automatic' end;
    if v_source = 'code' then
      select * into v_code from public.promotion_codes c
      where c.tenant_id = p_tenant and c.promotion_id = v_promo.id and c.normalized_code = v_code_norm;
      v_code_status := 'valid';
    end if;

    -- Eligible basis: whole gross for order target; matching lines for variant_scope.
    if v_promo.target_type = 'order' then
      v_basis := v_gross;
    else
      v_basis := 0;
      for v_line in select value from jsonb_array_elements(p_lines) loop
        if promotions_private.line_matches_targets(
          p_tenant, v_promo.id, (v_line->>'productId')::uuid, (v_line->>'variantId')::uuid
        ) then
          v_basis := v_basis + (v_line->>'lineTotalMinor')::bigint;
        end if;
      end loop;
    end if;

    -- Minimum basket applies to the WHOLE order subtotal, not the eligible basis.
    if v_promo.min_subtotal_minor is not null and v_gross < v_promo.min_subtotal_minor then
      continue;
    end if;
    if v_basis <= 0 then
      continue;
    end if;

    if v_promo.benefit_type = 'percentage' then
      v_discount := floor(v_basis::numeric * v_promo.benefit_percent_bp::numeric / 10000)::bigint;
    else
      v_discount := least(v_promo.benefit_amount_minor, v_basis);
    end if;
    if v_promo.max_discount_minor is not null then
      v_discount := least(v_discount, v_promo.max_discount_minor);
    end if;
    -- Clamp so the net order can never go negative.
    v_discount := least(v_discount, v_gross, v_basis);
    if v_discount <= 0 then
      continue;
    end if;

    -- Deterministic tie-break: greater discount; then code over automatic; then earlier created_at; then id.
    v_better := false;
    if not v_have_best then
      v_better := true;
    elsif v_discount > v_best_discount then
      v_better := true;
    elsif v_discount = v_best_discount then
      if v_source = 'code' and v_best_source = 'automatic' then
        v_better := true;
      elsif v_source = v_best_source then
        if v_promo.created_at < v_best_promo.created_at then
          v_better := true;
        elsif v_promo.created_at = v_best_promo.created_at and v_promo.id < v_best_promo.id then
          v_better := true;
        end if;
      end if;
    end if;

    if v_better then
      v_have_best := true;
      v_best_promo := v_promo;
      v_best_source := v_source;
      v_best_discount := v_discount;
      v_best_basis := v_basis;
      if v_source = 'code' then v_best_code := v_code; end if;
    end if;
  end loop;

  if not v_have_best then
    return jsonb_build_object('applied', false, 'codeStatus', v_code_status,
      'grossSubtotalMinor', v_gross, 'discountTotalMinor', 0, 'eligibleBasisMinor', 0,
      'allocations', '[]'::jsonb);
  end if;

  -- Largest-remainder allocation of v_best_discount across the eligible lines (integer minor units).
  v_allocations := promotions_private.allocate(
    p_tenant, v_best_promo.id, v_best_promo.target_type, p_lines, v_best_basis, v_best_discount
  );

  v_result := jsonb_build_object(
    'applied', true,
    'codeStatus', case when v_best_source = 'code' then 'valid' else v_code_status end,
    'promotionId', v_best_promo.id,
    'codeId', case when v_best_source = 'code' then v_best_code.id else null end,
    'promotionName', v_best_promo.name,
    'benefitType', v_best_promo.benefit_type,
    'benefitValue', case when v_best_promo.benefit_type = 'percentage'
      then v_best_promo.benefit_percent_bp::bigint else v_best_promo.benefit_amount_minor end,
    'benefitCurrency', v_best_promo.benefit_currency,
    'codeSnapshot', case when v_best_source = 'code' then v_best_code.normalized_code else null end,
    'targetType', v_best_promo.target_type,
    'grossSubtotalMinor', v_gross,
    'eligibleBasisMinor', v_best_basis,
    'discountTotalMinor', v_best_discount,
    'allocations', v_allocations
  );
  return v_result;
end;
$function$;

-- Deterministic largest-remainder allocation. Σ of returned discountMinor = p_discount exactly.
create function promotions_private.allocate(
  p_tenant uuid, p_promotion uuid, p_target_type text, p_lines jsonb, p_basis bigint, p_discount bigint
) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_line jsonb;
  v_eligible jsonb := '[]'::jsonb;
  v_alloc jsonb := '[]'::jsonb;
  v_base bigint;
  v_assigned bigint := 0;
  v_leftover bigint;
  v_i int;
  v_rec record;
begin
  -- Collect eligible lines (all lines for order target; matching lines for variant_scope) with base
  -- allocation floor(discount * lineTotal / basis) and remainder (discount * lineTotal) % basis.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if p_target_type = 'order' or promotions_private.line_matches_targets(
      p_tenant, p_promotion, (v_line->>'productId')::uuid, (v_line->>'variantId')::uuid
    ) then
      v_base := floor(p_discount::numeric * (v_line->>'lineTotalMinor')::numeric / p_basis::numeric)::bigint;
      v_eligible := v_eligible || jsonb_build_array(jsonb_build_object(
        'ord', (v_line->>'ord')::int,
        'base', v_base,
        'remainder', (p_discount::numeric * (v_line->>'lineTotalMinor')::numeric
          - v_base::numeric * p_basis::numeric)
      ));
      v_assigned := v_assigned + v_base;
    end if;
  end loop;

  v_leftover := p_discount - v_assigned;

  -- Distribute the leftover cents to the largest remainders; ties broken by stable ord ascending.
  v_i := 0;
  for v_rec in
    select (e->>'ord')::int as ord, (e->>'base')::bigint as base, (e->>'remainder')::numeric as rem
    from jsonb_array_elements(v_eligible) e
    order by (e->>'remainder')::numeric desc, (e->>'ord')::int asc
  loop
    v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
      'ord', v_rec.ord,
      'discountMinor', v_rec.base + case when v_i < v_leftover then 1 else 0 end
    ));
    v_i := v_i + 1;
  end loop;

  return (select coalesce(jsonb_agg(a order by (a->>'ord')::int), '[]'::jsonb)
    from jsonb_array_elements(v_alloc) a);
end;
$function$;

-- Sanctioned NET-total writer. Owned by orders_writer; the sole path (besides create_order/cancel) that
-- may touch orders totals, and only to apply the immutable discount. No promotion logic lives here.
create function orders_private.apply_order_discount(
  p_tenant uuid, p_order uuid, p_discount_total bigint
) returns void language plpgsql security definer set search_path = '' as $function$
declare v_gross bigint;
begin
  select gross_subtotal_minor into v_gross from public.orders
    where tenant_id = p_tenant and id = p_order for update;
  if not found then raise exception using errcode = '22023', message = 'order not found'; end if;
  if p_discount_total < 0 or p_discount_total > v_gross then
    raise exception using errcode = '22023', message = 'discount outside gross subtotal';
  end if;
  perform set_config('orders_private.allow_order_write', 'on', true);
  update public.orders
    set discount_total_minor = p_discount_total,
        total_minor = gross_subtotal_minor - p_discount_total,
        updated_at = now()
    where tenant_id = p_tenant and id = p_order;
  perform set_config('orders_private.allow_order_write', 'off', true);
end;
$function$;

-- Consuming placement step. Re-derives everything from the immutable committed order_lines + live
-- config under row locks; increments capacity; snapshots adjustment + redemption; applies the net total.
-- Called exactly once inside the successful, idempotent sale transaction (never on replay).
create function promotions_private.redeem(
  p_tenant uuid, p_order uuid, p_code text
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_order public.orders%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_line record;
  v_eval jsonb;
  v_promo public.promotions%rowtype;
  v_code public.promotion_codes%rowtype;
  v_code_id uuid;
  v_discount bigint;
  v_alloc jsonb;
  v_a jsonb;
  v_line_id uuid;
  v_sum bigint := 0;
  v_adj_id uuid := gen_random_uuid();
begin
  -- The order was created in this same placement transaction (uncontended); capacity serialization is
  -- via the promotion/code row locks below, so a plain read suffices (and needs only SELECT).
  select * into v_order from public.orders where tenant_id = p_tenant and id = p_order;
  if not found then raise exception using errcode = '22023', message = 'order not found'; end if;
  if v_order.status <> 'placed' then raise exception using errcode = '22023', message = 'order not placed'; end if;
  if exists (select 1 from public.order_adjustments where tenant_id = p_tenant and order_id = p_order) then
    raise exception using errcode = '22023', message = 'order already adjusted';
  end if;

  for v_line in
    select line_number, id, variant_id, product_id, quantity, line_total_minor
    from public.order_lines where tenant_id = p_tenant and order_id = p_order order by line_number
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'ord', v_line.line_number, 'orderLineId', v_line.id, 'variantId', v_line.variant_id,
      'productId', v_line.product_id, 'quantity', v_line.quantity, 'lineTotalMinor', v_line.line_total_minor));
  end loop;

  v_eval := promotions_private.evaluate(
    p_tenant, v_order.channel, v_order.currency, v_order.brand_id, v_order.branch_id, v_lines, p_code);

  if (v_eval->>'applied')::boolean is distinct from true then
    return v_eval; -- nothing to consume; no redemption row
  end if;

  -- Lock the winning promotion (and code) and re-verify capacity/lifecycle under the lock. A concurrent
  -- final redemption that just exhausted it surfaces PROMO_CAPACITY so the client re-quotes deterministically.
  select * into v_promo from public.promotions
    where tenant_id = p_tenant and id = (v_eval->>'promotionId')::uuid for update;
  if v_promo.status <> 'active'
    or (v_promo.starts_at is not null and v_promo.starts_at > now())
    or (v_promo.ends_at is not null and v_promo.ends_at <= now())
    or (v_promo.global_redemption_limit is not null and v_promo.redemption_count >= v_promo.global_redemption_limit) then
    raise exception using errcode = 'PR409', message = 'promotion no longer available';
  end if;

  v_code_id := nullif(v_eval->>'codeId', '')::uuid;
  if v_code_id is not null then
    select * into v_code from public.promotion_codes
      where tenant_id = p_tenant and id = v_code_id for update;
    if v_code.status <> 'active'
      or (v_code.max_redemptions is not null and v_code.redemption_count >= v_code.max_redemptions) then
      raise exception using errcode = 'PR409', message = 'promotion code no longer available';
    end if;
  end if;

  v_discount := (v_eval->>'discountTotalMinor')::bigint;
  v_alloc := v_eval->'allocations';

  -- Capacity increments (owner DML; RLS bypassed by owner).
  update public.promotions set redemption_count = redemption_count + 1, updated_at = now()
    where tenant_id = p_tenant and id = v_promo.id;
  if v_code_id is not null then
    update public.promotion_codes set redemption_count = redemption_count + 1, updated_at = now()
      where tenant_id = p_tenant and id = v_code_id;
  end if;

  -- Immutable snapshots.
  insert into public.order_adjustments(
    id, tenant_id, order_id, promotion_id, code_id, promotion_name_snapshot, benefit_type_snapshot,
    benefit_value_snapshot, benefit_currency_snapshot, code_snapshot, target_type_snapshot,
    gross_subtotal_minor, eligible_basis_minor, discount_total_minor)
  values(v_adj_id, p_tenant, p_order, v_promo.id, v_code_id, v_promo.name, v_promo.benefit_type,
    (v_eval->>'benefitValue')::bigint, v_promo.benefit_currency, v_eval->>'codeSnapshot', v_promo.target_type,
    (v_eval->>'grossSubtotalMinor')::bigint, (v_eval->>'eligibleBasisMinor')::bigint, v_discount);

  for v_a in select value from jsonb_array_elements(v_alloc) loop
    if (v_a->>'discountMinor')::bigint = 0 then continue; end if;
    select id into v_line_id from public.order_lines
      where tenant_id = p_tenant and order_id = p_order and line_number = (v_a->>'ord')::int;
    insert into public.order_line_adjustments(tenant_id, order_id, order_line_id, promotion_id, discount_minor)
      values(p_tenant, p_order, v_line_id, v_promo.id, (v_a->>'discountMinor')::bigint);
    v_sum := v_sum + (v_a->>'discountMinor')::bigint;
  end loop;
  if v_sum <> v_discount then
    raise exception using errcode = 'PR500', message = 'allocation did not reconcile to discount total';
  end if;

  insert into public.promotion_redemptions(
    tenant_id, promotion_id, code_id, order_id, customer_id, channel, discount_total_minor)
  values(p_tenant, v_promo.id, v_code_id, p_order, v_order.customer_id, v_order.channel, v_discount);

  perform orders_private.apply_order_discount(p_tenant, p_order, v_discount);
  return v_eval;
end;
$function$;

-- Ownership transfer + boundary grants.
grant create on schema promotions_private to promotions_writer;
alter function promotions_private.line_matches_targets(uuid, uuid, uuid, uuid) owner to promotions_writer;
alter function promotions_private.evaluate(uuid, text, text, uuid, uuid, jsonb, text) owner to promotions_writer;
alter function promotions_private.allocate(uuid, uuid, text, jsonb, bigint, bigint) owner to promotions_writer;
alter function promotions_private.redeem(uuid, uuid, text) owner to promotions_writer;
revoke create on schema promotions_private from promotions_writer;
revoke all on all functions in schema promotions_private from public;

-- apply_order_discount is owned by orders_writer (it alone may touch orders totals).
grant create on schema orders_private to orders_writer;
alter function orders_private.apply_order_discount(uuid, uuid, bigint) owner to orders_writer;
revoke create on schema orders_private from orders_writer;
revoke all on function orders_private.apply_order_discount(uuid, uuid, bigint) from public;
grant usage on schema orders_private to promotions_writer;
grant execute on function orders_private.apply_order_discount(uuid, uuid, bigint) to promotions_writer;
grant select on public.orders to promotions_writer;

-- The online + POS writers reuse the SAME engine: evaluate for previews/placement, redeem for consuming.
grant usage on schema promotions_private to online_writer, pos_sales_writer;
grant execute on function promotions_private.evaluate(uuid, text, text, uuid, uuid, jsonb, text),
  promotions_private.redeem(uuid, uuid, text) to online_writer, pos_sales_writer, promotions_writer;

do $block$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema promotions_private to service_role;
    -- service_role may run the non-consuming quote engine; consumption happens only inside sale RPCs.
    grant execute on function promotions_private.evaluate(uuid, text, text, uuid, uuid, jsonb, text) to service_role;
  end if;
end;
$block$;
