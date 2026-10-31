-- Phase D — offline installments.
--
-- Extends the signed offline-sale authority so a till can accept a customer installment while OFFLINE:
-- the signed command may now carry an optional (customerId, amountPaidMinor, outstandingMinor) triple
-- (see canonicalizeOfflineSaleCommand — a fully-settled sale omits them and signs byte-identically). On
-- ingest, an installment captures only the deposit (payments_private.capture_partial_payments), attaches
-- the customer, and records the unpaid remainder as a customer debt (customers_ar_private.record_sale_debt),
-- exactly as the CONNECTED installment path (record_sale) already does. Unpaid offline credit is bounded
-- by a NEW dedicated policy cap, max_offline_credit_exposure_minor, separate from the cash-sale
-- cumulative-exposure cap. The offline bootstrap also now ships the tenant's customers with their current
-- outstanding so the cashier can attach installments and show running tabs offline.

-- --------------------------------------------------------------------------------------------------
-- Policy + grant columns: the offline credit cap.
-- --------------------------------------------------------------------------------------------------
alter table public.offline_pos_policies
  add column if not exists max_offline_credit_exposure_minor bigint not null default 0;
alter table public.offline_pos_policies
  add constraint offline_pos_policies_credit_nonneg check (max_offline_credit_exposure_minor >= 0);

alter table public.offline_grants
  add column if not exists max_offline_credit_exposure_minor bigint not null default 0;
alter table public.offline_grants
  add column if not exists customers_snapshot jsonb not null default '[]'::jsonb;
alter table public.offline_grants
  add constraint offline_grants_credit_nonneg check (max_offline_credit_exposure_minor >= 0);

-- --------------------------------------------------------------------------------------------------
-- Customer snapshot for the offline bootstrap: EVERY tenant customer with their current outstanding
-- (0 when they have no A/R activity), so the till can attach an installment to anyone and show tabs.
-- Owned by the A/R role (which already reads customers + debts); callers gated by EXECUTE.
-- --------------------------------------------------------------------------------------------------
create function customers_ar_private.offline_customer_snapshot(p_tenant uuid)
returns jsonb language sql security definer set search_path = '' as $f$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'customerId', c.id,
    'name', c.name,
    'phone', c.phone,
    'outstandingMinor', customers_ar_private.customer_outstanding(p_tenant, c.id)
  ) order by c.name, c.id), '[]'::jsonb)
  from public.customers c
  where c.tenant_id = p_tenant
$f$;
alter function customers_ar_private.offline_customer_snapshot(uuid) owner to customers_ar_writer;
revoke all on function customers_ar_private.offline_customer_snapshot(uuid) from public;
grant execute on function customers_ar_private.offline_customer_snapshot(uuid) to offline_pos_writer;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function customers_ar_private.offline_customer_snapshot(uuid) to service_role';
  end if;
end
$block$;

-- --------------------------------------------------------------------------------------------------
-- Grants the installment ingest branch needs: the deposit capture, customer attach, debt recording,
-- and a read of public.customers (to validate ownership + build the contact snapshot).
-- --------------------------------------------------------------------------------------------------
-- issue_grant and record_offline_sale now reach into the A/R schema (snapshot + debt recording), so the
-- offline writer needs USAGE on it in addition to EXECUTE on the specific functions below.
grant usage on schema customers_ar_private to offline_pos_writer;
grant execute on function payments_private.capture_partial_payments(uuid, uuid, jsonb, uuid, text, bigint)
  to offline_pos_writer;
grant execute on function orders_private.attach_pos_customer(uuid, uuid, uuid, jsonb)
  to offline_pos_writer;
grant execute on function customers_ar_private.record_sale_debt(uuid, uuid, uuid, text, bigint, bigint, uuid)
  to offline_pos_writer;
grant select on public.customers to offline_pos_writer;
create policy offline_writer_customers on public.customers
  for select to offline_pos_writer using (true);

-- --------------------------------------------------------------------------------------------------
-- issue_grant: copy the new cap from the policy and embed the customer snapshot. Body is otherwise the
-- original (catalog build + binding checks unchanged); only the two columns below are added.
-- --------------------------------------------------------------------------------------------------
create or replace function offline_pos_private.issue_grant(p_tenant_id uuid,p_device_id uuid,p_register_id uuid,p_operator_membership_id uuid,p_idempotency_key text)
returns setof public.offline_grants language plpgsql security definer set search_path='' as $function$
declare v_policy public.offline_pos_policies%rowtype; v_branch uuid; v_location uuid; v_currency text; v_grant public.offline_grants%rowtype; v_now timestamptz:=now(); v_catalog jsonb; v_customers jsonb; v_fingerprint text:=pg_catalog.md5(p_device_id::text||E'\n'||p_register_id::text||E'\n'||p_operator_membership_id::text);
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text||':'||lower(btrim(p_idempotency_key)),0));
 select * into v_grant from public.offline_grants where tenant_id=p_tenant_id and normalized_issuance_idempotency_key=lower(btrim(p_idempotency_key));
 if found then
  if v_grant.issuance_fingerprint<>v_fingerprint then raise exception using errcode='ID409',message='grant issuance idempotency conflict'; end if;
  return next v_grant; return;
 end if;
 select branch_id,default_inventory_location_id,selling_currency into v_branch,v_location,v_currency from public.registers where tenant_id=p_tenant_id and id=p_register_id and status='active';
 if not found then raise exception using errcode='OD404',message='register not found'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text||':'||v_location::text,0));
 select * into v_policy from public.offline_pos_policies where tenant_id=p_tenant_id and register_id=p_register_id;
 if not found or not v_policy.enabled then raise exception using errcode='OP403',message='offline selling disabled'; end if;
 perform 1 from public.devices d join public.register_device_assignments a on a.tenant_id=d.tenant_id and a.device_id=d.id and a.unassigned_at is null
 where d.tenant_id=p_tenant_id and d.id=p_device_id and d.status='active' and a.register_id=p_register_id;
 if not found then raise exception using errcode='OD410',message='device unavailable'; end if;
 if exists(select 1 from public.offline_grants g join public.devices d on d.tenant_id=g.tenant_id and d.id=g.device_id and d.status='active' where g.tenant_id=p_tenant_id and g.inventory_location_id=v_location and g.device_id<>p_device_id and g.accepted_until>v_now) then
   raise exception using errcode='OL409',message='location already has active offline authority';
 end if;
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'productId',p.id,'brandId',p.brand_id,'name',p.name,'active',p.status='active',
   'variants',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'variantId',pv.id,'sku',pv.sku,'optionSummary',pv.display_name,
      'active',(p.status='active' and pv.status='active'),
      'authorizedUnitPriceMinor',vp.amount_minor,'priceId',vp.id,'priceVersion',vp.updated_at,
      'advisoryInventory',pg_catalog.jsonb_build_object('onHandQuantity',coalesce(ib.on_hand_quantity,0),'version',coalesce(ib.version,0),'asOf',coalesce(ib.updated_at,v_now))
    ) order by pv.sku,pv.id),'[]'::jsonb)
    from public.product_variants pv
    join public.variant_prices vp on vp.tenant_id=pv.tenant_id and vp.variant_id=pv.id and vp.currency=v_currency and vp.status='active'
    left join public.inventory_balances ib on ib.tenant_id=pv.tenant_id and ib.variant_id=pv.id and ib.inventory_location_id=v_location
    where pv.tenant_id=p_tenant_id and pv.product_id=p.id)
  ) order by p.name,p.id),'[]'::jsonb) into v_catalog
 from public.products p
 where p.tenant_id=p_tenant_id
   and exists(select 1 from public.branch_brands bb where bb.tenant_id=p_tenant_id and bb.branch_id=v_branch and bb.brand_id=p.brand_id)
   and exists(select 1 from public.product_variants pv join public.variant_prices vp on vp.tenant_id=pv.tenant_id and vp.variant_id=pv.id and vp.currency=v_currency and vp.status='active' where pv.tenant_id=p_tenant_id and pv.product_id=p.id);
 v_customers := customers_ar_private.offline_customer_snapshot(p_tenant_id);
 insert into public.offline_grants(tenant_id,device_id,register_id,branch_id,inventory_location_id,operator_membership_id,currency,
   operator_expires_at,catalog_valid_until,accepted_until,max_sale_amount_minor,max_cumulative_exposure_minor,max_quantity_per_line,max_pending_offline_sales,max_offline_credit_exposure_minor,catalog_snapshot,customers_snapshot,issuance_idempotency_key,issuance_fingerprint)
 values(p_tenant_id,p_device_id,p_register_id,v_branch,v_location,p_operator_membership_id,v_currency,
   v_now+pg_catalog.make_interval(secs=>v_policy.operator_lease_seconds),v_now+pg_catalog.make_interval(secs=>v_policy.catalog_grant_seconds),
   least(v_now+pg_catalog.make_interval(secs=>v_policy.operator_lease_seconds),v_now+pg_catalog.make_interval(secs=>v_policy.catalog_grant_seconds)),
   v_policy.max_sale_amount_minor,v_policy.max_cumulative_exposure_minor,v_policy.max_quantity_per_line,v_policy.max_pending_offline_sales,v_policy.max_offline_credit_exposure_minor,v_catalog,v_customers,p_idempotency_key,v_fingerprint) returning * into v_grant;
 return next v_grant;
end;
$function$;

-- --------------------------------------------------------------------------------------------------
-- record_offline_sale: add the installment branch. A fully-settled command (no amountPaidMinor) keeps
-- its exact prior behaviour. When amountPaidMinor < totalMinor the sale is an installment: a customer is
-- mandatory, the tenders/cash settle only the deposit, the deposit is captured through
-- capture_partial_payments, the customer is attached, and the remainder is recorded as a debt and
-- validated against the offline credit cap.
-- --------------------------------------------------------------------------------------------------
create or replace function offline_pos_private.record_offline_sale(p_tenant_id uuid,p_credential_id uuid,p_command jsonb,p_canonical text,p_fingerprint text,p_signature text)
returns table(ingestion_id uuid,sync_status text,order_id uuid,payment_id uuid,fulfillment_id uuid,reconciliation_id uuid,received_at timestamptz)
language plpgsql security definer set search_path='' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_sale_ingestions%rowtype; v_device_status text; v_element jsonb; v_snapshot jsonb;
 v_total numeric:=0; v_quantity bigint; v_variant uuid; v_price bigint; v_price_id uuid; v_order_lines jsonb:='[]'; v_fulfillment_lines jsonb:='[]';
 v_brand uuid; v_order uuid; v_payment uuid; v_fulfillment uuid; v_inventory_operation uuid; v_ingestion uuid; v_reconciliation uuid;
 v_sufficient boolean:=true; v_reason text; v_suffix text; v_received timestamptz:=now(); v_accepted timestamptz; v_sync uuid; v_line record;
 v_paid bigint; v_outstanding bigint; v_installment boolean; v_customer uuid; v_contact jsonb; v_settle bigint;
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
 if v_installment then
   if p_command ? 'tenders' then
     v_payment:=payments_private.capture_partial_payments(p_tenant_id,v_order,(select jsonb_agg(pg_catalog.jsonb_build_object('method',elem.value->>'method','amount_minor',(elem.value->>'amountMinor')::bigint) || case when elem.value->>'cashReceivedMinor' is not null then pg_catalog.jsonb_build_object('cash_received_minor',(elem.value->>'cashReceivedMinor')::bigint) else '{}'::jsonb end order by elem.ord) from pg_catalog.jsonb_array_elements(p_command->'tenders') with ordinality elem(value,ord)),v_grant.operator_membership_id,'offline-payment:'||v_suffix,v_paid);
   else
     v_payment:=payments_private.capture_partial_payments(p_tenant_id,v_order,pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('method','cash','amount_minor',v_paid,'cash_received_minor',(p_command->>'cashReceivedMinor')::bigint)),v_grant.operator_membership_id,'offline-payment:'||v_suffix,v_paid);
   end if;
   select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('name',c.name,'email',c.email,'phone',c.phone)) into v_contact from public.customers c where c.tenant_id=p_tenant_id and c.id=v_customer;
   perform orders_private.attach_pos_customer(p_tenant_id,v_order,v_customer,v_contact);
   perform customers_ar_private.record_sale_debt(p_tenant_id,v_order,v_customer,v_grant.currency,v_total::bigint,v_paid,v_grant.operator_membership_id);
 elsif p_command ? 'tenders' then
   v_payment:=payments_private.capture_payments(p_tenant_id,v_order,(select jsonb_agg(pg_catalog.jsonb_build_object('method',elem.value->>'method','amount_minor',(elem.value->>'amountMinor')::bigint) || case when elem.value->>'cashReceivedMinor' is not null then pg_catalog.jsonb_build_object('cash_received_minor',(elem.value->>'cashReceivedMinor')::bigint) else '{}'::jsonb end order by elem.ord) from pg_catalog.jsonb_array_elements(p_command->'tenders') with ordinality elem(value,ord)),v_grant.operator_membership_id,'offline-payment:'||v_suffix);
 else
   v_payment:=payments_private.capture_cash_payment(p_tenant_id,v_order,(p_command->>'cashReceivedMinor')::bigint,v_grant.operator_membership_id,'offline-payment:'||v_suffix);
 end if;
 if v_device_status='revoked' then v_sufficient:=false; v_reason:='device_revoked_at_ingestion';
 else
   for v_element in select value from pg_catalog.jsonb_array_elements(p_command->'lines') loop
     v_quantity:=inventory_private.lock_balance_for_offline_sale(p_tenant_id,(v_element->>'variantId')::uuid,v_grant.inventory_location_id);
     if coalesce(v_quantity,0)<(v_element->>'quantity')::bigint then v_sufficient:=false; end if;
   end loop;
   if not v_sufficient then v_reason:='insufficient_stock_at_ingestion'; end if;
 end if;
 if v_sufficient then
   for v_line in select l.id,l.quantity from public.order_lines l where l.tenant_id=p_tenant_id and l.order_id=v_order order by l.line_number loop v_fulfillment_lines:=v_fulfillment_lines||pg_catalog.jsonb_build_object('order_line_id',v_line.id,'quantity',v_line.quantity); end loop;
   select f.fulfillment_id,f.inventory_operation_id into v_fulfillment,v_inventory_operation from fulfillments_private.record_fulfillment(p_tenant_id,v_order,v_grant.inventory_location_id,v_grant.operator_membership_id,'offline-fulfillment:'||v_suffix,v_received,v_fulfillment_lines) f;
 end if;
 insert into public.offline_sale_ingestions(tenant_id,grant_id,device_id,credential_id,register_id,branch_id,inventory_location_id,local_sale_id,sync_command_id,command_fingerprint,canonical_command,device_signature_base64,accepted_at,received_at,order_id,payment_id,fulfillment_id,sync_status,price_provenance)
 values(p_tenant_id,v_grant.id,v_grant.device_id,p_credential_id,v_grant.register_id,v_grant.branch_id,v_grant.inventory_location_id,p_command->>'localSaleId',v_sync,p_fingerprint,p_canonical,p_signature,v_accepted,v_received,v_order,v_payment,v_fulfillment,case when v_sufficient then 'synced' else 'needs_reconciliation' end,pg_catalog.jsonb_build_object('grantId',v_grant.id,'snapshotId',v_grant.snapshot_id,'lines',p_command->'lines','totalMinor',v_total::bigint,'amountPaidMinor',v_paid,'outstandingMinor',v_outstanding)) returning id into v_ingestion;
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
