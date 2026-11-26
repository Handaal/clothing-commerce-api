-- Reporting: "net sales" excludes website delivery fees.
--
-- Since 20261119130000 an order's total_minor = gross_subtotal_minor - discount_total_minor
-- + delivery_fee_minor. The reporting RPCs summed total_minor as net sales, so every online order's
-- delivery fee was counted as merchandise revenue (summary KPIs, average order value, every sales
-- view and the promotions report). Net now means merchandise after discounts:
--   net = Σ (total_minor - delivery_fee_minor)  (= Σ gross_subtotal_minor - Σ discount_total_minor)
-- matching the product-level exports, which already report net as gross - discounts.
-- `create or replace` keeps each function's owner (reporting_reader) and its EXECUTE grants.

create or replace function reporting_private.report_summary(p_tenant uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz;
begin
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);
  return jsonb_build_object(
    'period', reporting_private.period_json(v_tz, v_from, v_to),
    'salesByCurrency', coalesce((
      select jsonb_agg(jsonb_build_object(
        'currency', currency,
        'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net,
        'orderCount', cnt,
        'averageOrderValueMinor', case when cnt = 0 then null else pg_catalog.round(net::numeric / cnt)::bigint end
      ) order by currency)
      from (
        select currency, sum(gross_subtotal_minor) gross, sum(discount_total_minor) disc,
          sum(total_minor - delivery_fee_minor) net, count(*) cnt
        from public.orders
        where tenant_id = p_tenant and status = 'placed' and placed_at >= v_from and placed_at < v_to
        group by currency
      ) s), '[]'::jsonb),
    'returns', jsonb_build_object(
      'byCurrency', coalesce((
        select jsonb_agg(jsonb_build_object('currency', currency,
          'acceptedReturnedValueMinor', amt, 'returnCount', cnt) order by currency)
        from (select currency, sum(amount_minor) amt, count(*) cnt from public.returns
          where tenant_id = p_tenant and created_at >= v_from and created_at < v_to
          group by currency) r), '[]'::jsonb),
      -- succeededRefundMinor is period-bound (settled_at); pendingRefundMinor is the CURRENT obligation
      -- (all pending refunds, independent of the period) — a separate current metric by design.
      'refundsByCurrency', coalesce((
        select jsonb_agg(jsonb_build_object('currency', currency,
          'succeededRefundMinor', succeeded, 'pendingRefundMinor', pending) order by currency)
        from (
          select currency,
            sum(case when status = 'succeeded' and settled_at >= v_from and settled_at < v_to then amount_minor else 0 end) succeeded,
            sum(case when status = 'pending' then amount_minor else 0 end) pending
          from public.refunds
          where tenant_id = p_tenant
            and ((status = 'succeeded' and settled_at >= v_from and settled_at < v_to) or status = 'pending')
          group by currency
        ) f), '[]'::jsonb)
    ),
    'stock', (
      select jsonb_build_object(
        'totalOnHandQuantity', coalesce(sum(on_hand_quantity), 0),
        'variantCount', count(distinct variant_id),
        'locationCount', count(distinct inventory_location_id))
      from public.inventory_balances where tenant_id = p_tenant),
    'inventoryAsOf', reporting_private.iso(pg_catalog.now())
  );
end;
$f$;

-- ============================================================================================
-- SALES: currency-grouped metrics over placed Orders, by one bounded view.
--   trend (bucket day|week|month), channel, brand, pos_branch, pos_register, pos_operator.
-- "sales by branch" means POS sales by branch; ONLINE orders carry no branch/register/operator.
-- ============================================================================================
create or replace function reporting_private.report_sales(p_tenant uuid, p_from date, p_to date, p_view text, p_bucket text)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz; v_items jsonb;
begin
  if p_view not in ('trend', 'channel', 'brand', 'pos_branch', 'pos_register', 'pos_operator') then
    raise exception using errcode = '22023', message = 'invalid sales view';
  end if;
  if p_view = 'trend' and coalesce(p_bucket, 'day') not in ('day', 'week', 'month') then
    raise exception using errcode = '22023', message = 'invalid trend bucket';
  end if;
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);

  if p_view = 'trend' then
    v_items := coalesce((
      select jsonb_agg(jsonb_build_object('bucketStart', bucket, 'currency', currency,
        'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net, 'orderCount', cnt)
        order by bucket, currency)
      from (
        select pg_catalog.to_char(pg_catalog.date_trunc(coalesce(p_bucket, 'day'), (placed_at at time zone v_tz)), 'YYYY-MM-DD') bucket,
          currency, sum(gross_subtotal_minor) gross, sum(discount_total_minor) disc, sum(total_minor - delivery_fee_minor) net, count(*) cnt
        from public.orders
        where tenant_id = p_tenant and status = 'placed' and placed_at >= v_from and placed_at < v_to
        group by 1, currency) s), '[]'::jsonb);
  elsif p_view = 'channel' then
    v_items := coalesce((
      select jsonb_agg(jsonb_build_object('channel', channel, 'currency', currency,
        'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net, 'orderCount', cnt)
        order by channel, currency)
      from (select channel, currency, sum(gross_subtotal_minor) gross, sum(discount_total_minor) disc,
        sum(total_minor - delivery_fee_minor) net, count(*) cnt
        from public.orders where tenant_id = p_tenant and status = 'placed' and placed_at >= v_from and placed_at < v_to
        group by channel, currency) s), '[]'::jsonb);
  elsif p_view = 'brand' then
    v_items := coalesce((
      select jsonb_agg(jsonb_build_object('brandId', brand_id, 'brandName', brand_name, 'currency', currency,
        'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net, 'orderCount', cnt)
        order by brand_name, currency)
      from (select o.brand_id, b.display_name brand_name, o.currency, sum(o.gross_subtotal_minor) gross,
        sum(o.discount_total_minor) disc, sum(o.total_minor - o.delivery_fee_minor) net, count(*) cnt
        from public.orders o join public.brands b on b.tenant_id = o.tenant_id and b.id = o.brand_id
        where o.tenant_id = p_tenant and o.status = 'placed' and o.placed_at >= v_from and o.placed_at < v_to
        group by o.brand_id, b.display_name, o.currency) s), '[]'::jsonb);
  elsif p_view = 'pos_branch' then
    v_items := coalesce((
      select jsonb_agg(jsonb_build_object('branchId', branch_id, 'branchName', branch_name, 'currency', currency,
        'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net, 'orderCount', cnt)
        order by branch_name, currency)
      from (select o.branch_id, br.display_name branch_name, o.currency, sum(o.gross_subtotal_minor) gross,
        sum(o.discount_total_minor) disc, sum(o.total_minor - o.delivery_fee_minor) net, count(*) cnt
        from public.orders o join public.branches br on br.tenant_id = o.tenant_id and br.id = o.branch_id
        where o.tenant_id = p_tenant and o.channel = 'pos' and o.status = 'placed'
          and o.placed_at >= v_from and o.placed_at < v_to
        group by o.branch_id, br.display_name, o.currency) s), '[]'::jsonb);
  elsif p_view = 'pos_register' then
    v_items := coalesce((
      select jsonb_agg(jsonb_build_object('registerId', register_id, 'registerName', register_name,
        'branchId', branch_id, 'currency', currency,
        'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net, 'orderCount', cnt)
        order by register_name, currency)
      from (select o.register_id, rg.display_name register_name, o.branch_id, o.currency,
        sum(o.gross_subtotal_minor) gross, sum(o.discount_total_minor) disc, sum(o.total_minor - o.delivery_fee_minor) net, count(*) cnt
        from public.orders o join public.registers rg on rg.tenant_id = o.tenant_id and rg.id = o.register_id
        where o.tenant_id = p_tenant and o.channel = 'pos' and o.status = 'placed'
          and o.placed_at >= v_from and o.placed_at < v_to
        group by o.register_id, rg.display_name, o.branch_id, o.currency) s), '[]'::jsonb);
  else -- pos_operator: operator/staff is only reliably attributed for POS.
    v_items := coalesce((
      select jsonb_agg(jsonb_build_object('membershipId', actor_membership_id, 'operatorName', operator_name,
        'currency', currency, 'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net, 'orderCount', cnt)
        order by coalesce(operator_name, ''), currency)
      from (select o.actor_membership_id, ui.display_name operator_name, o.currency,
        sum(o.gross_subtotal_minor) gross, sum(o.discount_total_minor) disc, sum(o.total_minor - o.delivery_fee_minor) net, count(*) cnt
        from public.orders o
        left join public.memberships m on m.tenant_id = o.tenant_id and m.id = o.actor_membership_id
        left join public.user_identities ui on ui.id = m.user_identity_id
        where o.tenant_id = p_tenant and o.channel = 'pos' and o.status = 'placed'
          and o.placed_at >= v_from and o.placed_at < v_to
        group by o.actor_membership_id, ui.display_name, o.currency) s), '[]'::jsonb);
  end if;

  return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to),
    'view', p_view, 'bucket', case when p_view = 'trend' then coalesce(p_bucket, 'day') else null end,
    'items', v_items);
end;
$f$;
create or replace function reporting_private.report_promotions(p_tenant uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz;
begin
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);
  return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'promotionId', promotion_id, 'promotionName', promotion_name, 'codeSnapshot', code_snapshot,
        'currency', currency, 'redemptionCount', redemptions, 'discountAmountMinor', discount,
        'orderCount', placed_orders, 'grossSalesMinor', gross, 'netSalesMinor', net,
        'cancelledOrderCount', cancelled_orders) order by promotion_name, currency)
      from (
        select rd.promotion_id, o.currency,
          (pg_catalog.array_agg(a.promotion_name_snapshot order by a.created_at desc))[1] promotion_name,
          (pg_catalog.array_agg(a.code_snapshot order by a.created_at desc))[1] code_snapshot,
          count(*) redemptions,
          sum(rd.discount_total_minor) discount,
          count(*) filter (where o.status = 'placed') placed_orders,
          coalesce(sum(o.gross_subtotal_minor) filter (where o.status = 'placed'), 0) gross,
          coalesce(sum(o.total_minor - o.delivery_fee_minor) filter (where o.status = 'placed'), 0) net,
          count(*) filter (where o.status = 'cancelled') cancelled_orders
        from public.promotion_redemptions rd
        join public.orders o on o.tenant_id = rd.tenant_id and o.id = rd.order_id
        left join public.order_adjustments a on a.tenant_id = rd.tenant_id and a.order_id = rd.order_id
        where rd.tenant_id = p_tenant and rd.redeemed_at >= v_from and rd.redeemed_at < v_to
        group by rd.promotion_id, o.currency) s), '[]'::jsonb));
end;
$f$;
