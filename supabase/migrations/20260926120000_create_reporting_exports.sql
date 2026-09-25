-- Phase 2Q-C: operational reporting CSV EXPORT row sources (read-only). Bounded V1 datasets only:
-- sales-products, inventory-movements, returns, supplier-receipts. NOT a generic export builder; there
-- is no dashboard/promotion/PDF/XLSX/scheduled/SQL export here.
--
-- These are additional SECURITY DEFINER functions in the SAME reporting_private boundary the Phase 2Q-A
-- reporting core established: reporting_reader owns them and already holds the minimum SELECT grants (and
-- permissive read policies) on every table they touch (order_lines, orders, order_line_adjustments,
-- inventory_movements/operations, product_variants, products, inventory_locations, returns, return_lines,
-- refunds, suppliers). service_role is transport only: it may EXECUTE these RPCs, never DML. Each derives
-- the tenant from the caller-supplied verified id, performs NO writes, and reuses the frozen reporting
-- semantics: reporting_private.resolve_period (inclusive tenant-local [from,to] -> half-open UTC via
-- tenants.default_timezone) and reporting_private.iso for the canonical …Z instant form.
--
-- Frozen export definitions (see docs/reporting/reporting-core.md):
--   * Every export requires reports.read (tenant-wide) — the SAME authorization as the JSON reports. No
--     separate export permission exists.
--   * Every monetary row carries its own currency; currencies are NEVER summed or combined.
--   * Row bound: each function is given p_max_rows and materializes at most p_max_rows + 1 rows. If the
--     result would exceed p_max_rows it raises SQLSTATE 'RP413' — it NEVER silently truncates.
--   * Money uses the same immutable/net-discounted basis as the JSON reports; supplier receipts expose NO
--     spend/acquisition/COGS value because no reliable cost basis exists.

-- Shared guard: validate the row bound and raise the explicit RP413 overflow error. Keeping it in one
-- place means every dataset enforces the bound identically and can never diverge into a silent truncation.
create function reporting_private.export_assert_within_bound(p_count bigint, p_max_rows integer)
returns void language plpgsql immutable set search_path = '' as $f$
begin
  if p_max_rows is null or p_max_rows < 1 then
    raise exception using errcode = '22023', message = 'invalid export row bound';
  end if;
  if p_count > p_max_rows then
    raise exception using errcode = 'RP413', message = 'export exceeds the maximum row count';
  end if;
end;
$f$;

-- ============================================================================================
-- SALES-PRODUCTS: product- or variant-level sales facts over placed Orders, identical definitions to the
-- JSON products report (view=sales): units, gross, allocated discount, net = gross - discount, per currency.
-- ============================================================================================
create function reporting_private.export_sales_products(
  p_tenant uuid, p_from date, p_to date, p_level text, p_max_rows integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz; v_rows jsonb; v_count bigint;
begin
  if p_level not in ('product', 'variant') then
    raise exception using errcode = '22023', message = 'invalid product level';
  end if;
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);

  if p_level = 'variant' then
    with base as (
      select o.currency, ol.variant_id, ol.sku_snapshot sku, ol.product_id, ol.product_name_snapshot name,
        sum(ol.quantity) units, sum(ol.line_total_minor) gross, coalesce(sum(la.discount_minor), 0) disc
      from public.order_lines ol
      join public.orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
      left join public.order_line_adjustments la on la.tenant_id = ol.tenant_id and la.order_line_id = ol.id
      where ol.tenant_id = p_tenant and o.status = 'placed' and o.placed_at >= v_from and o.placed_at < v_to
      group by o.currency, ol.variant_id, ol.sku_snapshot, ol.product_id, ol.product_name_snapshot
      order by gross desc, ol.product_id, ol.variant_id, o.currency
      limit p_max_rows + 1)
    select count(*), coalesce(jsonb_agg(jsonb_build_object(
        'productId', product_id, 'productName', name, 'variantId', variant_id, 'sku', sku, 'level', 'variant',
        'currency', currency, 'unitsSold', units, 'grossSalesMinor', gross,
        'allocatedDiscountsMinor', disc, 'netSalesMinor', gross - disc)
      order by gross desc, product_id, variant_id, currency), '[]'::jsonb)
    into v_count, v_rows from base;
  else
    with base as (
      select o.currency, ol.product_id, ol.product_name_snapshot name,
        sum(ol.quantity) units, sum(ol.line_total_minor) gross, coalesce(sum(la.discount_minor), 0) disc
      from public.order_lines ol
      join public.orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
      left join public.order_line_adjustments la on la.tenant_id = ol.tenant_id and la.order_line_id = ol.id
      where ol.tenant_id = p_tenant and o.status = 'placed' and o.placed_at >= v_from and o.placed_at < v_to
      group by o.currency, ol.product_id, ol.product_name_snapshot
      order by gross desc, ol.product_id, o.currency
      limit p_max_rows + 1)
    select count(*), coalesce(jsonb_agg(jsonb_build_object(
        'productId', product_id, 'productName', name, 'variantId', null, 'sku', null, 'level', 'product',
        'currency', currency, 'unitsSold', units, 'grossSalesMinor', gross,
        'allocatedDiscountsMinor', disc, 'netSalesMinor', gross - disc)
      order by gross desc, product_id, currency), '[]'::jsonb)
    into v_count, v_rows from base;
  end if;

  perform reporting_private.export_assert_within_bound(v_count, p_max_rows);
  return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to), 'rows', v_rows);
end;
$f$;

-- ============================================================================================
-- INVENTORY-MOVEMENTS: one row per canonical movement over the period. Occurrence, operation type/id,
-- product/variant/sku, InventoryLocation (NOT a Branch), signed quantity delta, reason note, and the
-- receipt's supplier snapshot where present. NO valuation/cost fields.
-- ============================================================================================
create function reporting_private.export_inventory_movements(
  p_tenant uuid, p_from date, p_to date, p_max_rows integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz; v_rows jsonb; v_count bigint;
begin
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);
  with base as (
    select o.occurred_at, o.operation_type, o.id operation_id, m.variant_id, v.product_id, p.name product_name,
      v.sku, m.inventory_location_id, l.display_name location_name, m.quantity_delta, o.notes,
      o.supplier_id, o.supplier_name_snapshot, m.id movement_id
    from public.inventory_movements m
    join public.inventory_operations o on o.tenant_id = m.tenant_id and o.id = m.operation_id
    join public.product_variants v on v.tenant_id = m.tenant_id and v.id = m.variant_id
    join public.products p on p.tenant_id = v.tenant_id and p.id = v.product_id
    join public.inventory_locations l on l.tenant_id = m.tenant_id and l.id = m.inventory_location_id
    where m.tenant_id = p_tenant and o.occurred_at >= v_from and o.occurred_at < v_to
    order by o.occurred_at, m.id
    limit p_max_rows + 1)
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
      'occurredAt', reporting_private.iso(occurred_at), 'operationType', operation_type,
      'operationId', operation_id, 'productId', product_id, 'productName', product_name,
      'variantId', variant_id, 'sku', sku, 'inventoryLocationId', inventory_location_id,
      'locationName', location_name, 'quantityDelta', quantity_delta, 'notes', notes,
      'supplierId', supplier_id, 'supplierName', supplier_name_snapshot)
    order by occurred_at, movement_id), '[]'::jsonb)
  into v_count, v_rows from base;

  perform reporting_private.export_assert_within_bound(v_count, p_max_rows);
  return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to), 'rows', v_rows);
end;
$f$;

-- ============================================================================================
-- RETURNS: one row per accepted return line over the return-event period (returns.created_at), with the
-- return's single refund (refunds is unique per return) attached as distinct refund columns. The accepted
-- amount is the immutable net-discounted per-line basis (return_lines.amount_minor); the gross line value
-- is NOT reconstructed. Returns and refunds stay distinct: refund columns are return-level and repeat
-- across a return's lines, and are null when no refund exists yet.
-- ============================================================================================
create function reporting_private.export_returns(
  p_tenant uuid, p_from date, p_to date, p_max_rows integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz; v_rows jsonb; v_count bigint;
begin
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);
  with base as (
    select r.id return_id, r.order_id, r.created_at, ol.product_id, ol.product_name_snapshot name,
      rl.variant_id, ol.sku_snapshot sku, r.currency, rl.quantity, rl.amount_minor, rl.disposition,
      rf.id refund_id, rf.status refund_status, rf.amount_minor refund_amount, rf.settled_at, rl.id line_id
    from public.return_lines rl
    join public.returns r on r.tenant_id = rl.tenant_id and r.id = rl.return_id
    join public.order_lines ol on ol.tenant_id = rl.tenant_id and ol.id = rl.order_line_id
    left join public.refunds rf on rf.tenant_id = r.tenant_id and rf.return_id = r.id
    where rl.tenant_id = p_tenant and r.created_at >= v_from and r.created_at < v_to
    order by r.created_at, r.id, rl.id
    limit p_max_rows + 1)
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
      'returnId', return_id, 'orderId', order_id, 'returnCreatedAt', reporting_private.iso(created_at),
      'productId', product_id, 'productName', name, 'variantId', variant_id, 'sku', sku,
      'currency', currency, 'returnedQuantity', quantity, 'acceptedNetReturnAmountMinor', amount_minor,
      'disposition', disposition, 'refundId', refund_id, 'refundStatus', refund_status,
      'refundAmountMinor', refund_amount,
      'refundSettledAt', case when settled_at is null then null else reporting_private.iso(settled_at) end)
    order by created_at, return_id, line_id), '[]'::jsonb)
  into v_count, v_rows from base;

  perform reporting_private.export_assert_within_bound(v_count, p_max_rows);
  return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to), 'rows', v_rows);
end;
$f$;

-- ============================================================================================
-- SUPPLIER-RECEIPTS: one row per received unit-movement line on supplier-attributed receipt operations
-- over the period. Operation id + occurrence, current supplier name AND immutable receipt snapshot label,
-- product/variant/sku, units received, InventoryLocation. NO supplier spend / acquisition value / COGS.
-- ============================================================================================
create function reporting_private.export_supplier_receipts(
  p_tenant uuid, p_from date, p_to date, p_max_rows integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
declare v_tz text; v_from timestamptz; v_to timestamptz; v_rows jsonb; v_count bigint;
begin
  select tz, from_ts, to_ts into v_tz, v_from, v_to from reporting_private.resolve_period(p_tenant, p_from, p_to);
  with base as (
    select o.id operation_id, o.occurred_at, o.supplier_id, s.name supplier_name,
      o.supplier_name_snapshot, v.product_id, p.name product_name, m.variant_id, v.sku,
      m.quantity_delta units_received, m.inventory_location_id, l.display_name location_name, m.id movement_id
    from public.inventory_operations o
    join public.suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
    join public.inventory_movements m on m.tenant_id = o.tenant_id and m.operation_id = o.id
    join public.product_variants v on v.tenant_id = m.tenant_id and v.id = m.variant_id
    join public.products p on p.tenant_id = v.tenant_id and p.id = v.product_id
    join public.inventory_locations l on l.tenant_id = m.tenant_id and l.id = m.inventory_location_id
    where o.tenant_id = p_tenant and o.operation_type = 'receipt' and o.supplier_id is not null
      and m.quantity_delta > 0 and o.occurred_at >= v_from and o.occurred_at < v_to
    order by o.occurred_at, o.id, m.id
    limit p_max_rows + 1)
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
      'operationId', operation_id, 'occurredAt', reporting_private.iso(occurred_at),
      'supplierId', supplier_id, 'supplierName', supplier_name, 'supplierNameSnapshot', supplier_name_snapshot,
      'productId', product_id, 'productName', product_name, 'variantId', variant_id, 'sku', sku,
      'unitsReceived', units_received, 'inventoryLocationId', inventory_location_id, 'locationName', location_name)
    order by occurred_at, operation_id, movement_id), '[]'::jsonb)
  into v_count, v_rows from base;

  perform reporting_private.export_assert_within_bound(v_count, p_max_rows);
  return jsonb_build_object('period', reporting_private.period_json(v_tz, v_from, v_to), 'rows', v_rows);
end;
$f$;

-- ============================================================================================
-- Ownership + privilege boundary, identical in shape to the Phase 2Q-A reporting core: reporting_reader
-- owns every function; PUBLIC/anon/authenticated get nothing; service_role may only EXECUTE the sanctioned
-- export RPCs. (The reporting_private schema usage grant for service_role already exists.)
-- ============================================================================================
alter function reporting_private.export_assert_within_bound(bigint, integer) owner to reporting_reader;
alter function reporting_private.export_sales_products(uuid, date, date, text, integer) owner to reporting_reader;
alter function reporting_private.export_inventory_movements(uuid, date, date, integer) owner to reporting_reader;
alter function reporting_private.export_returns(uuid, date, date, integer) owner to reporting_reader;
alter function reporting_private.export_supplier_receipts(uuid, date, date, integer) owner to reporting_reader;

revoke all on function
  reporting_private.export_assert_within_bound(bigint, integer),
  reporting_private.export_sales_products(uuid, date, date, text, integer),
  reporting_private.export_inventory_movements(uuid, date, date, integer),
  reporting_private.export_returns(uuid, date, date, integer),
  reporting_private.export_supplier_receipts(uuid, date, date, integer)
from public, anon, authenticated, service_role;

do $block$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      reporting_private.export_sales_products(uuid, date, date, text, integer),
      reporting_private.export_inventory_movements(uuid, date, date, integer),
      reporting_private.export_returns(uuid, date, date, integer),
      reporting_private.export_supplier_receipts(uuid, date, date, integer)
    to service_role;
  end if;
end;
$block$;
