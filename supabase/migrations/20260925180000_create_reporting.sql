-- Phase 2Q-A: operational reporting (read-only). NOT accounting/BI/OLAP/forecasting/profitability.
--
-- Enforcement boundary mirrors every prior domain, inverted for reads: a dedicated non-login
-- reporting_reader role owns the SECURITY DEFINER report functions and holds the MINIMUM SELECT grants
-- (plus permissive read policies) on exactly the canonical tables the reports project. service_role is
-- transport only: it may EXECUTE the sanctioned report RPCs, never DML anything. Every function is
-- SECURITY DEFINER with an empty search_path and fully-qualified names, derives the tenant from the
-- caller-supplied verified id, and performs NO writes.
--
-- Frozen V1 reporting definitions (see docs/reporting/reporting-core.md and ADR-038):
--   * Reporting is tenant-wide only and requires reports.read.
--   * Every monetary result is grouped by currency; currencies are NEVER summed together.
--   * Sales KPIs are computed over Orders currently status='placed'; a later cancel/return does not
--     rewrite historical sales. Gross = Σ gross_subtotal_minor, discount = Σ discount_total_minor,
--     net = Σ total_minor, AOV = round(net/count) (null when count = 0).
--   * Event timestamps: sales orders.placed_at, inventory occurred_at, returns returns.created_at,
--     refunds refunds.settled_at, promotions promotion_redemptions.redeemed_at.
--   * Tenant-local inclusive [startDate, endDate] calendar dates resolve, via tenants.default_timezone,
--     to a half-open UTC instant range [fromInclusive, toExclusive). Weeks start Monday.

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'reporting_reader') then
    create role reporting_reader nologin noinherit nobypassrls;
  end if;
  -- Ownership transfer below requires the migration role to be able to SET ROLE to reporting_reader.
  execute pg_catalog.format('grant reporting_reader to %I with set true', current_user);
end;
$block$;

comment on role reporting_reader is
  'Owns the read-only reporting functions and holds the minimum SELECT grants for reporting projections. Never a login or client role; performs no writes.';

create schema reporting_private;
revoke all on schema reporting_private from public;
grant usage on schema public, reporting_private to reporting_reader;

-- Tenant-wide reporting permission. Reporting is tenant-wide only; brand/branch-only grants are
-- insufficient and there is no scoped reporting in V1. Catalog seed only; never assigned to a Role here.
insert into public.permissions (key, description) values
  ('reports.read', 'Read tenant-wide operational reports (sales, products, inventory, returns, promotions, suppliers).')
on conflict (key) do nothing;

-- ============================================================================================
-- Minimum read surface. reporting_reader is nobypassrls, so RLS-protected tables need BOTH a SELECT
-- grant and a permissive read policy for it. Non-RLS foundational tables use the grant; a redundant
-- policy on them is inert and harmless. This is the ENTIRE set of tables reporting may read.
-- ============================================================================================
do $block$
declare t text;
begin
  foreach t in array array[
    'tenants', 'brands', 'branches', 'registers', 'memberships', 'user_identities',
    'products', 'product_variants', 'inventory_locations', 'inventory_balances',
    'inventory_operations', 'inventory_movements',
    'orders', 'order_lines', 'order_adjustments', 'order_line_adjustments',
    'promotions', 'promotion_codes', 'promotion_redemptions',
    'returns', 'return_lines', 'refunds', 'suppliers'
  ] loop
    execute format('grant select on public.%I to reporting_reader', t);
    execute format('create policy reporting_reader_read on public.%I for select to reporting_reader using (true)', t);
  end loop;
end;
$block$;

-- ============================================================================================
-- Shared helpers.
-- ============================================================================================
-- Canonical transport UTC instant, matching the rest of the platform (…Z millisecond form).
create function reporting_private.iso(p timestamptz) returns text
language sql stable set search_path = '' as $f$
  select pg_catalog.to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$f$;

-- Resolves an inclusive tenant-local [p_from, p_to] calendar range to a half-open UTC instant range
-- [from_ts, to_ts) using tenants.default_timezone. DST is handled by Postgres 'at time zone'.
create function reporting_private.resolve_period(p_tenant uuid, p_from date, p_to date)
returns table (tz text, from_ts timestamptz, to_ts timestamptz)
language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text;
begin
  if p_tenant is null or p_from is null or p_to is null or p_to < p_from then
    raise exception using errcode = '22023', message = 'invalid reporting period';
  end if;
  select default_timezone into v_tz from public.tenants where id = p_tenant;
  if v_tz is null then
    raise exception using errcode = 'RP404', message = 'tenant not found';
  end if;
  tz := v_tz;
  from_ts := (p_from::timestamp) at time zone v_tz;
  to_ts := ((p_to + 1)::timestamp) at time zone v_tz;
  return next;
end;
$f$;

create function reporting_private.period_json(p_tz text, p_from timestamptz, p_to timestamptz)
returns jsonb language sql immutable set search_path = '' as $f$
  select jsonb_build_object('timezone', p_tz,
    'fromInclusive', reporting_private.iso(p_from), 'toExclusive', reporting_private.iso(p_to))
$f$;

-- ============================================================================================
-- SUMMARY: period metadata, sales KPIs by currency, return/refund KPIs, current stock, inventoryAsOf.
-- ============================================================================================
create function reporting_private.report_summary(p_tenant uuid, p_from date, p_to date)
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
          sum(total_minor) net, count(*) cnt
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
create function reporting_private.report_sales(p_tenant uuid, p_from date, p_to date, p_view text, p_bucket text)
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
          currency, sum(gross_subtotal_minor) gross, sum(discount_total_minor) disc, sum(total_minor) net, count(*) cnt
        from public.orders
        where tenant_id = p_tenant and status = 'placed' and placed_at >= v_from and placed_at < v_to
        group by 1, currency) s), '[]'::jsonb);
  elsif p_view = 'channel' then
    v_items := coalesce((
      select jsonb_agg(jsonb_build_object('channel', channel, 'currency', currency,
        'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net, 'orderCount', cnt)
        order by channel, currency)
      from (select channel, currency, sum(gross_subtotal_minor) gross, sum(discount_total_minor) disc,
        sum(total_minor) net, count(*) cnt
        from public.orders where tenant_id = p_tenant and status = 'placed' and placed_at >= v_from and placed_at < v_to
        group by channel, currency) s), '[]'::jsonb);
  elsif p_view = 'brand' then
    v_items := coalesce((
      select jsonb_agg(jsonb_build_object('brandId', brand_id, 'brandName', brand_name, 'currency', currency,
        'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net, 'orderCount', cnt)
        order by brand_name, currency)
      from (select o.brand_id, b.display_name brand_name, o.currency, sum(o.gross_subtotal_minor) gross,
        sum(o.discount_total_minor) disc, sum(o.total_minor) net, count(*) cnt
        from public.orders o join public.brands b on b.tenant_id = o.tenant_id and b.id = o.brand_id
        where o.tenant_id = p_tenant and o.status = 'placed' and o.placed_at >= v_from and o.placed_at < v_to
        group by o.brand_id, b.display_name, o.currency) s), '[]'::jsonb);
  elsif p_view = 'pos_branch' then
    v_items := coalesce((
      select jsonb_agg(jsonb_build_object('branchId', branch_id, 'branchName', branch_name, 'currency', currency,
        'grossSalesMinor', gross, 'discountsMinor', disc, 'netSalesMinor', net, 'orderCount', cnt)
        order by branch_name, currency)
      from (select o.branch_id, br.display_name branch_name, o.currency, sum(o.gross_subtotal_minor) gross,
        sum(o.discount_total_minor) disc, sum(o.total_minor) net, count(*) cnt
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
        sum(o.gross_subtotal_minor) gross, sum(o.discount_total_minor) disc, sum(o.total_minor) net, count(*) cnt
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
        sum(o.gross_subtotal_minor) gross, sum(o.discount_total_minor) disc, sum(o.total_minor) net, count(*) cnt
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

-- ============================================================================================
-- PRODUCTS: units/gross/allocated-discount/net by product or variant, or the precise non-moving
-- signal (no_sales_with_current_stock). Currency-grouped. Offset-paginated.
-- ============================================================================================
create function reporting_private.report_products(
  p_tenant uuid, p_from date, p_to date, p_level text, p_view text, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz; v_items jsonb; v_more boolean;
begin
  if p_level not in ('product', 'variant') then
    raise exception using errcode = '22023', message = 'invalid product level';
  end if;
  if p_view not in ('sales', 'no_sales_with_current_stock') then
    raise exception using errcode = '22023', message = 'invalid product view';
  end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0 then
    raise exception using errcode = '22023', message = 'invalid page';
  end if;
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);

  if p_view = 'sales' then
    if p_level = 'variant' then
      with base as (
        select o.currency,
          ol.variant_id id, ol.sku_snapshot sku, ol.product_id, ol.product_name_snapshot name,
          sum(ol.quantity) units, sum(ol.line_total_minor) gross,
          coalesce(sum(la.discount_minor), 0) disc
        from public.order_lines ol
        join public.orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
        left join public.order_line_adjustments la on la.tenant_id = ol.tenant_id and la.order_line_id = ol.id
        where ol.tenant_id = p_tenant and o.status = 'placed' and o.placed_at >= v_from and o.placed_at < v_to
        group by o.currency, ol.variant_id, ol.sku_snapshot, ol.product_id, ol.product_name_snapshot
        order by gross desc, ol.variant_id, o.currency
        limit p_limit + 1 offset p_offset)
      select coalesce(jsonb_agg(jsonb_build_object('variantId', id, 'sku', sku, 'productId', product_id,
        'productName', name, 'currency', currency, 'unitsSold', units, 'grossSalesMinor', gross,
        'allocatedDiscountsMinor', disc, 'netSalesMinor', gross - disc)) filter (where rn <= p_limit), '[]'::jsonb),
        bool_or(rn > p_limit)
      into v_items, v_more
      from (select *, row_number() over (order by gross desc, id, currency) rn from base) x;
    else
      with base as (
        select o.currency, ol.product_id id, ol.product_name_snapshot name,
          sum(ol.quantity) units, sum(ol.line_total_minor) gross, coalesce(sum(la.discount_minor), 0) disc
        from public.order_lines ol
        join public.orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
        left join public.order_line_adjustments la on la.tenant_id = ol.tenant_id and la.order_line_id = ol.id
        where ol.tenant_id = p_tenant and o.status = 'placed' and o.placed_at >= v_from and o.placed_at < v_to
        group by o.currency, ol.product_id, ol.product_name_snapshot
        order by gross desc, ol.product_id, o.currency
        limit p_limit + 1 offset p_offset)
      select coalesce(jsonb_agg(jsonb_build_object('productId', id, 'productName', name, 'currency', currency,
        'unitsSold', units, 'grossSalesMinor', gross, 'allocatedDiscountsMinor', disc,
        'netSalesMinor', gross - disc)) filter (where rn <= p_limit), '[]'::jsonb),
        bool_or(rn > p_limit)
      into v_items, v_more
      from (select *, row_number() over (order by gross desc, id, currency) rn from base) x;
    end if;
  else -- no_sales_with_current_stock: current on-hand > 0 AND no placed sale line in the period.
    if p_level = 'variant' then
      with base as (
        select v.id, v.sku, v.product_id, p.name product_name, sum(b.on_hand_quantity) onhand
        from public.product_variants v
        join public.inventory_balances b on b.tenant_id = v.tenant_id and b.variant_id = v.id
        join public.products p on p.tenant_id = v.tenant_id and p.id = v.product_id
        where v.tenant_id = p_tenant
          and not exists (select 1 from public.order_lines ol
            join public.orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
            where ol.tenant_id = p_tenant and ol.variant_id = v.id and o.status = 'placed'
              and o.placed_at >= v_from and o.placed_at < v_to)
        group by v.id, v.sku, v.product_id, p.name
        having sum(b.on_hand_quantity) > 0
        order by onhand desc, v.id
        limit p_limit + 1 offset p_offset)
      select coalesce(jsonb_agg(jsonb_build_object('variantId', id, 'sku', sku, 'productId', product_id,
        'productName', product_name, 'onHandQuantity', onhand)) filter (where rn <= p_limit), '[]'::jsonb),
        bool_or(rn > p_limit)
      into v_items, v_more
      from (select *, row_number() over (order by onhand desc, id) rn from base) x;
    else
      with base as (
        select p.id, p.name product_name, sum(b.on_hand_quantity) onhand
        from public.products p
        join public.product_variants v on v.tenant_id = p.tenant_id and v.product_id = p.id
        join public.inventory_balances b on b.tenant_id = v.tenant_id and b.variant_id = v.id
        where p.tenant_id = p_tenant
          and not exists (select 1 from public.order_lines ol
            join public.orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
            where ol.tenant_id = p_tenant and ol.product_id = p.id and o.status = 'placed'
              and o.placed_at >= v_from and o.placed_at < v_to)
        group by p.id, p.name
        having sum(b.on_hand_quantity) > 0
        order by onhand desc, p.id
        limit p_limit + 1 offset p_offset)
      select coalesce(jsonb_agg(jsonb_build_object('productId', id, 'productName', product_name,
        'onHandQuantity', onhand)) filter (where rn <= p_limit), '[]'::jsonb),
        bool_or(rn > p_limit)
      into v_items, v_more
      from (select *, row_number() over (order by onhand desc, id) rn from base) x;
    end if;
  end if;

  return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to),
    'level', p_level, 'view', p_view, 'items', v_items,
    'pageInfo', jsonb_build_object('hasMore', coalesce(v_more, false),
      'nextOffset', case when coalesce(v_more, false) then p_offset + p_limit else null end));
end;
$f$;

-- ============================================================================================
-- INVENTORY: current balances (current state, NOT historical as-of) or event-period movement views.
--   balances | movements | receipts | transfers | adjustments. Branch != Warehouse; Location != Register.
-- ============================================================================================
create function reporting_private.report_inventory(
  p_tenant uuid, p_from date, p_to date, p_view text, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz; v_items jsonb; v_more boolean;
  v_period jsonb; v_types text[];
begin
  if p_view not in ('balances', 'movements', 'receipts', 'transfers', 'adjustments') then
    raise exception using errcode = '22023', message = 'invalid inventory view';
  end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0 then
    raise exception using errcode = '22023', message = 'invalid page';
  end if;

  if p_view = 'balances' then
    v_period := null;
    with base as (
      select b.variant_id, v.sku, v.product_id, p.name product_name,
        b.inventory_location_id, l.display_name location_name, l.branch_id, b.on_hand_quantity, b.version
      from public.inventory_balances b
      join public.product_variants v on v.tenant_id = b.tenant_id and v.id = b.variant_id
      join public.products p on p.tenant_id = v.tenant_id and p.id = v.product_id
      join public.inventory_locations l on l.tenant_id = b.tenant_id and l.id = b.inventory_location_id
      where b.tenant_id = p_tenant
      order by v.sku, b.inventory_location_id
      limit p_limit + 1 offset p_offset)
    select coalesce(jsonb_agg(jsonb_build_object('variantId', variant_id, 'sku', sku, 'productId', product_id,
      'productName', product_name, 'inventoryLocationId', inventory_location_id, 'locationName', location_name,
      'branchId', branch_id, 'onHandQuantity', on_hand_quantity, 'version', version)) filter (where rn <= p_limit), '[]'::jsonb),
      bool_or(rn > p_limit)
    into v_items, v_more
    from (select *, row_number() over (order by sku, inventory_location_id) rn from base) x;
  else
    select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);
    v_period := reporting_private.period_json(v_tz, v_from, v_to);
    if p_view = 'movements' then
      with base as (
        select m.id, o.id operation_id, o.operation_type, o.occurred_at, m.variant_id, v.sku,
          m.inventory_location_id, l.display_name location_name, m.quantity_delta
        from public.inventory_movements m
        join public.inventory_operations o on o.tenant_id = m.tenant_id and o.id = m.operation_id
        join public.product_variants v on v.tenant_id = m.tenant_id and v.id = m.variant_id
        join public.inventory_locations l on l.tenant_id = m.tenant_id and l.id = m.inventory_location_id
        where m.tenant_id = p_tenant and o.occurred_at >= v_from and o.occurred_at < v_to
        order by o.occurred_at, m.id
        limit p_limit + 1 offset p_offset)
      select coalesce(jsonb_agg(jsonb_build_object('operationId', operation_id, 'operationType', operation_type,
        'occurredAt', reporting_private.iso(occurred_at), 'variantId', variant_id, 'sku', sku,
        'inventoryLocationId', inventory_location_id, 'locationName', location_name,
        'quantityDelta', quantity_delta)) filter (where rn <= p_limit), '[]'::jsonb),
        bool_or(rn > p_limit)
      into v_items, v_more
      from (select *, row_number() over (order by occurred_at, id) rn from base) x;
    else
      -- receipts | transfers | adjustments: one operation-summary shape with unitsIn/unitsOut.
      v_types := case p_view when 'receipts' then array['receipt']
        when 'transfers' then array['transfer'] else array['adjustment', 'correction'] end;
      with base as (
        select o.id, o.operation_type, o.occurred_at, o.actor_membership_id, o.notes,
          o.supplier_id, o.supplier_name_snapshot,
          count(m.*) line_count,
          coalesce(sum(m.quantity_delta) filter (where m.quantity_delta > 0), 0) units_in,
          coalesce(sum(-m.quantity_delta) filter (where m.quantity_delta < 0), 0) units_out
        from public.inventory_operations o
        left join public.inventory_movements m on m.tenant_id = o.tenant_id and m.operation_id = o.id
        where o.tenant_id = p_tenant and o.operation_type = any(v_types)
          and o.occurred_at >= v_from and o.occurred_at < v_to
        group by o.id
        order by o.occurred_at, o.id
        limit p_limit + 1 offset p_offset)
      select coalesce(jsonb_agg(jsonb_build_object('operationId', id, 'operationType', operation_type,
        'occurredAt', reporting_private.iso(occurred_at), 'actorMembershipId', actor_membership_id,
        'notes', notes, 'supplierId', supplier_id, 'supplierName', supplier_name_snapshot,
        'lineCount', line_count, 'unitsIn', units_in, 'unitsOut', units_out)) filter (where rn <= p_limit), '[]'::jsonb),
        bool_or(rn > p_limit)
      into v_items, v_more
      from (select *, row_number() over (order by occurred_at, id) rn from base) x;
    end if;
  end if;

  return jsonb_build_object('period', v_period, 'view', p_view, 'items', v_items,
    'asOf', case when p_view = 'balances' then reporting_private.iso(pg_catalog.now()) else null end,
    'pageInfo', jsonb_build_object('hasMore', coalesce(v_more, false),
      'nextOffset', case when coalesce(v_more, false) then p_offset + p_limit else null end));
end;
$f$;

-- ============================================================================================
-- RETURNS: accepted returned value / refund status by currency + disposition, or product/variant
-- breakdown. Returns event period = returns.created_at; succeeded refunds settled_at; pending current.
-- No return-rate KPI in V1.
-- ============================================================================================
create function reporting_private.report_returns(
  p_tenant uuid, p_from date, p_to date, p_view text, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz; v_items jsonb; v_more boolean; v_body jsonb;
begin
  if p_view not in ('summary', 'products', 'variants') then
    raise exception using errcode = '22023', message = 'invalid returns view';
  end if;
  if p_view <> 'summary' and (p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0) then
    raise exception using errcode = '22023', message = 'invalid page';
  end if;
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);

  if p_view = 'summary' then
    v_body := jsonb_build_object(
      'byCurrency', coalesce((
        select jsonb_agg(jsonb_build_object('currency', currency,
          'acceptedReturnedValueMinor', amt, 'returnCount', cnt,
          'succeededRefundMinor', succeeded, 'pendingRefundMinor', pending) order by currency)
        from (
          select r.currency,
            sum(r.amount_minor) amt, count(distinct r.id) cnt,
            coalesce(sum(rf.amount_minor) filter (where rf.status = 'succeeded'), 0) succeeded,
            coalesce(sum(rf.amount_minor) filter (where rf.status = 'pending'), 0) pending
          from public.returns r
          left join public.refunds rf on rf.tenant_id = r.tenant_id and rf.return_id = r.id
          where r.tenant_id = p_tenant and r.created_at >= v_from and r.created_at < v_to
          group by r.currency) q), '[]'::jsonb),
      'byDisposition', coalesce((
        select jsonb_agg(jsonb_build_object('disposition', disposition, 'returnedQuantity', qty) order by disposition)
        from (select rl.disposition, sum(rl.quantity) qty
          from public.return_lines rl
          join public.returns r on r.tenant_id = rl.tenant_id and r.id = rl.return_id
          where rl.tenant_id = p_tenant and r.created_at >= v_from and r.created_at < v_to
          group by rl.disposition) d), '[]'::jsonb));
    return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to), 'view', p_view, 'summary', v_body);
  end if;

  if p_view = 'variants' then
    with base as (
      select r.currency, rl.variant_id id, ol.sku_snapshot sku, ol.product_id, ol.product_name_snapshot name,
        sum(rl.quantity) qty, sum(rl.amount_minor) amt
      from public.return_lines rl
      join public.returns r on r.tenant_id = rl.tenant_id and r.id = rl.return_id
      join public.order_lines ol on ol.tenant_id = rl.tenant_id and ol.id = rl.order_line_id
      where rl.tenant_id = p_tenant and r.created_at >= v_from and r.created_at < v_to
      group by r.currency, rl.variant_id, ol.sku_snapshot, ol.product_id, ol.product_name_snapshot
      order by amt desc, rl.variant_id, r.currency
      limit p_limit + 1 offset p_offset)
    select coalesce(jsonb_agg(jsonb_build_object('variantId', id, 'sku', sku, 'productId', product_id,
      'productName', name, 'currency', currency, 'returnedQuantity', qty,
      'returnedValueMinor', amt)) filter (where rn <= p_limit), '[]'::jsonb), bool_or(rn > p_limit)
    into v_items, v_more
    from (select *, row_number() over (order by amt desc, id, currency) rn from base) x;
  else
    with base as (
      select r.currency, ol.product_id id, ol.product_name_snapshot name,
        sum(rl.quantity) qty, sum(rl.amount_minor) amt
      from public.return_lines rl
      join public.returns r on r.tenant_id = rl.tenant_id and r.id = rl.return_id
      join public.order_lines ol on ol.tenant_id = rl.tenant_id and ol.id = rl.order_line_id
      where rl.tenant_id = p_tenant and r.created_at >= v_from and r.created_at < v_to
      group by r.currency, ol.product_id, ol.product_name_snapshot
      order by amt desc, ol.product_id, r.currency
      limit p_limit + 1 offset p_offset)
    select coalesce(jsonb_agg(jsonb_build_object('productId', id, 'productName', name, 'currency', currency,
      'returnedQuantity', qty, 'returnedValueMinor', amt)) filter (where rn <= p_limit), '[]'::jsonb), bool_or(rn > p_limit)
    into v_items, v_more
    from (select *, row_number() over (order by amt desc, id, currency) rn from base) x;
  end if;

  return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to), 'view', p_view, 'items', v_items,
    'pageInfo', jsonb_build_object('hasMore', coalesce(v_more, false),
      'nextOffset', case when coalesce(v_more, false) then p_offset + p_limit else null end));
end;
$f$;

-- ============================================================================================
-- PROMOTIONS: per-promotion redemption/discount/order metrics from IMMUTABLE redemption + adjustment
-- data, grouped by currency. No ROI/profitability. Cancelled associated Orders reported separately.
-- ============================================================================================
create function reporting_private.report_promotions(p_tenant uuid, p_from date, p_to date)
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
          coalesce(sum(o.total_minor) filter (where o.status = 'placed'), 0) net,
          count(*) filter (where o.status = 'cancelled') cancelled_orders
        from public.promotion_redemptions rd
        join public.orders o on o.tenant_id = rd.tenant_id and o.id = rd.order_id
        left join public.order_adjustments a on a.tenant_id = rd.tenant_id and a.order_id = rd.order_id
        where rd.tenant_id = p_tenant and rd.redeemed_at >= v_from and rd.redeemed_at < v_to
        group by rd.promotion_id, o.currency) s), '[]'::jsonb));
end;
$f$;

-- ============================================================================================
-- SUPPLIERS: receipt count, units received, last receipt over the period. NO spend/value — there is
-- no acquisition cost basis. Reports current supplier name plus the immutable receipt snapshot label.
-- ============================================================================================
create function reporting_private.report_suppliers(
  p_tenant uuid, p_from date, p_to date, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz; v_items jsonb; v_more boolean;
begin
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0 then
    raise exception using errcode = '22023', message = 'invalid page';
  end if;
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);
  with base as (
    select o.supplier_id,
      (pg_catalog.array_agg(s.name order by o.occurred_at desc))[1] supplier_name,
      (pg_catalog.array_agg(o.supplier_name_snapshot order by o.occurred_at desc))[1] supplier_name_snapshot,
      count(distinct o.id) receipt_count,
      coalesce(sum(m.quantity_delta) filter (where m.quantity_delta > 0), 0) units_received,
      max(o.occurred_at) last_receipt_at
    from public.inventory_operations o
    join public.suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
    left join public.inventory_movements m on m.tenant_id = o.tenant_id and m.operation_id = o.id
    where o.tenant_id = p_tenant and o.operation_type = 'receipt' and o.supplier_id is not null
      and o.occurred_at >= v_from and o.occurred_at < v_to
    group by o.supplier_id
    order by units_received desc, o.supplier_id
    limit p_limit + 1 offset p_offset)
  select coalesce(jsonb_agg(jsonb_build_object('supplierId', supplier_id, 'supplierName', supplier_name,
    'supplierNameSnapshot', supplier_name_snapshot, 'receiptCount', receipt_count,
    'unitsReceived', units_received, 'lastReceiptAt', reporting_private.iso(last_receipt_at))) filter (where rn <= p_limit), '[]'::jsonb),
    bool_or(rn > p_limit)
  into v_items, v_more
  from (select *, row_number() over (order by units_received desc, supplier_id) rn from base) x;

  return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to), 'items', v_items,
    'pageInfo', jsonb_build_object('hasMore', coalesce(v_more, false),
      'nextOffset', case when coalesce(v_more, false) then p_offset + p_limit else null end));
end;
$f$;

-- ============================================================================================
-- Ownership + privilege boundary. reporting_reader owns the functions; PUBLIC/anon/authenticated get
-- nothing; service_role may only EXECUTE the sanctioned RPCs (schema usage + per-function execute).
-- ============================================================================================
grant create on schema reporting_private to reporting_reader;
alter function reporting_private.iso(timestamptz) owner to reporting_reader;
alter function reporting_private.resolve_period(uuid, date, date) owner to reporting_reader;
alter function reporting_private.period_json(text, timestamptz, timestamptz) owner to reporting_reader;
alter function reporting_private.report_summary(uuid, date, date) owner to reporting_reader;
alter function reporting_private.report_sales(uuid, date, date, text, text) owner to reporting_reader;
alter function reporting_private.report_products(uuid, date, date, text, text, integer, integer) owner to reporting_reader;
alter function reporting_private.report_inventory(uuid, date, date, text, integer, integer) owner to reporting_reader;
alter function reporting_private.report_returns(uuid, date, date, text, integer, integer) owner to reporting_reader;
alter function reporting_private.report_promotions(uuid, date, date) owner to reporting_reader;
alter function reporting_private.report_suppliers(uuid, date, date, integer, integer) owner to reporting_reader;
revoke create on schema reporting_private from reporting_reader;

revoke all on all functions in schema reporting_private from public, anon, authenticated, service_role;
do $block$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema reporting_private to service_role;
    grant execute on function
      reporting_private.report_summary(uuid, date, date),
      reporting_private.report_sales(uuid, date, date, text, text),
      reporting_private.report_products(uuid, date, date, text, text, integer, integer),
      reporting_private.report_inventory(uuid, date, date, text, integer, integer),
      reporting_private.report_returns(uuid, date, date, text, integer, integer),
      reporting_private.report_promotions(uuid, date, date),
      reporting_private.report_suppliers(uuid, date, date, integer, integer)
    to service_role;
  end if;
end;
$block$;
