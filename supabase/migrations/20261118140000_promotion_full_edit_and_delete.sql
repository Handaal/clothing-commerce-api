-- Promotion management: full edit + delete/archive (owner decision 2026-11-18).
--
-- 1. The edit-after-redemption freeze is lifted. A promotions manager can change every setting of a
--    promotion — discount type and value, buy/get quantities, minimum/maximum, channel, brand, branch,
--    global limit, activation, target type and the selected product/variant targets — at any time.
--    Sale-time history is unaffected: order_adjustments / order_line_adjustments / promotion_redemptions
--    snapshot the discount actually granted and stay immutable. Offline voucher grants already issued
--    keep the cached terms they were issued with (reconciled through the existing exception path).
--    `economicsLocked` remains in the projection as "has been redeemed" for compatibility.
--
-- 2. delete_promotion removes a promotion that was never used (no redemption, order adjustment, offline
--    grant/issuance/exception) together with its targets, codes and channel policies. A promotion with
--    any history is ARCHIVED instead: permanently inactive, every code disabled, hidden from the
--    management list/detail and refused by every management write. History rows keep their FK target.

alter table public.promotions add column archived_at timestamptz;
comment on column public.promotions.archived_at is
  'Set when a used promotion is deleted from management. Archived promotions are permanently inactive, hidden from management reads, and refuse management writes; sale-time history keeps referencing them.';

-- Management reads ignore archived promotions.
create or replace function promotions_private.promotion_detail(p_tenant uuid, p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'status', p.status,
    'benefitType', p.benefit_type, 'benefitPercentBp', p.benefit_percent_bp,
    'benefitAmountMinor', p.benefit_amount_minor, 'benefitCurrency', p.benefit_currency,
    'buyQuantity', p.buy_quantity, 'getQuantity', p.get_quantity,
    'targetType', p.target_type, 'activationType', p.activation_type,
    'minSubtotalMinor', p.min_subtotal_minor, 'maxDiscountMinor', p.max_discount_minor,
    'startsAt', to_char(p.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt', to_char(p.ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'channel', p.channel, 'brandId', p.brand_id, 'branchId', p.branch_id,
    'globalRedemptionLimit', p.global_redemption_limit, 'redemptionCount', p.redemption_count,
    'economicsLocked', p.redemption_count > 0,
    'createdAt', to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    -- Targets carry display names (additive; older clients strip the extra keys) so management apps can
    -- show which products/variants a promotion covers without re-reading the catalog.
    'targets', coalesce((select jsonb_agg(jsonb_build_object('productId',t.product_id,'variantId',t.variant_id,
        'productName', coalesce(pr.name, vp.name), 'variantName', v.display_name, 'sku', v.sku)
        order by t.created_at,t.id)
      from public.promotion_targets t
      left join public.products pr on pr.tenant_id=t.tenant_id and pr.id=t.product_id
      left join public.product_variants v on v.tenant_id=t.tenant_id and v.id=t.variant_id
      left join public.products vp on vp.tenant_id=v.tenant_id and vp.id=v.product_id
      where t.tenant_id=p.tenant_id and t.promotion_id=p.id),'[]'::jsonb),
    'codes', coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'code',c.normalized_code,'status',c.status,
      'maxRedemptions',c.max_redemptions,'redemptionCount',c.redemption_count,
      'remainingRedemptions',case when c.max_redemptions is null then null else greatest(0,c.max_redemptions-c.redemption_count) end)
      order by c.created_at,c.id) from public.promotion_codes c where c.tenant_id=p.tenant_id and c.promotion_id=p.id),'[]'::jsonb),
    'remainingRedemptions', case when p.global_redemption_limit is null then null else greatest(0,p.global_redemption_limit-p.redemption_count) end)
  from public.promotions p where p.tenant_id=p_tenant and p.id=p_id and p.archived_at is null;
$function$;

create or replace function promotions_private.list_promotions(p_tenant uuid, p_limit int, p_offset int)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'total', (select count(*) from public.promotions where tenant_id=p_tenant and archived_at is null),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'name',p.name,'status',p.status,'benefitType',p.benefit_type,'targetType',p.target_type,
      'activationType',p.activation_type,'channel',p.channel,'redemptionCount',p.redemption_count,
      'globalRedemptionLimit',p.global_redemption_limit,'economicsLocked',p.redemption_count>0,
      'createdAt',to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by p.created_at desc,p.id desc)
      from (select * from public.promotions where tenant_id=p_tenant and archived_at is null
        order by created_at desc,id desc
        limit greatest(0,least(p_limit,200)) offset greatest(0,p_offset)) p),'[]'::jsonb));
$function$;

-- Full edit. Every key is optional; an absent key keeps the stored value. Switching the discount type
-- clears the fields of the old type (the shape check then requires the new type's fields). Sending
-- `targets` (or changing targetType) replaces the selected targets.
create or replace function promotions_private.update_promotion(p_tenant uuid, p_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v public.promotions%rowtype;
  v_type text; v_target_type text; v_same boolean; v_limit bigint; v_target jsonb; v_count int;
begin
  select * into v from public.promotions where tenant_id=p_tenant and id=p_id for update;
  if not found or v.archived_at is not null then
    raise exception using errcode='PR404',message='promotion not found';
  end if;

  v_type := coalesce(p_payload->>'benefitType', v.benefit_type);
  v_same := v_type = v.benefit_type;
  v_target_type := coalesce(p_payload->>'targetType', v.target_type);

  if v_type = 'buy_x_get_y' and (p_payload ? 'channel') and p_payload->>'channel' is distinct from 'online' then
    raise exception using errcode='22023',message='buy_x_get_y offers are online-only';
  end if;

  if p_payload ? 'globalRedemptionLimit' then
    v_limit := (p_payload->>'globalRedemptionLimit')::bigint;
    if v_limit is not null and v_limit < v.redemption_count then
      raise exception using errcode='PR422',message='limit is below uses already redeemed';
    end if;
  else
    v_limit := v.global_redemption_limit;
  end if;

  update public.promotions set
    name = coalesce(p_payload->>'name', name),
    description = case when p_payload ? 'description' then p_payload->>'description' else description end,
    starts_at = case when p_payload ? 'startsAt' then (p_payload->>'startsAt')::timestamptz else starts_at end,
    ends_at = case when p_payload ? 'endsAt' then (p_payload->>'endsAt')::timestamptz else ends_at end,
    benefit_type = v_type,
    benefit_percent_bp = case when v_type <> 'percentage' then null
      when p_payload ? 'benefitPercentBp' then (p_payload->>'benefitPercentBp')::int
      when v_same then benefit_percent_bp else null end,
    benefit_amount_minor = case when v_type <> 'fixed_amount' then null
      when p_payload ? 'benefitAmountMinor' then (p_payload->>'benefitAmountMinor')::bigint
      when v_same then benefit_amount_minor else null end,
    benefit_currency = case when v_type <> 'fixed_amount' then null
      when p_payload ? 'benefitCurrency' then p_payload->>'benefitCurrency'
      when v_same then benefit_currency else null end,
    buy_quantity = case when v_type <> 'buy_x_get_y' then null
      when p_payload ? 'buyQuantity' then (p_payload->>'buyQuantity')::int
      when v_same then buy_quantity else null end,
    get_quantity = case when v_type <> 'buy_x_get_y' then null
      when p_payload ? 'getQuantity' then (p_payload->>'getQuantity')::int
      when v_same then get_quantity else null end,
    min_subtotal_minor = case when p_payload ? 'minSubtotalMinor' then (p_payload->>'minSubtotalMinor')::bigint else min_subtotal_minor end,
    max_discount_minor = case when p_payload ? 'maxDiscountMinor' then (p_payload->>'maxDiscountMinor')::bigint else max_discount_minor end,
    channel = case when v_type = 'buy_x_get_y' then 'online'
      when p_payload ? 'channel' then p_payload->>'channel' else channel end,
    brand_id = case when p_payload ? 'brandId' then (p_payload->>'brandId')::uuid else brand_id end,
    branch_id = case when p_payload ? 'branchId' then (p_payload->>'branchId')::uuid else branch_id end,
    global_redemption_limit = v_limit,
    activation_type = coalesce(p_payload->>'activationType', activation_type),
    target_type = v_target_type,
    updated_at = now()
  where tenant_id=p_tenant and id=p_id;

  if v_target_type = 'order' then
    delete from public.promotion_targets where tenant_id=p_tenant and promotion_id=p_id;
  elsif p_payload ? 'targets' then
    delete from public.promotion_targets where tenant_id=p_tenant and promotion_id=p_id;
    if jsonb_typeof(p_payload->'targets') = 'array' then
      for v_target in select value from jsonb_array_elements(p_payload->'targets') loop
        insert into public.promotion_targets(tenant_id,promotion_id,product_id,variant_id)
        values(p_tenant,p_id,(v_target->>'productId')::uuid,(v_target->>'variantId')::uuid);
      end loop;
    end if;
  end if;

  if v_target_type = 'variant_scope' then
    select count(*) into v_count from public.promotion_targets where tenant_id=p_tenant and promotion_id=p_id;
    if v_count = 0 then
      raise exception using errcode='22023',message='variant_scope promotions need at least one target';
    end if;
  end if;

  return promotions_private.promotion_detail(p_tenant,p_id);
end;
$function$;

-- Archived promotions cannot be reactivated or receive new codes.
create or replace function promotions_private.set_promotion_status(p_tenant uuid, p_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if p_status not in ('active','inactive') then raise exception using errcode='22023',message='invalid status'; end if;
  update public.promotions set status=p_status, updated_at=now()
    where tenant_id=p_tenant and id=p_id and archived_at is null;
  if not found then raise exception using errcode='PR404',message='promotion not found'; end if;
  return promotions_private.promotion_detail(p_tenant,p_id);
end;
$function$;

create or replace function promotions_private.create_code(p_tenant uuid, p_promotion uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if not exists(select 1 from public.promotions
      where tenant_id=p_tenant and id=p_promotion and archived_at is null) then
    raise exception using errcode='PR404',message='promotion not found';
  end if;
  insert into public.promotion_codes(tenant_id,promotion_id,code,max_redemptions)
  values(p_tenant,p_promotion,p_payload->>'code',(p_payload->>'maxRedemptions')::bigint);
  return promotions_private.promotion_detail(p_tenant,p_promotion);
end;
$function$;

-- Delete (never used) or archive (has history). Returns {"promotionId", "outcome": "deleted"|"archived"}.
create function promotions_private.delete_promotion(p_tenant uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v public.promotions%rowtype; v_used boolean;
begin
  select * into v from public.promotions where tenant_id=p_tenant and id=p_id for update;
  if not found or v.archived_at is not null then
    raise exception using errcode='PR404',message='promotion not found';
  end if;

  v_used := v.redemption_count > 0
    or exists(select 1 from public.promotion_codes c where c.tenant_id=p_tenant and c.promotion_id=p_id and c.redemption_count > 0)
    or exists(select 1 from public.promotion_redemptions r where r.tenant_id=p_tenant and r.promotion_id=p_id)
    or exists(select 1 from public.order_adjustments a where a.tenant_id=p_tenant and a.promotion_id=p_id)
    or exists(select 1 from public.order_line_adjustments a where a.tenant_id=p_tenant and a.promotion_id=p_id)
    or exists(select 1 from public.offline_pos_voucher_grants g where g.tenant_id=p_tenant and g.promotion_id=p_id)
    or exists(select 1 from public.offline_voucher_policy_issuances i where i.tenant_id=p_tenant and i.promotion_id=p_id)
    or exists(select 1 from public.offline_voucher_exceptions e where e.tenant_id=p_tenant and e.promotion_id=p_id)
    or exists(select 1 from public.promotion_channel_policies cp
      where cp.tenant_id=p_tenant and cp.promotion_id=p_id and (cp.redeemed_count > 0 or cp.reserved_count > 0));

  if v_used then
    update public.promotion_codes set status='disabled', updated_at=now()
      where tenant_id=p_tenant and promotion_id=p_id and status <> 'disabled';
    update public.promotions set status='inactive', archived_at=now(), updated_at=now()
      where tenant_id=p_tenant and id=p_id;
    return jsonb_build_object('promotionId', p_id, 'outcome', 'archived');
  end if;

  delete from public.promotion_code_channel_limits l
    using public.promotion_codes c
    where l.tenant_id=p_tenant and c.tenant_id=p_tenant and l.code_id=c.id and c.promotion_id=p_id;
  delete from public.promotion_codes where tenant_id=p_tenant and promotion_id=p_id;
  delete from public.promotion_channel_policies where tenant_id=p_tenant and promotion_id=p_id;
  delete from public.promotion_targets where tenant_id=p_tenant and promotion_id=p_id;
  delete from public.promotions where tenant_id=p_tenant and id=p_id;
  return jsonb_build_object('promotionId', p_id, 'outcome', 'deleted');
end;
$function$;

grant create on schema promotions_private to promotions_writer;
alter function promotions_private.delete_promotion(uuid,uuid) owner to promotions_writer;
revoke create on schema promotions_private from promotions_writer;
revoke all on function promotions_private.delete_promotion(uuid,uuid) from public;

do $b$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function promotions_private.delete_promotion(uuid,uuid) to service_role;
  end if;
end $b$;
