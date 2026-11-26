-- ADR-042 §13.4 FIX — AN OFFLINE SALE RESPECTS STOCK ALREADY COMMITTED TO WEBSITE ORDERS (2026-11-15).
-- Forward-only and additive. Nothing applied earlier is edited.
--
-- Found by the real-HTTP shortfall acceptance: a Website COD checkout RESERVES stock (stock_reservations) without
-- reducing inventory_balances.on_hand until fulfilment. record_offline_sale judged sufficiency on on_hand alone,
-- so a stale offline sale of the reserved units looked "sufficient", tried to post the sale, and
-- online_private.protect_committed_stock aborted the WHOLE ingestion ("stock is committed to online orders"):
-- the completed POS sale was refused and stuck on the till instead of being preserved with a shortfall conflict.
--
-- Fix (smallest change): sufficiency uses AVAILABLE = on_hand - active Website commitments at that location.
-- A short line keeps the existing whole-sale behaviour: order + payment(s) (+ debt) recorded exactly once, NO
-- stock movement, order unfulfilled, offline_reconciliations row -> stock_shortfall conflict. The conflict now
-- reports on-hand, committed and available at sync plus the active Website reservations (order ids). Stock is
-- never driven negative, never double-decremented, the Website hold is untouched, nothing is split or granted.

-- =========================================================================================================
-- Part A — committed-to-Website helpers (owned by online_writer, the owner of stock_reservations)
-- =========================================================================================================
create function online_private.offline_committed_quantity(p_tenant uuid, p_variant uuid, p_location uuid)
returns bigint language sql stable security definer set search_path = '' as $function$
  select coalesce(sum(r.quantity - r.consumed_quantity), 0)::bigint from public.stock_reservations r
   where r.tenant_id = p_tenant and r.variant_id = p_variant and r.inventory_location_id = p_location
     and r.status = 'active';
$function$;

create function online_private.offline_committed_reservations(p_tenant uuid, p_variant uuid, p_location uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'orderId', r.order_id, 'orderNumber', o.order_number, 'orderChannel', o.channel,
           'reservedQuantity', r.quantity - r.consumed_quantity, 'reservedAt', r.created_at)
           order by r.created_at, r.id), '[]'::jsonb)
    from public.stock_reservations r
    join public.orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
   where r.tenant_id = p_tenant and r.variant_id = p_variant and r.inventory_location_id = p_location
     and r.status = 'active';
$function$;

grant create on schema online_private to online_writer;
alter function online_private.offline_committed_quantity(uuid, uuid, uuid) owner to online_writer;
alter function online_private.offline_committed_reservations(uuid, uuid, uuid) owner to online_writer;
revoke create on schema online_private from online_writer;
revoke all on function online_private.offline_committed_quantity(uuid, uuid, uuid) from public;
revoke all on function online_private.offline_committed_reservations(uuid, uuid, uuid) from public;
grant usage on schema online_private to offline_pos_writer;
grant execute on function online_private.offline_committed_quantity(uuid, uuid, uuid) to offline_pos_writer;

-- =========================================================================================================
-- Part B — shortfall detector (20261115150000 B.1, using AVAILABLE and reporting Website holds)
-- =========================================================================================================
create or replace function offline_pos_private.conflicts_from_sale_reconciliation()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_ing public.offline_sale_ingestions%rowtype;
  v_grant public.offline_grants%rowtype;
  v_cmd jsonb;
  v_lines jsonb;
  v_line record;
  v_on_hand bigint;
  v_version bigint;
  v_variant jsonb;
  v_since timestamptz;
  v_movements jsonb;
  v_row public.pos_sync_conflicts;
  v_short integer := 0;
  v_committed bigint;
  v_available bigint;
begin
  select * into v_ing from public.offline_sale_ingestions
   where tenant_id = new.tenant_id and id = new.ingestion_id;
  select * into v_grant from public.offline_grants
   where tenant_id = new.tenant_id and id = v_ing.grant_id;
  v_cmd := v_ing.canonical_command::jsonb;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'variantId', l.variant_id, 'quantity', l.quantity) order by l.variant_id), '[]'::jsonb)
    into v_lines
    from (select (e.value->>'variantId')::uuid as variant_id, sum((e.value->>'quantity')::bigint) as quantity
            from pg_catalog.jsonb_array_elements(v_cmd->'lines') e(value) group by 1) l;

  v_row.tenant_id := new.tenant_id;
  v_row.branch_id := v_ing.branch_id;
  v_row.inventory_location_id := v_ing.inventory_location_id;
  v_row.device_id := v_ing.device_id;
  v_row.register_id := v_ing.register_id;
  v_row.grant_id := v_ing.grant_id;
  v_row.source_table := 'offline_reconciliations';
  v_row.source_id := new.id;
  v_row.sync_command_id := v_ing.sync_command_id;
  v_row.local_reference := v_ing.local_sale_id;
  v_row.order_id := new.order_id;
  v_row.payment_id := new.payment_id;
  v_row.currency := v_grant.currency;
  v_row.local_event_at := v_ing.accepted_at;

  if new.reason = 'device_revoked_at_ingestion' then
    v_row.dedupe_key := 'integrity:' || v_ing.sync_command_id::text;
    v_row.kind := 'sync_integrity';
    v_row.reason_code := 'DEVICE_REVOKED_AT_INGESTION';
    v_row.amount_minor := (v_ing.price_provenance->>'totalMinor')::bigint;
    v_row.local_evidence := pg_catalog.jsonb_build_object('localSaleId', v_ing.local_sale_id,
      'acceptedAt', v_ing.accepted_at, 'lines', v_lines);
    v_row.server_evidence := pg_catalog.jsonb_build_object('saleRecorded', true, 'stockPosted', false,
      'orderFulfilled', false, 'reconciliationReason', new.reason);
    perform offline_pos_private.record_sync_conflict(v_row);
    return new;
  end if;

  for v_line in
    select (x.value->>'variantId')::uuid as variant_id, (x.value->>'quantity')::bigint as quantity
      from pg_catalog.jsonb_array_elements(v_lines) x(value)
  loop
    select b.on_hand_quantity, b.version into v_on_hand, v_version
      from public.inventory_balances b
     where b.tenant_id = new.tenant_id and b.variant_id = v_line.variant_id
       and b.inventory_location_id = v_ing.inventory_location_id;
    v_on_hand := coalesce(v_on_hand, 0);
    v_committed := online_private.offline_committed_quantity(new.tenant_id, v_line.variant_id, v_ing.inventory_location_id);
    v_available := v_on_hand - v_committed;
    if v_line.quantity <= v_available then continue; end if;
    v_short := v_short + 1;

    select vv.value into v_variant
      from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) p(value),
           lateral pg_catalog.jsonb_array_elements(p.value->'variants') vv(value)
     where vv.value->>'variantId' = v_line.variant_id::text
     limit 1;
    v_since := coalesce((v_variant->'advisoryInventory'->>'asOf')::timestamptz, v_grant.issued_at);
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'movementId', m.id, 'operationId', o.id, 'operationType', o.operation_type,
             'quantityDelta', m.quantity_delta, 'recordedAt', m.recorded_at,
             'orderId', f.order_id, 'orderChannel', ord.channel) order by m.recorded_at, m.id),
           '[]'::jsonb)
      into v_movements
      from (select * from public.inventory_movements im
             where im.tenant_id = new.tenant_id and im.variant_id = v_line.variant_id
               and im.inventory_location_id = v_ing.inventory_location_id and im.recorded_at > v_since
             order by im.recorded_at, im.id limit 50) m
      join public.inventory_operations o on o.tenant_id = m.tenant_id and o.id = m.operation_id
      left join public.fulfillments f on f.tenant_id = o.tenant_id and f.inventory_operation_id = o.id
      left join public.orders ord on ord.tenant_id = f.tenant_id and ord.id = f.order_id;

    v_row.dedupe_key := 'stock:' || v_ing.sync_command_id::text || ':' || v_line.variant_id::text;
    v_row.kind := 'stock_shortfall';
    v_row.reason_code := 'STOCK_SHORTFALL_AT_SYNC';
    v_row.variant_id := v_line.variant_id;
    v_row.quantity := v_line.quantity - greatest(v_available, 0);
    v_row.amount_minor := null;
    v_row.local_evidence := pg_catalog.jsonb_build_object(
      'localSaleId', v_ing.local_sale_id, 'acceptedAt', v_ing.accepted_at,
      'sku', v_variant->>'sku', 'requestedQuantity', v_line.quantity,
      'cachedOnHand', (v_variant->'advisoryInventory'->>'onHandQuantity')::bigint,
      'cachedBalanceVersion', (v_variant->'advisoryInventory'->>'version')::bigint,
      'cachedAsOf', v_variant->'advisoryInventory'->>'asOf',
      'snapshotIssuedAt', v_grant.issued_at);
    v_row.server_evidence := pg_catalog.jsonb_build_object(
      'canonicalOnHandAtSync', v_on_hand, 'canonicalBalanceVersion', coalesce(v_version, 0),
      'committedToOnlineAtSync', v_committed, 'availableAtSync', v_available,
      'activeOnlineReservations', online_private.offline_committed_reservations(new.tenant_id, v_line.variant_id, v_ing.inventory_location_id),
      'serverCheckedAt', pg_catalog.now(),
      'shortfallQuantity', v_line.quantity - greatest(v_available, 0),
      'interveningMovements', v_movements, 'saleLines', v_lines,
      'saleRecorded', true, 'stockPostedForSale', false, 'orderFulfilled', false,
      'canonicalDisposition',
        'inventory_balances unchanged by this sale and Website holds untouched; the shortfall is reported here and corrected through online inventory/order workflows');
    perform offline_pos_private.record_sync_conflict(v_row);
  end loop;

  if v_short = 0 then
    -- Defensive: a reconciliation with no short line (should not happen at a legacy location).
    v_row.dedupe_key := 'integrity:' || v_ing.sync_command_id::text;
    v_row.kind := 'sync_integrity';
    v_row.reason_code := 'RECONCILIATION_WITHOUT_SHORTFALL';
    v_row.variant_id := null;
    v_row.quantity := null;
    v_row.local_evidence := pg_catalog.jsonb_build_object('localSaleId', v_ing.local_sale_id, 'lines', v_lines);
    v_row.server_evidence := pg_catalog.jsonb_build_object('reconciliationReason', new.reason,
      'saleRecorded', true, 'stockPostedForSale', false);
    perform offline_pos_private.record_sync_conflict(v_row);
  end if;
  return new;
end;
$function$;

-- =========================================================================================================
-- Part C — record_offline_sale (20261115160000 definition; ONLY the sufficiency line changes)
-- =========================================================================================================
create or replace function offline_pos_private.record_offline_sale(p_tenant_id uuid,p_credential_id uuid,p_command jsonb,p_canonical text,p_fingerprint text,p_signature text)
returns table(ingestion_id uuid,sync_status text,order_id uuid,payment_id uuid,fulfillment_id uuid,reconciliation_id uuid,received_at timestamptz)
language plpgsql security definer set search_path='' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_sale_ingestions%rowtype; v_device_status text; v_element jsonb; v_snapshot jsonb;
 v_total numeric:=0; v_quantity bigint; v_variant uuid; v_price bigint; v_price_id uuid; v_order_lines jsonb:='[]'; v_fulfillment_lines jsonb:='[]';
 v_brand uuid; v_order uuid; v_payment uuid; v_fulfillment uuid; v_inventory_operation uuid; v_ingestion uuid; v_reconciliation uuid;
 v_sufficient boolean:=true; v_reason text; v_suffix text; v_received timestamptz:=now(); v_accepted timestamptz; v_sync uuid; v_line record;
 v_paid bigint; v_outstanding bigint; v_installment boolean; v_customer uuid; v_contact jsonb; v_settle bigint;
 v_discount bigint:=0; v_credential text; v_voucher jsonb;
begin
 v_sync := (p_command->>'syncCommandId')::uuid;
 select * into v_existing from public.offline_sale_ingestions where tenant_id=p_tenant_id and sync_command_id=v_sync;
 if found then
   if v_existing.command_fingerprint<>p_fingerprint then raise exception using errcode='ID409',message='offline idempotency conflict'; end if;
   select r.id into v_reconciliation from public.offline_reconciliations r where r.tenant_id=p_tenant_id and r.ingestion_id=v_existing.id;
   return query select v_existing.id,v_existing.sync_status,v_existing.order_id,v_existing.payment_id,v_existing.fulfillment_id,v_reconciliation,v_existing.received_at; return;
 end if;
 select * into v_grant from public.offline_grants where tenant_id=p_tenant_id and id=(p_command->>'grantId')::uuid;
 if not found then raise exception using errcode='OG404',message='grant not found'; end if;
 if (p_command->>'deviceId')::uuid<>v_grant.device_id or (p_command->>'registerId')::uuid<>v_grant.register_id or p_command->>'currency'<>v_grant.currency then raise exception using errcode='OG403',message='grant binding mismatch'; end if;
 if (p_command->>'schemaVersion')::integer<>v_grant.schema_version then raise exception using errcode='OG422',message='schema version unsupported'; end if;
 v_accepted := (p_command->>'acceptedAt')::timestamptz;
 if v_accepted < v_grant.issued_at-interval '5 minutes' or v_accepted>v_grant.accepted_until or v_accepted>v_received+interval '5 minutes' then raise exception using errcode='OG410',message='acceptedAt outside grant authority'; end if;
 select d.status into v_device_status from public.devices d where d.tenant_id=p_tenant_id and d.id=v_grant.device_id;
 perform 1 from public.device_credentials c where c.tenant_id=p_tenant_id and c.id=p_credential_id and c.device_id=v_grant.device_id and c.valid_from<=v_accepted and (c.valid_to is null or c.valid_to>=v_accepted);
 if not found then raise exception using errcode='OS401',message='credential not valid at acceptance'; end if;
 if (p_command->>'offlineSaleOrdinal')::integer>v_grant.max_pending_offline_sales then raise exception using errcode='OL422',message='pending sale limit exceeded'; end if;
 for v_element in select value from pg_catalog.jsonb_array_elements(p_command->'lines') loop
   v_variant:=(v_element->>'variantId')::uuid; v_quantity:=(v_element->>'quantity')::bigint; v_price:=(v_element->>'grantedUnitPriceMinor')::bigint; v_price_id:=(v_element->>'priceId')::uuid;
   if v_quantity<=0 or v_quantity>v_grant.max_quantity_per_line then raise exception using errcode='OL422',message='line quantity limit exceeded'; end if;
   select variant into v_snapshot from (select variants.value variant from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) products(value), lateral pg_catalog.jsonb_array_elements(products.value->'variants') variants(value) where variants.value->>'variantId'=v_variant::text) q;
   if v_snapshot is null or (v_snapshot->>'authorizedUnitPriceMinor')::bigint<>v_price or (v_snapshot->>'priceId')::uuid<>v_price_id or not (v_snapshot->>'active')::boolean then raise exception using errcode='OG422',message='line not authorized by grant'; end if;
   select (product.value->>'brandId')::uuid into v_brand from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) product(value), lateral pg_catalog.jsonb_array_elements(product.value->'variants') variant(value) where variant.value->>'variantId'=v_variant::text;
   v_total:=v_total+v_quantity::numeric*v_price::numeric;
   v_order_lines:=v_order_lines||pg_catalog.jsonb_build_object('variant_id',v_variant,'product_id',(select (product.value->>'productId')::uuid from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) product(value), lateral pg_catalog.jsonb_array_elements(product.value->'variants') variant(value) where variant.value->>'variantId'=v_variant::text),'quantity',v_quantity,'unit_price_minor',v_price,'product_name',(select product.value->>'name' from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) product(value), lateral pg_catalog.jsonb_array_elements(product.value->'variants') variant(value) where variant.value->>'variantId'=v_variant::text),'variant_name',null,'sku',v_snapshot->>'sku','option_summary',v_snapshot->>'optionSummary');
 end loop;
 -- ADR-042 §5 offline voucher: totalMinor is the NET (gross lines - discount); all limits use the net.
 if p_command ? 'voucher' then
   v_discount:=(p_command->'voucher'->>'discountTotalMinor')::bigint;
   if v_discount is null or v_discount<=0 or v_discount>=v_total then raise exception using errcode='OS422',message='offline voucher discount invalid'; end if;
   v_total:=v_total-v_discount;
 end if;
 if v_total::bigint<>(p_command->>'totalMinor')::bigint then raise exception using errcode='OS422',message='offline monetary totals invalid'; end if;

 -- Deposit defaults to the full total (a normal sale); a smaller deposit is an installment.
 v_paid := coalesce((p_command->>'amountPaidMinor')::bigint, v_total::bigint);
 if v_paid < 0 or v_paid > v_total::bigint then raise exception using errcode='OS422',message='offline amount paid out of range'; end if;
 v_installment := v_paid < v_total::bigint;
 v_outstanding := v_total::bigint - v_paid;
 v_settle := v_paid;
 if v_installment then
   v_customer := nullif(p_command->>'customerId','')::uuid;
   if v_customer is null then raise exception using errcode='OS422',message='offline installment requires a customer'; end if;
   if v_paid < 1 then raise exception using errcode='OS422',message='offline installment requires a positive deposit'; end if;
   if coalesce((p_command->>'outstandingMinor')::bigint, -1) <> v_outstanding then raise exception using errcode='OS422',message='offline outstanding mismatch'; end if;
   if not exists(select 1 from public.customers where tenant_id=p_tenant_id and id=v_customer) then raise exception using errcode='OG404',message='customer not found'; end if;
   if v_outstanding > v_grant.max_offline_credit_exposure_minor then raise exception using errcode='OL422',message='offline credit limit exceeded'; end if;
   if coalesce((select sum((i.price_provenance->>'outstandingMinor')::bigint) from public.offline_sale_ingestions i where i.tenant_id=p_tenant_id and i.grant_id=v_grant.id),0)+v_outstanding>v_grant.max_offline_credit_exposure_minor then raise exception using errcode='OL422',message='offline cumulative credit exceeded'; end if;
 end if;

 -- Tenders/cash settle the amount collected now (deposit for an installment, else the full total).
 if p_command ? 'tenders' then
   if coalesce((select sum((t.value->>'amountMinor')::bigint) from pg_catalog.jsonb_array_elements(p_command->'tenders') t(value)),0)<>v_settle then raise exception using errcode='OS422',message='offline tenders do not sum to the amount settled'; end if;
 else
   if (p_command->>'cashReceivedMinor')::bigint-v_settle<>(p_command->>'changeMinor')::bigint or (p_command->>'cashReceivedMinor')::bigint<v_settle then raise exception using errcode='OS422',message='offline monetary totals invalid'; end if;
 end if;
 if v_total>v_grant.max_sale_amount_minor or (p_command->>'cumulativeExposureMinor')::bigint>v_grant.max_cumulative_exposure_minor or (p_command->>'cumulativeExposureMinor')::bigint<v_total then raise exception using errcode='OL422',message='offline exposure limit exceeded'; end if;
 if coalesce((select sum((i.price_provenance->>'totalMinor')::bigint) from public.offline_sale_ingestions i where i.tenant_id=p_tenant_id and i.grant_id=v_grant.id),0)+v_total>v_grant.max_cumulative_exposure_minor then raise exception using errcode='OL422',message='cumulative exposure exceeded'; end if;
 v_suffix:=pg_catalog.md5(p_tenant_id::text||':'||v_sync::text);
 v_order:=orders_private.create_order(p_tenant_id,'pos',v_grant.currency,v_brand,v_grant.branch_id,v_grant.register_id,v_grant.operator_membership_id,'offline-order:'||v_suffix,v_accepted,'Accepted offline; synchronized later.',v_order_lines);
 -- ADR-042 §5/§6: redeem the offline voucher (or record a D-2 exception) before capture, so the order total
 -- equals the amount collected. The admin assertion is checked and consumed here (single use).
 if p_command ? 'voucher' then
   if p_command->'voucher' ? 'policyIssuanceId' then
     -- ADR-042 §13.6 cached policy (no reservation). Credential-gated vouchers are never issued for offline use,
     -- so no admin assertion is consumed on this path. The sale stands at the cashier-recorded price either way.
     v_voucher:=promotions_private.redeem_offline_voucher_cached(p_tenant_id,v_order,v_grant.id,v_sync,p_command->'voucher',v_accepted,pg_catalog.jsonb_build_object('registerId',v_grant.register_id,'deviceId',v_grant.device_id,'localSaleId',p_command->>'localSaleId'));
   else
     -- Superseded reserved-grant voucher (older till). No grant is issued any more, so this resolves to a
     -- deterministic VX_GRANT_INVALID exception; kept so an older till's queued sale is never lost.
     v_credential:=offline_pos_private.consume_admin_assertion(p_tenant_id,v_grant.id,v_sync,p_command->'voucher'->'adminAssertion','promotions.manage');
     v_voucher:=promotions_private.redeem_offline_voucher(p_tenant_id,v_order,v_grant.id,v_sync,p_command->'voucher',v_credential);
   end if;
 end if;
 -- Capture the amount collected now (deposit for an installment, else the full total). Done BEFORE
 -- fulfillment, exactly as the connected path captures before fulfilling.
 if v_installment then
   if p_command ? 'tenders' then
     v_payment:=payments_private.capture_partial_payments(p_tenant_id,v_order,(select jsonb_agg(pg_catalog.jsonb_build_object('method',elem.value->>'method','amount_minor',(elem.value->>'amountMinor')::bigint) || case when elem.value->>'cashReceivedMinor' is not null then pg_catalog.jsonb_build_object('cash_received_minor',(elem.value->>'cashReceivedMinor')::bigint) else '{}'::jsonb end order by elem.ord) from pg_catalog.jsonb_array_elements(p_command->'tenders') with ordinality elem(value,ord)),v_grant.operator_membership_id,'offline-payment:'||v_suffix,v_paid);
   else
     v_payment:=payments_private.capture_partial_payments(p_tenant_id,v_order,pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('method','cash','amount_minor',v_paid,'cash_received_minor',(p_command->>'cashReceivedMinor')::bigint)),v_grant.operator_membership_id,'offline-payment:'||v_suffix,v_paid);
   end if;
 elsif p_command ? 'tenders' then
   v_payment:=payments_private.capture_payments(p_tenant_id,v_order,(select jsonb_agg(pg_catalog.jsonb_build_object('method',elem.value->>'method','amount_minor',(elem.value->>'amountMinor')::bigint) || case when elem.value->>'cashReceivedMinor' is not null then pg_catalog.jsonb_build_object('cash_received_minor',(elem.value->>'cashReceivedMinor')::bigint) else '{}'::jsonb end order by elem.ord) from pg_catalog.jsonb_array_elements(p_command->'tenders') with ordinality elem(value,ord)),v_grant.operator_membership_id,'offline-payment:'||v_suffix);
 else
   v_payment:=payments_private.capture_cash_payment(p_tenant_id,v_order,(p_command->>'cashReceivedMinor')::bigint,v_grant.operator_membership_id,'offline-payment:'||v_suffix);
 end if;
 if v_device_status='revoked' then v_sufficient:=false; v_reason:='device_revoked_at_ingestion';
 else
   for v_element in select value from pg_catalog.jsonb_array_elements(p_command->'lines') loop
     v_quantity:=inventory_private.lock_balance_for_offline_sale(p_tenant_id,(v_element->>'variantId')::uuid,v_grant.inventory_location_id);
     -- AVAILABLE, not on-hand: units held by active Website reservations are not sellable by a stale offline sale.
     if coalesce(v_quantity,0)-online_private.offline_committed_quantity(p_tenant_id,(v_element->>'variantId')::uuid,v_grant.inventory_location_id)<(v_element->>'quantity')::bigint then v_sufficient:=false; end if;
   end loop;
   if not v_sufficient then v_reason:='insufficient_stock_at_ingestion'; end if;
 end if;
 -- ADR-042 §4 stock-grant hook (20261114160000). No-op at legacy locations.
 if v_sufficient then
   v_reason:=inventory_private.consume_offline_stock_grant(p_tenant_id,v_grant.id,v_grant.inventory_location_id,p_command->'lines',v_sync);
   if v_reason is not null then v_sufficient:=false; end if;
 end if;
 if v_sufficient then
   for v_line in select l.id,l.quantity from public.order_lines l where l.tenant_id=p_tenant_id and l.order_id=v_order order by l.line_number loop v_fulfillment_lines:=v_fulfillment_lines||pg_catalog.jsonb_build_object('order_line_id',v_line.id,'quantity',v_line.quantity); end loop;
   select f.fulfillment_id,f.inventory_operation_id into v_fulfillment,v_inventory_operation from fulfillments_private.record_fulfillment(p_tenant_id,v_order,v_grant.inventory_location_id,v_grant.operator_membership_id,'offline-fulfillment:'||v_suffix,v_received,v_fulfillment_lines) f;
 end if;
 -- Installment customer attach + debt recording run AFTER fulfillment (mirroring the connected record_sale
 -- ordering) so online_private.consume_reservations, gated on customer_id, treats this POS order as
 -- reservation-free and does not demand a non-existent stock reservation. Still unconditional within the
 -- transaction, so a needs_reconciliation installment also records the customer debt.
 if v_installment then
   select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('name',c.name,'email',c.email,'phone',c.phone)) into v_contact from public.customers c where c.tenant_id=p_tenant_id and c.id=v_customer;
   perform orders_private.attach_pos_customer(p_tenant_id,v_order,v_customer,v_contact);
   perform customers_ar_private.record_sale_debt(p_tenant_id,v_order,v_customer,v_grant.currency,v_total::bigint,v_paid,v_grant.operator_membership_id);
 end if;
 insert into public.offline_sale_ingestions(tenant_id,grant_id,device_id,credential_id,register_id,branch_id,inventory_location_id,local_sale_id,sync_command_id,command_fingerprint,canonical_command,device_signature_base64,accepted_at,received_at,order_id,payment_id,fulfillment_id,sync_status,price_provenance)
 values(p_tenant_id,v_grant.id,v_grant.device_id,p_credential_id,v_grant.register_id,v_grant.branch_id,v_grant.inventory_location_id,p_command->>'localSaleId',v_sync,p_fingerprint,p_canonical,p_signature,v_accepted,v_received,v_order,v_payment,v_fulfillment,case when v_sufficient then 'synced' else 'needs_reconciliation' end,pg_catalog.jsonb_build_object('grantId',v_grant.id,'snapshotId',v_grant.snapshot_id,'lines',p_command->'lines','totalMinor',v_total::bigint,'amountPaidMinor',v_paid,'outstandingMinor',v_outstanding,'discountTotalMinor',v_discount,'voucher',v_voucher)) returning id into v_ingestion;
 if not v_sufficient then
   insert into public.offline_reconciliations(tenant_id,ingestion_id,local_sale_id,order_id,payment_id,reason) values(p_tenant_id,v_ingestion,p_command->>'localSaleId',v_order,v_payment,v_reason) returning id into v_reconciliation;
   insert into public.offline_reconciliation_events(tenant_id,reconciliation_id,reason) values(p_tenant_id,v_reconciliation,v_reason);
 end if;
 return query select v_ingestion,case when v_sufficient then 'synced' else 'needs_reconciliation' end,v_order,v_payment,v_fulfillment,v_reconciliation,v_received;
exception when unique_violation then
 select * into v_existing from public.offline_sale_ingestions where tenant_id=p_tenant_id and sync_command_id=v_sync;
 if not found or v_existing.command_fingerprint<>p_fingerprint then raise exception using errcode='ID409',message='offline idempotency conflict'; end if;
 select id into v_reconciliation from public.offline_reconciliations where tenant_id=p_tenant_id and ingestion_id=v_existing.id;
 return query select v_existing.id,v_existing.sync_status,v_existing.order_id,v_existing.payment_id,v_existing.fulfillment_id,v_reconciliation,v_existing.received_at;
end;
$function$;
