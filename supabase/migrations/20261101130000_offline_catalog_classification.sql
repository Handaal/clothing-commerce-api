-- Offline catalog classification: carry brand name + category (collection) names in the offline grant's
-- catalog snapshot, so the offline register browses by category and searches by brand with the SAME
-- server-authoritative data the connected POS, admin, and storefront already use. Previously the snapshot
-- carried only brandId + product name, forcing clients to reconstruct classification locally.
--
-- This re-issues offline_pos_private.issue_grant (latest definition from 20261030140000) with two added
-- per-product fields:
--   brandName  : the brand's display name (public.brands.display_name)
--   categories : [{id,name}] of the product's non-archived collections (public.product_collections)
-- Everything else in the function is byte-for-byte the prior behaviour. The restricted offline_pos_writer
-- role is granted read access (SELECT + permissive RLS) to the brands and collection tables it must join.

grant select on public.brands, public.collections, public.product_collections to offline_pos_writer;

create policy offline_writer_brands on public.brands
  for select to offline_pos_writer using (true);
create policy offline_writer_collections on public.collections
  for select to offline_pos_writer using (true);
create policy offline_writer_product_collections on public.product_collections
  for select to offline_pos_writer using (true);

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
   'brandName',b.display_name,
   'categories',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',c.id,'name',c.name) order by c.name,c.id),'[]'::jsonb)
      from public.product_collections pc
      join public.collections c on c.tenant_id=p_tenant_id and c.id=pc.collection_id and c.status<>'archived'
      where pc.tenant_id=p_tenant_id and pc.product_id=p.id),
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
 left join public.brands b on b.tenant_id=p_tenant_id and b.id=p.brand_id
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
