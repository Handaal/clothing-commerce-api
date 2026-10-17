-- Phase 2B — Step 4: split tender for offline sales.
--
-- The signed offline command may now carry a `tenders` array (validated + signed client-side; the
-- signature already covers it via canonicalizeOfflineSaleCommand). When present, the server captures
-- the split through payments_private.capture_payments (mapping the command's camelCase tender fields to
-- the snake_case the RPC expects) and validates the tenders sum to the server-computed total. Cash-only
-- offline sales (no `tenders`) keep their exact prior behaviour. All other offline authority checks —
-- grant binding, credential validity, exposure limits, stock locking, reconciliation — are unchanged.

grant execute on function payments_private.capture_payments(uuid, uuid, jsonb, uuid, text)
  to offline_pos_writer;

create or replace function offline_pos_private.record_offline_sale(p_tenant_id uuid,p_credential_id uuid,p_command jsonb,p_canonical text,p_fingerprint text,p_signature text)
returns table(ingestion_id uuid,sync_status text,order_id uuid,payment_id uuid,fulfillment_id uuid,reconciliation_id uuid,received_at timestamptz)
language plpgsql security definer set search_path='' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_sale_ingestions%rowtype; v_device_status text; v_element jsonb; v_snapshot jsonb;
 v_total numeric:=0; v_quantity bigint; v_variant uuid; v_price bigint; v_price_id uuid; v_order_lines jsonb:='[]'; v_fulfillment_lines jsonb:='[]';
 v_brand uuid; v_order uuid; v_payment uuid; v_fulfillment uuid; v_inventory_operation uuid; v_ingestion uuid; v_reconciliation uuid;
 v_sufficient boolean:=true; v_reason text; v_suffix text; v_received timestamptz:=now(); v_accepted timestamptz; v_sync uuid; v_line record;
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
 if p_command ? 'tenders' then
   if coalesce((select sum((t.value->>'amountMinor')::bigint) from pg_catalog.jsonb_array_elements(p_command->'tenders') t(value)),0)<>v_total::bigint then raise exception using errcode='OS422',message='offline tenders do not sum to total'; end if;
 else
   if (p_command->>'cashReceivedMinor')::bigint-v_total::bigint<>(p_command->>'changeMinor')::bigint or (p_command->>'cashReceivedMinor')::bigint<v_total then raise exception using errcode='OS422',message='offline monetary totals invalid'; end if;
 end if;
 if v_total>v_grant.max_sale_amount_minor or (p_command->>'cumulativeExposureMinor')::bigint>v_grant.max_cumulative_exposure_minor or (p_command->>'cumulativeExposureMinor')::bigint<v_total then raise exception using errcode='OL422',message='offline exposure limit exceeded'; end if;
 if coalesce((select sum((i.price_provenance->>'totalMinor')::bigint) from public.offline_sale_ingestions i where i.tenant_id=p_tenant_id and i.grant_id=v_grant.id),0)+v_total>v_grant.max_cumulative_exposure_minor then raise exception using errcode='OL422',message='cumulative exposure exceeded'; end if;
 v_suffix:=pg_catalog.md5(p_tenant_id::text||':'||v_sync::text);
 v_order:=orders_private.create_order(p_tenant_id,'pos',v_grant.currency,v_brand,v_grant.branch_id,v_grant.register_id,v_grant.operator_membership_id,'offline-order:'||v_suffix,v_accepted,'Accepted offline; synchronized later.',v_order_lines);
 if p_command ? 'tenders' then
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
 values(p_tenant_id,v_grant.id,v_grant.device_id,p_credential_id,v_grant.register_id,v_grant.branch_id,v_grant.inventory_location_id,p_command->>'localSaleId',v_sync,p_fingerprint,p_canonical,p_signature,v_accepted,v_received,v_order,v_payment,v_fulfillment,case when v_sufficient then 'synced' else 'needs_reconciliation' end,pg_catalog.jsonb_build_object('grantId',v_grant.id,'snapshotId',v_grant.snapshot_id,'lines',p_command->'lines','totalMinor',v_total::bigint)) returning id into v_ingestion;
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
