-- Phase 2P-A (5): sanctioned Admin management surface. promotions tables are owned by promotions_writer
-- and service_role holds SELECT only, so every management write goes through these SECURITY DEFINER
-- functions. They enforce the frozen edit-after-redemption rule (economics freeze once redeemed) and
-- return canonical detail projections. Read projections back list/detail/usage.

-- Idempotent creation dedupe (mirrors the orders idempotency pattern).
alter table public.promotions add column creation_key text;
create unique index promotions_tenant_creation_key_idx
  on public.promotions (tenant_id, creation_key) where creation_key is not null;

create function promotions_private.promotion_detail(p_tenant uuid, p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'status', p.status,
    'benefitType', p.benefit_type, 'benefitPercentBp', p.benefit_percent_bp,
    'benefitAmountMinor', p.benefit_amount_minor, 'benefitCurrency', p.benefit_currency,
    'targetType', p.target_type, 'activationType', p.activation_type,
    'minSubtotalMinor', p.min_subtotal_minor, 'maxDiscountMinor', p.max_discount_minor,
    'startsAt', to_char(p.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt', to_char(p.ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'channel', p.channel, 'brandId', p.brand_id, 'branchId', p.branch_id,
    'globalRedemptionLimit', p.global_redemption_limit, 'redemptionCount', p.redemption_count,
    'economicsLocked', p.redemption_count > 0,
    'createdAt', to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'targets', coalesce((select jsonb_agg(jsonb_build_object('productId',t.product_id,'variantId',t.variant_id) order by t.created_at,t.id)
      from public.promotion_targets t where t.tenant_id=p.tenant_id and t.promotion_id=p.id),'[]'::jsonb),
    'codes', coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'code',c.normalized_code,'status',c.status,
      'maxRedemptions',c.max_redemptions,'redemptionCount',c.redemption_count,
      'remainingRedemptions',case when c.max_redemptions is null then null else greatest(0,c.max_redemptions-c.redemption_count) end)
      order by c.created_at,c.id) from public.promotion_codes c where c.tenant_id=p.tenant_id and c.promotion_id=p.id),'[]'::jsonb),
    'remainingRedemptions', case when p.global_redemption_limit is null then null else greatest(0,p.global_redemption_limit-p.redemption_count) end)
  from public.promotions p where p.tenant_id=p_tenant and p.id=p_id;
$function$;

create function promotions_private.list_promotions(p_tenant uuid, p_limit int, p_offset int)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'total', (select count(*) from public.promotions where tenant_id=p_tenant),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'name',p.name,'status',p.status,'benefitType',p.benefit_type,'targetType',p.target_type,
      'activationType',p.activation_type,'channel',p.channel,'redemptionCount',p.redemption_count,
      'globalRedemptionLimit',p.global_redemption_limit,'economicsLocked',p.redemption_count>0,
      'createdAt',to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by p.created_at desc,p.id desc)
      from (select * from public.promotions where tenant_id=p_tenant order by created_at desc,id desc
        limit greatest(0,least(p_limit,200)) offset greatest(0,p_offset)) p),'[]'::jsonb));
$function$;

create function promotions_private.create_promotion(p_tenant uuid, p_key text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_id uuid; v_existing uuid; v_target jsonb; v_code jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('promotion_create:'||p_tenant::text||':'||lower(btrim(coalesce(p_key,''))),0));
  if p_key is not null then
    select id into v_existing from public.promotions where tenant_id=p_tenant and creation_key=lower(btrim(p_key));
    if found then return promotions_private.promotion_detail(p_tenant,v_existing); end if;
  end if;
  insert into public.promotions(tenant_id, creation_key, name, description, benefit_type, benefit_percent_bp,
    benefit_amount_minor, benefit_currency, target_type, activation_type, min_subtotal_minor, max_discount_minor,
    starts_at, ends_at, channel, brand_id, branch_id, global_redemption_limit, status)
  values(p_tenant, lower(btrim(p_key)), p_payload->>'name', p_payload->>'description', p_payload->>'benefitType',
    (p_payload->>'benefitPercentBp')::int, (p_payload->>'benefitAmountMinor')::bigint, p_payload->>'benefitCurrency',
    p_payload->>'targetType', p_payload->>'activationType', (p_payload->>'minSubtotalMinor')::bigint,
    (p_payload->>'maxDiscountMinor')::bigint, (p_payload->>'startsAt')::timestamptz, (p_payload->>'endsAt')::timestamptz,
    p_payload->>'channel', (p_payload->>'brandId')::uuid, (p_payload->>'branchId')::uuid,
    (p_payload->>'globalRedemptionLimit')::bigint, coalesce(p_payload->>'status','active'))
  returning id into v_id;
  if jsonb_typeof(p_payload->'targets')='array' then
    for v_target in select value from jsonb_array_elements(p_payload->'targets') loop
      insert into public.promotion_targets(tenant_id,promotion_id,product_id,variant_id)
      values(p_tenant,v_id,(v_target->>'productId')::uuid,(v_target->>'variantId')::uuid);
    end loop;
  end if;
  if jsonb_typeof(p_payload->'codes')='array' then
    for v_code in select value from jsonb_array_elements(p_payload->'codes') loop
      insert into public.promotion_codes(tenant_id,promotion_id,code,max_redemptions)
      values(p_tenant,v_id,v_code->>'code',(v_code->>'maxRedemptions')::bigint);
    end loop;
  end if;
  return promotions_private.promotion_detail(p_tenant,v_id);
end;
$function$;

-- Metadata edits are always allowed; economic edits are rejected once a redemption exists (frozen rule).
create function promotions_private.update_promotion(p_tenant uuid, p_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v public.promotions%rowtype; economic boolean;
begin
  select * into v from public.promotions where tenant_id=p_tenant and id=p_id for update;
  if not found then raise exception using errcode='PR404',message='promotion not found'; end if;
  economic := p_payload ?| array['benefitPercentBp','benefitAmountMinor','minSubtotalMinor','maxDiscountMinor','channel','brandId','branchId'];
  if economic and v.redemption_count > 0 then
    raise exception using errcode='PR423',message='promotion economics are locked after first redemption';
  end if;
  update public.promotions set
    name = coalesce(p_payload->>'name', name),
    description = case when p_payload ? 'description' then p_payload->>'description' else description end,
    starts_at = case when p_payload ? 'startsAt' then (p_payload->>'startsAt')::timestamptz else starts_at end,
    ends_at = case when p_payload ? 'endsAt' then (p_payload->>'endsAt')::timestamptz else ends_at end,
    benefit_percent_bp = case when p_payload ? 'benefitPercentBp' then (p_payload->>'benefitPercentBp')::int else benefit_percent_bp end,
    benefit_amount_minor = case when p_payload ? 'benefitAmountMinor' then (p_payload->>'benefitAmountMinor')::bigint else benefit_amount_minor end,
    min_subtotal_minor = case when p_payload ? 'minSubtotalMinor' then (p_payload->>'minSubtotalMinor')::bigint else min_subtotal_minor end,
    max_discount_minor = case when p_payload ? 'maxDiscountMinor' then (p_payload->>'maxDiscountMinor')::bigint else max_discount_minor end,
    channel = case when p_payload ? 'channel' then p_payload->>'channel' else channel end,
    brand_id = case when p_payload ? 'brandId' then (p_payload->>'brandId')::uuid else brand_id end,
    branch_id = case when p_payload ? 'branchId' then (p_payload->>'branchId')::uuid else branch_id end,
    updated_at = now()
  where tenant_id=p_tenant and id=p_id;
  return promotions_private.promotion_detail(p_tenant,p_id);
end;
$function$;

create function promotions_private.set_promotion_status(p_tenant uuid, p_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if p_status not in ('active','inactive') then raise exception using errcode='22023',message='invalid status'; end if;
  update public.promotions set status=p_status, updated_at=now() where tenant_id=p_tenant and id=p_id;
  if not found then raise exception using errcode='PR404',message='promotion not found'; end if;
  return promotions_private.promotion_detail(p_tenant,p_id);
end;
$function$;

create function promotions_private.create_code(p_tenant uuid, p_promotion uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if not exists(select 1 from public.promotions where tenant_id=p_tenant and id=p_promotion) then
    raise exception using errcode='PR404',message='promotion not found';
  end if;
  insert into public.promotion_codes(tenant_id,promotion_id,code,max_redemptions)
  values(p_tenant,p_promotion,p_payload->>'code',(p_payload->>'maxRedemptions')::bigint);
  return promotions_private.promotion_detail(p_tenant,p_promotion);
end;
$function$;

create function promotions_private.set_code_status(p_tenant uuid, p_code uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_promotion uuid;
begin
  if p_status not in ('active','disabled') then raise exception using errcode='22023',message='invalid status'; end if;
  update public.promotion_codes set status=p_status, updated_at=now()
    where tenant_id=p_tenant and id=p_code returning promotion_id into v_promotion;
  if not found then raise exception using errcode='PR404',message='code not found'; end if;
  return promotions_private.promotion_detail(p_tenant,v_promotion);
end;
$function$;

grant create on schema promotions_private to promotions_writer;
alter function promotions_private.promotion_detail(uuid,uuid) owner to promotions_writer;
alter function promotions_private.list_promotions(uuid,int,int) owner to promotions_writer;
alter function promotions_private.create_promotion(uuid,text,jsonb) owner to promotions_writer;
alter function promotions_private.update_promotion(uuid,uuid,jsonb) owner to promotions_writer;
alter function promotions_private.set_promotion_status(uuid,uuid,text) owner to promotions_writer;
alter function promotions_private.create_code(uuid,uuid,jsonb) owner to promotions_writer;
alter function promotions_private.set_code_status(uuid,uuid,text) owner to promotions_writer;
revoke create on schema promotions_private from promotions_writer;
revoke all on all functions in schema promotions_private from public;

do $b$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function promotions_private.promotion_detail(uuid,uuid),
      promotions_private.list_promotions(uuid,int,int),
      promotions_private.create_promotion(uuid,text,jsonb),
      promotions_private.update_promotion(uuid,uuid,jsonb),
      promotions_private.set_promotion_status(uuid,uuid,text),
      promotions_private.create_code(uuid,uuid,jsonb),
      promotions_private.set_code_status(uuid,uuid,text) to service_role;
  end if;
end $b$;
