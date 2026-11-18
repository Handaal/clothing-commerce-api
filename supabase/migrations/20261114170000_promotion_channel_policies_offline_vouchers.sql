-- ADR-042 §5 (owner D-2, D-7) — VOUCHER CHANNEL POLICIES, RESERVED POS QUOTA, OFFLINE REDEMPTION.
--
-- 1. promotion_channel_policies: optional per-channel ('pos' | 'online') usage limit with independent
--    redeemed/reserved counters. A promotion with no policy rows behaves exactly as before.
--    promotion_code_channel_limits: the same split per code.
--    Enforced at the one place a redemption is written (BEFORE INSERT on promotion_redemptions) and in
--    quoting (evaluate skips a promotion/code whose channel capacity is used up).
-- 2. POS offline (channel 'pos' policy only): offline_enabled + offline_quota_per_grant + optional
--    requires_admin_credentials + the two D-7 discount caps. Offline is offered ONLY when every one of them is
--    set and the usage limit is finite: missing owner limits fail closed (nothing is granted).
-- 3. offline_pos_voucher_grants: issued at bootstrap, moving quota from available to reserved
--    (policy.reserved += n, code limit reserved += n) so an online sale or another till can never use units a
--    till already holds. Released on close/expiry exactly like stock grants.
-- 4. Offline redemption at ingestion (owner D-2): the sale and receipt always stand at the price paid. A valid
--    use consumes one reserved unit (reserved -= 1, redeemed += 1). Anything a reservation cannot cover
--    (voucher withdrawn, grant ended/invalid, discount not matching the signed terms, cap exceeded, missing or
--    invalid admin credential) is written as an exception with a deterministic code, consumes no quota and
--    releases the unit. No task, no approval, no later charge.

-- ---------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------
create table public.promotion_channel_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  promotion_id uuid not null,
  channel text not null,
  usage_limit bigint,
  redeemed_count bigint not null default 0,
  reserved_count bigint not null default 0,
  offline_enabled boolean not null default false,
  offline_quota_per_grant integer,
  requires_admin_credentials boolean not null default false,
  max_discount_per_redemption_minor bigint,
  max_discount_per_grant_minor bigint,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotion_channel_policies_promotion_fk foreign key (tenant_id, promotion_id)
    references public.promotions (tenant_id, id) on delete restrict,
  constraint promotion_channel_policies_channel check (channel in ('pos', 'online')),
  constraint promotion_channel_policies_limit check (usage_limit is null or usage_limit > 0),
  constraint promotion_channel_policies_counts check (redeemed_count >= 0 and reserved_count >= 0
    and (usage_limit is null or redeemed_count + reserved_count <= usage_limit)),
  constraint promotion_channel_policies_offline_only_pos check (channel = 'pos' or (not offline_enabled
    and offline_quota_per_grant is null and not requires_admin_credentials
    and max_discount_per_redemption_minor is null and max_discount_per_grant_minor is null)),
  constraint promotion_channel_policies_offline_values check (
    (offline_quota_per_grant is null or offline_quota_per_grant > 0)
    and (max_discount_per_redemption_minor is null or max_discount_per_redemption_minor > 0)
    and (max_discount_per_grant_minor is null or max_discount_per_grant_minor > 0)),
  constraint promotion_channel_policies_unique unique (tenant_id, promotion_id, channel),
  constraint promotion_channel_policies_tenant_id_unique unique (tenant_id, id)
);

create table public.promotion_code_channel_limits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code_id uuid not null,
  channel text not null,
  usage_limit bigint not null,
  redeemed_count bigint not null default 0,
  reserved_count bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotion_code_channel_limits_code_fk foreign key (tenant_id, code_id)
    references public.promotion_codes (tenant_id, id) on delete restrict,
  constraint promotion_code_channel_limits_channel check (channel in ('pos', 'online')),
  constraint promotion_code_channel_limits_counts check (usage_limit > 0 and redeemed_count >= 0
    and reserved_count >= 0 and redeemed_count + reserved_count <= usage_limit),
  constraint promotion_code_channel_limits_unique unique (tenant_id, code_id, channel)
);

create table public.offline_pos_voucher_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  offline_grant_id uuid not null,
  register_id uuid not null,
  promotion_id uuid not null,
  code_id uuid,
  allowed_count integer not null,
  consumed_count integer not null default 0,
  released_count integer not null default 0,
  discount_consumed_minor bigint not null default 0,
  max_discount_per_redemption_minor bigint not null,
  max_discount_per_grant_minor bigint not null,
  requires_admin_credentials boolean not null,
  policy_version integer not null,
  calculation_version text not null default 'ov1',
  terms jsonb not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active',
  ended_at timestamptz,
  constraint offline_pos_voucher_grants_grant_fk foreign key (tenant_id, offline_grant_id)
    references public.offline_grants (tenant_id, id) on delete restrict,
  constraint offline_pos_voucher_grants_promotion_fk foreign key (tenant_id, promotion_id)
    references public.promotions (tenant_id, id) on delete restrict,
  constraint offline_pos_voucher_grants_code_fk foreign key (tenant_id, code_id)
    references public.promotion_codes (tenant_id, id) on delete restrict,
  constraint offline_pos_voucher_grants_counts check (allowed_count > 0 and consumed_count >= 0
    and released_count >= 0 and consumed_count + released_count <= allowed_count),
  constraint offline_pos_voucher_grants_caps check (max_discount_per_redemption_minor > 0
    and max_discount_per_grant_minor > 0 and discount_consumed_minor >= 0
    and discount_consumed_minor <= max_discount_per_grant_minor),
  constraint offline_pos_voucher_grants_status check (status in ('active', 'closed', 'expired', 'revoked')),
  constraint offline_pos_voucher_grants_ended check ((status = 'active') = (ended_at is null)),
  constraint offline_pos_voucher_grants_calc check (calculation_version = 'ov1'),
  constraint offline_pos_voucher_grants_tenant_id_unique unique (tenant_id, id)
);
create unique index offline_pos_voucher_grants_unique
  on public.offline_pos_voucher_grants (tenant_id, offline_grant_id, promotion_id, coalesce(code_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index offline_pos_voucher_grants_active_idx
  on public.offline_pos_voucher_grants (tenant_id, register_id, expires_at) where status = 'active';

create table public.offline_voucher_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  offline_grant_id uuid not null,
  voucher_grant_id uuid,
  promotion_id uuid,
  code_id uuid,
  sync_command_id uuid not null,
  code text not null,
  discount_total_minor bigint not null,
  created_at timestamptz not null default now(),
  constraint offline_voucher_exceptions_code check (code in (
    'VX_GRANT_INVALID', 'VX_REVOKED', 'VX_POLICY_WITHDRAWN', 'VX_DISCOUNT_MISMATCH', 'VX_CAP_EXCEEDED',
    'VX_CREDENTIAL_MISSING', 'VX_CREDENTIAL_INVALID', 'VX_CREDENTIAL_NOT_ISSUED', 'VX_CREDENTIAL_REUSED')),
  constraint offline_voucher_exceptions_discount check (discount_total_minor > 0),
  constraint offline_voucher_exceptions_one_per_order unique (tenant_id, order_id)
);
comment on table public.offline_voucher_exceptions is
  'ADR-042 D-2: offline voucher discounts honoured at the till but not covered by a valid reservation. The sale stands at the price paid; this is report-only evidence (no task, no approval, no quota consumed).';

alter table public.promotion_channel_policies enable row level security;
alter table public.promotion_code_channel_limits enable row level security;
alter table public.offline_pos_voucher_grants enable row level security;
alter table public.offline_voucher_exceptions enable row level security;
revoke all on public.promotion_channel_policies, public.promotion_code_channel_limits,
  public.offline_pos_voucher_grants, public.offline_voucher_exceptions from public;
create trigger offline_voucher_exceptions_immutable before update or delete on public.offline_voucher_exceptions
  for each row execute function promotions_private.forbid_history_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- Channel capacity: redemption guard + quoting filter
-- ---------------------------------------------------------------------------------------------------------
create function promotions_private.channel_has_capacity(p_tenant uuid, p_promotion uuid, p_code uuid, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select not exists (
           select 1 from public.promotion_channel_policies cp
            where cp.tenant_id = p_tenant and cp.promotion_id = p_promotion and cp.channel = p_channel
              and cp.usage_limit is not null and cp.redeemed_count + cp.reserved_count >= cp.usage_limit)
     and (p_code is null or not exists (
           select 1 from public.promotion_code_channel_limits cl
            where cl.tenant_id = p_tenant and cl.code_id = p_code and cl.channel = p_channel
              and cl.redeemed_count + cl.reserved_count >= cl.usage_limit));
$function$;

-- Every redemption passes here. Ordinary (online or connected POS) use needs free capacity. Offline grant
-- consumption (flagged by redeem_offline_voucher) moves one reserved unit to redeemed instead.
create function promotions_private.channel_redemption_guard()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_from_grant boolean := coalesce(current_setting('promotions_private.offline_voucher_grant', true), '') = 'on';
  v_policy public.promotion_channel_policies%rowtype; v_limit public.promotion_code_channel_limits%rowtype;
begin
  select * into v_policy from public.promotion_channel_policies cp
   where cp.tenant_id = new.tenant_id and cp.promotion_id = new.promotion_id and cp.channel = new.channel for update;
  if found then
    if v_from_grant then
      update public.promotion_channel_policies set reserved_count = reserved_count - 1,
             redeemed_count = redeemed_count + 1, updated_at = now() where id = v_policy.id;
    else
      if v_policy.usage_limit is not null and v_policy.redeemed_count + v_policy.reserved_count >= v_policy.usage_limit then
        raise exception using errcode = 'PR409', message = 'promotion channel limit reached';
      end if;
      update public.promotion_channel_policies set redeemed_count = redeemed_count + 1, updated_at = now()
       where id = v_policy.id;
    end if;
  end if;
  if new.code_id is not null then
    select * into v_limit from public.promotion_code_channel_limits cl
     where cl.tenant_id = new.tenant_id and cl.code_id = new.code_id and cl.channel = new.channel for update;
    if found then
      if v_from_grant then
        update public.promotion_code_channel_limits set reserved_count = reserved_count - 1,
               redeemed_count = redeemed_count + 1, updated_at = now() where id = v_limit.id;
      else
        if v_limit.redeemed_count + v_limit.reserved_count >= v_limit.usage_limit then
          raise exception using errcode = 'PR409', message = 'promotion code channel limit reached';
        end if;
        update public.promotion_code_channel_limits set redeemed_count = redeemed_count + 1, updated_at = now()
         where id = v_limit.id;
      end if;
    end if;
  end if;
  return new;
end;
$function$;
create trigger promotion_redemptions_channel_guard before insert on public.promotion_redemptions
  for each row execute function promotions_private.channel_redemption_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Offline voucher terms + the deterministic offline discount ('ov1' — mirrors promotions_private.evaluate for
-- percentage and fixed_amount; the till implements the identical formula).
-- ---------------------------------------------------------------------------------------------------------
create function promotions_private.offline_voucher_terms(p_promo public.promotions, p_code public.promotion_codes)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'promotionId', p_promo.id, 'name', p_promo.name, 'codeId', p_code.id, 'code', p_code.normalized_code,
    'benefitType', p_promo.benefit_type, 'benefitPercentBp', p_promo.benefit_percent_bp,
    'benefitAmountMinor', p_promo.benefit_amount_minor, 'benefitCurrency', p_promo.benefit_currency,
    'targetType', p_promo.target_type, 'minSubtotalMinor', p_promo.min_subtotal_minor,
    'maxDiscountMinor', p_promo.max_discount_minor, 'endsAt', p_promo.ends_at,
    'targetProductIds', coalesce((select jsonb_agg(t.product_id order by t.product_id) from public.promotion_targets t
       where t.tenant_id = p_promo.tenant_id and t.promotion_id = p_promo.id and t.product_id is not null), '[]'::jsonb),
    'targetVariantIds', coalesce((select jsonb_agg(t.variant_id order by t.variant_id) from public.promotion_targets t
       where t.tenant_id = p_promo.tenant_id and t.promotion_id = p_promo.id and t.variant_id is not null), '[]'::jsonb));
$function$;

-- p_lines: [{variantId, productId, lineTotalMinor}]
create function promotions_private.offline_voucher_discount(p_terms jsonb, p_lines jsonb)
returns bigint language plpgsql immutable set search_path = '' as $function$
declare v_gross bigint := 0; v_basis bigint := 0; v_line jsonb; v_discount bigint;
begin
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_gross := v_gross + (v_line->>'lineTotalMinor')::bigint;
    if p_terms->>'targetType' = 'order'
       or (p_terms->'targetVariantIds') ? (v_line->>'variantId')
       or (p_terms->'targetProductIds') ? (v_line->>'productId') then
      v_basis := v_basis + (v_line->>'lineTotalMinor')::bigint;
    end if;
  end loop;
  if (p_terms->>'minSubtotalMinor') is not null and v_gross < (p_terms->>'minSubtotalMinor')::bigint then return 0; end if;
  if v_basis <= 0 then return 0; end if;
  if p_terms->>'benefitType' = 'percentage' then
    v_discount := floor(v_basis::numeric * (p_terms->>'benefitPercentBp')::numeric / 10000)::bigint;
  elsif p_terms->>'benefitType' = 'fixed_amount' then
    v_discount := least((p_terms->>'benefitAmountMinor')::bigint, v_basis);
  else
    return 0;
  end if;
  if (p_terms->>'maxDiscountMinor') is not null then
    v_discount := least(v_discount, (p_terms->>'maxDiscountMinor')::bigint);
  end if;
  return greatest(0, least(v_discount, v_gross, v_basis));
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Voucher grant lifecycle
-- ---------------------------------------------------------------------------------------------------------
create function promotions_private.voucher_grant_release_one(p_grant public.offline_pos_voucher_grants, p_units integer)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  if p_units <= 0 then return; end if;
  update public.promotion_channel_policies cp set reserved_count = cp.reserved_count - p_units, updated_at = now()
   where cp.tenant_id = p_grant.tenant_id and cp.promotion_id = p_grant.promotion_id and cp.channel = 'pos';
  if p_grant.code_id is not null then
    update public.promotion_code_channel_limits cl set reserved_count = cl.reserved_count - p_units, updated_at = now()
     where cl.tenant_id = p_grant.tenant_id and cl.code_id = p_grant.code_id and cl.channel = 'pos';
  end if;
  update public.offline_pos_voucher_grants set released_count = released_count + p_units where id = p_grant.id;
end;
$function$;

create function promotions_private.end_offline_voucher_grants(p_tenant uuid, p_offline_grant_id uuid, p_status text)
returns integer language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_pos_voucher_grants%rowtype; v_count integer := 0;
begin
  for v_grant in
    select * from public.offline_pos_voucher_grants g
     where g.tenant_id = p_tenant and g.offline_grant_id = p_offline_grant_id and g.status = 'active'
     order by g.promotion_id, g.id for update
  loop
    perform promotions_private.voucher_grant_release_one(v_grant, v_grant.allowed_count - v_grant.consumed_count - v_grant.released_count);
    update public.offline_pos_voucher_grants set status = p_status, ended_at = now() where id = v_grant.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

create function promotions_private.voucher_grants_json(p_tenant uuid, p_offline_grant_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'voucherGrantId', g.id, 'promotionId', g.promotion_id, 'codeId', g.code_id, 'status', g.status,
    'allowedCount', g.allowed_count, 'consumedCount', g.consumed_count, 'releasedCount', g.released_count,
    'maxDiscountPerRedemptionMinor', g.max_discount_per_redemption_minor,
    'maxDiscountPerGrantMinor', g.max_discount_per_grant_minor, 'discountConsumedMinor', g.discount_consumed_minor,
    'requiresAdminCredentials', g.requires_admin_credentials, 'calculationVersion', g.calculation_version,
    'expiresAt', g.expires_at, 'terms', g.terms) order by g.promotion_id, g.code_id), '[]'::jsonb)
  from public.offline_pos_voucher_grants g where g.tenant_id = p_tenant and g.offline_grant_id = p_offline_grant_id;
$function$;

-- Bootstrap: close the previous offline grant's vouchers (when reported), expire stale ones for this
-- register, then reserve quota for every offline-enabled POS voucher. Idempotent per offline grant.
create function promotions_private.issue_offline_voucher_grants(
  p_tenant uuid, p_offline_grant_id uuid, p_previous_offline_grant_id uuid, p_previous_final_ordinal integer
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_offline record; v_promo public.promotions%rowtype; v_policy public.promotion_channel_policies%rowtype;
  v_code public.promotion_codes%rowtype; v_limit public.promotion_code_channel_limits%rowtype;
  v_free bigint; v_allowed bigint; v_stale record;
begin
  select g.id, g.register_id, g.branch_id, g.currency, g.accepted_until, g.catalog_snapshot into v_offline
    from public.offline_grants g where g.tenant_id = p_tenant and g.id = p_offline_grant_id;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;
  if exists (select 1 from public.offline_pos_voucher_grants g where g.tenant_id = p_tenant and g.offline_grant_id = p_offline_grant_id) then
    return promotions_private.voucher_grants_json(p_tenant, p_offline_grant_id);
  end if;

  if p_previous_offline_grant_id is not null
     and exists (select 1 from public.offline_pos_voucher_grants g where g.tenant_id = p_tenant
                  and g.offline_grant_id = p_previous_offline_grant_id and g.status = 'active') then
    if not inventory_private.stock_grant_ordinals_complete(p_tenant, p_previous_offline_grant_id, p_previous_final_ordinal) then
      raise exception using errcode = 'SG409', message = 'offline sales for the previous grant are not all synchronized';
    end if;
    perform promotions_private.end_offline_voucher_grants(p_tenant, p_previous_offline_grant_id, 'closed');
  end if;
  for v_stale in
    select distinct g.offline_grant_id from public.offline_pos_voucher_grants g
     where g.tenant_id = p_tenant and g.register_id = v_offline.register_id and g.status = 'active'
       and g.expires_at + interval '5 minutes' < now()
  loop
    if inventory_private.stock_grant_ordinals_complete(p_tenant, v_stale.offline_grant_id, null) then
      perform promotions_private.end_offline_voucher_grants(p_tenant, v_stale.offline_grant_id, 'expired');
    end if;
  end loop;

  for v_policy in
    select cp.* from public.promotion_channel_policies cp
      join public.promotions p on p.tenant_id = cp.tenant_id and p.id = cp.promotion_id
     where cp.tenant_id = p_tenant and cp.channel = 'pos' and cp.offline_enabled
       and cp.usage_limit is not null and cp.offline_quota_per_grant is not null
       and cp.max_discount_per_redemption_minor is not null and cp.max_discount_per_grant_minor is not null
       and p.status = 'active' and (p.channel is null or p.channel = 'pos')
       and (p.starts_at is null or p.starts_at <= now()) and (p.ends_at is null or p.ends_at > now())
       and p.benefit_type in ('percentage', 'fixed_amount')
       and (p.benefit_type <> 'fixed_amount' or p.benefit_currency = v_offline.currency)
       and p.global_redemption_limit is null
       and (p.branch_id is null or p.branch_id = v_offline.branch_id)
     order by cp.promotion_id for update of cp
  loop
    select * into v_promo from public.promotions p where p.tenant_id = p_tenant and p.id = v_policy.promotion_id;
    v_free := v_policy.usage_limit - v_policy.redeemed_count - v_policy.reserved_count;
    if v_promo.activation_type = 'automatic' then
      v_allowed := least(v_policy.offline_quota_per_grant, v_free);
      if v_allowed > 0 then
        update public.promotion_channel_policies set reserved_count = reserved_count + v_allowed, updated_at = now() where id = v_policy.id;
        insert into public.offline_pos_voucher_grants (tenant_id, offline_grant_id, register_id, promotion_id, code_id,
          allowed_count, max_discount_per_redemption_minor, max_discount_per_grant_minor, requires_admin_credentials,
          policy_version, terms, expires_at)
        values (p_tenant, p_offline_grant_id, v_offline.register_id, v_promo.id, null, v_allowed,
          v_policy.max_discount_per_redemption_minor, v_policy.max_discount_per_grant_minor,
          v_policy.requires_admin_credentials, v_policy.version, promotions_private.offline_voucher_terms(v_promo, null),
          v_offline.accepted_until);
      end if;
    else
      for v_code in
        select * from public.promotion_codes c where c.tenant_id = p_tenant and c.promotion_id = v_promo.id
           and c.status = 'active' and c.max_redemptions is null order by c.id
      loop
        exit when v_free <= 0;
        v_allowed := least(v_policy.offline_quota_per_grant, v_free);
        select * into v_limit from public.promotion_code_channel_limits cl
         where cl.tenant_id = p_tenant and cl.code_id = v_code.id and cl.channel = 'pos' for update;
        if found then
          v_allowed := least(v_allowed, v_limit.usage_limit - v_limit.redeemed_count - v_limit.reserved_count);
        end if;
        continue when v_allowed <= 0;
        if v_limit.id is not null then
          update public.promotion_code_channel_limits set reserved_count = reserved_count + v_allowed, updated_at = now() where id = v_limit.id;
        end if;
        update public.promotion_channel_policies set reserved_count = reserved_count + v_allowed, updated_at = now() where id = v_policy.id;
        v_free := v_free - v_allowed;
        insert into public.offline_pos_voucher_grants (tenant_id, offline_grant_id, register_id, promotion_id, code_id,
          allowed_count, max_discount_per_redemption_minor, max_discount_per_grant_minor, requires_admin_credentials,
          policy_version, terms, expires_at)
        values (p_tenant, p_offline_grant_id, v_offline.register_id, v_promo.id, v_code.id, v_allowed,
          v_policy.max_discount_per_redemption_minor, v_policy.max_discount_per_grant_minor,
          v_policy.requires_admin_credentials, v_policy.version, promotions_private.offline_voucher_terms(v_promo, v_code),
          v_offline.accepted_until);
        v_limit := null;
      end loop;
    end if;
  end loop;
  return promotions_private.voucher_grants_json(p_tenant, p_offline_grant_id);
end;
$function$;

-- Expiry sweep (any register) for a scheduler; the bootstrap also sweeps its own register.
create function promotions_private.release_expired_offline_voucher_grants(p_tenant uuid)
returns integer language plpgsql security definer set search_path = '' as $function$
declare v_stale record; v_count integer := 0;
begin
  for v_stale in
    select distinct g.offline_grant_id from public.offline_pos_voucher_grants g
     where g.tenant_id = p_tenant and g.status = 'active' and g.expires_at + interval '5 minutes' < now()
  loop
    if inventory_private.stock_grant_ordinals_complete(p_tenant, v_stale.offline_grant_id, null) then
      v_count := v_count + promotions_private.end_offline_voucher_grants(p_tenant, v_stale.offline_grant_id, 'expired');
    end if;
  end loop;
  return v_count;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Offline redemption (called by record_offline_sale after the order exists, before payment capture)
-- p_voucher: {voucherGrantId, promotionId, codeId?, discountTotalMinor}; p_credential: result of
-- offline_pos_private.consume_admin_assertion (null = accepted).
-- ---------------------------------------------------------------------------------------------------------
create function promotions_private.redeem_offline_voucher(
  p_tenant uuid, p_order uuid, p_offline_grant_id uuid, p_sync uuid, p_voucher jsonb, p_credential text
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_order public.orders%rowtype; v_grant public.offline_pos_voucher_grants%rowtype; v_promo public.promotions%rowtype;
  v_policy public.promotion_channel_policies%rowtype; v_code public.promotion_codes%rowtype;
  v_discount bigint := (p_voucher->>'discountTotalMinor')::bigint; v_lines jsonb := '[]'::jsonb; v_line record;
  v_exception text; v_remaining integer; v_target text; v_basis bigint := 0; v_alloc jsonb; v_a jsonb; v_line_id uuid;
  v_sum bigint := 0; v_adj uuid := gen_random_uuid(); v_terms jsonb;
begin
  select * into v_order from public.orders where tenant_id = p_tenant and id = p_order;
  for v_line in select line_number, id, variant_id, product_id, line_total_minor from public.order_lines
                 where tenant_id = p_tenant and order_id = p_order order by line_number loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ord', v_line.line_number, 'orderLineId', v_line.id,
      'variantId', v_line.variant_id, 'productId', v_line.product_id, 'lineTotalMinor', v_line.line_total_minor));
  end loop;

  select * into v_grant from public.offline_pos_voucher_grants g
   where g.tenant_id = p_tenant and g.id = nullif(p_voucher->>'voucherGrantId', '')::uuid
     and g.offline_grant_id = p_offline_grant_id
     and g.promotion_id = nullif(p_voucher->>'promotionId', '')::uuid
     and g.code_id is not distinct from nullif(p_voucher->>'codeId', '')::uuid
   for update;
  if not found or v_grant.status <> 'active' then
    v_exception := 'VX_GRANT_INVALID';
  else
    v_remaining := v_grant.allowed_count - v_grant.consumed_count - v_grant.released_count;
    select * into v_promo from public.promotions where tenant_id = p_tenant and id = v_grant.promotion_id for update;
    select * into v_policy from public.promotion_channel_policies cp
     where cp.tenant_id = p_tenant and cp.promotion_id = v_grant.promotion_id and cp.channel = 'pos' for update;
    if v_grant.code_id is not null then
      select * into v_code from public.promotion_codes where tenant_id = p_tenant and id = v_grant.code_id for update;
    end if;
    if v_remaining < 1 then
      v_exception := 'VX_GRANT_INVALID';
    elsif v_promo.status <> 'active' or (v_grant.code_id is not null and v_code.status <> 'active') then
      v_exception := 'VX_REVOKED';
    elsif v_policy.id is null or not v_policy.offline_enabled or v_policy.version <> v_grant.policy_version
          or v_promo.global_redemption_limit is not null
          or (v_grant.code_id is not null and v_code.max_redemptions is not null) then
      v_exception := 'VX_POLICY_WITHDRAWN';
    elsif v_discount <> promotions_private.offline_voucher_discount(v_grant.terms, v_lines) then
      v_exception := 'VX_DISCOUNT_MISMATCH';
    elsif v_discount > v_grant.max_discount_per_redemption_minor
          or v_grant.discount_consumed_minor + v_discount > v_grant.max_discount_per_grant_minor then
      v_exception := 'VX_CAP_EXCEEDED';
    elsif v_grant.requires_admin_credentials and p_credential is not null then
      v_exception := 'VX_' || p_credential;
    end if;
  end if;

  -- Discount snapshot + allocation. The sale stands at the price paid in every case.
  v_terms := coalesce(v_grant.terms, jsonb_build_object('targetType', 'order', 'name', 'Offline discount'));
  v_target := case when v_exception is null then v_terms->>'targetType' else 'order' end;
  for v_a in select value from jsonb_array_elements(v_lines) loop
    if v_target = 'order' or (v_terms->'targetVariantIds') ? (v_a->>'variantId') or (v_terms->'targetProductIds') ? (v_a->>'productId') then
      v_basis := v_basis + (v_a->>'lineTotalMinor')::bigint;
    end if;
  end loop;
  if v_basis < v_discount then
    v_target := 'order';
    select sum((a->>'lineTotalMinor')::bigint) into v_basis from jsonb_array_elements(v_lines) a;
  end if;
  if v_discount <= 0 or v_discount > v_basis then
    raise exception using errcode = 'OS422', message = 'offline voucher discount outside the sale';
  end if;
  v_alloc := promotions_private.allocate(p_tenant, coalesce(v_grant.promotion_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                          v_target, v_lines, v_basis, v_discount);

  if v_grant.id is not null then
    insert into public.order_adjustments(id, tenant_id, order_id, promotion_id, code_id, promotion_name_snapshot,
      benefit_type_snapshot, benefit_value_snapshot, benefit_currency_snapshot, code_snapshot, target_type_snapshot,
      gross_subtotal_minor, eligible_basis_minor, discount_total_minor)
    values (v_adj, p_tenant, p_order, v_grant.promotion_id, v_grant.code_id, coalesce(v_terms->>'name', 'Offline voucher'),
      v_terms->>'benefitType', coalesce((v_terms->>'benefitPercentBp')::bigint, (v_terms->>'benefitAmountMinor')::bigint),
      v_terms->>'benefitCurrency', v_terms->>'code', v_target, v_order.gross_subtotal_minor, v_basis, v_discount);
    for v_a in select value from jsonb_array_elements(v_alloc) loop
      continue when (v_a->>'discountMinor')::bigint = 0;
      select id into v_line_id from public.order_lines where tenant_id = p_tenant and order_id = p_order
         and line_number = (v_a->>'ord')::int;
      insert into public.order_line_adjustments(tenant_id, order_id, order_line_id, promotion_id, discount_minor)
      values (p_tenant, p_order, v_line_id, v_grant.promotion_id, (v_a->>'discountMinor')::bigint);
      v_sum := v_sum + (v_a->>'discountMinor')::bigint;
    end loop;
    if v_sum <> v_discount then
      raise exception using errcode = 'PR500', message = 'allocation did not reconcile to discount total';
    end if;
  end if;

  if v_exception is null then
    update public.promotions set redemption_count = redemption_count + 1, updated_at = now() where tenant_id = p_tenant and id = v_promo.id;
    if v_grant.code_id is not null then
      update public.promotion_codes set redemption_count = redemption_count + 1, updated_at = now() where tenant_id = p_tenant and id = v_grant.code_id;
    end if;
    perform set_config('promotions_private.offline_voucher_grant', 'on', true);
    insert into public.promotion_redemptions(tenant_id, promotion_id, code_id, order_id, customer_id, channel, discount_total_minor)
    values (p_tenant, v_promo.id, v_grant.code_id, p_order, v_order.customer_id, 'pos', v_discount);
    perform set_config('promotions_private.offline_voucher_grant', 'off', true);
    update public.offline_pos_voucher_grants set consumed_count = consumed_count + 1,
           discount_consumed_minor = discount_consumed_minor + v_discount where id = v_grant.id;
  else
    insert into public.offline_voucher_exceptions(tenant_id, order_id, offline_grant_id, voucher_grant_id, promotion_id,
      code_id, sync_command_id, code, discount_total_minor)
    values (p_tenant, p_order, p_offline_grant_id, v_grant.id, coalesce(v_grant.promotion_id, nullif(p_voucher->>'promotionId', '')::uuid),
      coalesce(v_grant.code_id, nullif(p_voucher->>'codeId', '')::uuid), p_sync, v_exception, v_discount);
    if v_grant.id is not null and v_grant.status = 'active' and v_remaining >= 1 then
      perform promotions_private.voucher_grant_release_one(v_grant, 1);
    end if;
  end if;

  perform orders_private.apply_order_discount(p_tenant, p_order, v_discount);
  return jsonb_build_object('state', case when v_exception is null then 'redeemed' else 'exception' end,
                            'exceptionCode', v_exception, 'discountTotalMinor', v_discount);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Management (API-authorized with promotions.manage)
-- ---------------------------------------------------------------------------------------------------------
create function promotions_private.channel_policies(p_tenant uuid, p_promotion uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'promotionId', p_promotion,
    'policies', coalesce((select jsonb_agg(jsonb_build_object(
      'channel', cp.channel, 'usageLimit', cp.usage_limit, 'redeemedCount', cp.redeemed_count,
      'reservedCount', cp.reserved_count, 'offlineEnabled', cp.offline_enabled,
      'offlineQuotaPerGrant', cp.offline_quota_per_grant, 'requiresAdminCredentials', cp.requires_admin_credentials,
      'maxDiscountPerRedemptionMinor', cp.max_discount_per_redemption_minor,
      'maxDiscountPerGrantMinor', cp.max_discount_per_grant_minor, 'version', cp.version,
      'updatedAt', cp.updated_at) order by cp.channel)
      from public.promotion_channel_policies cp where cp.tenant_id = p_tenant and cp.promotion_id = p_promotion), '[]'::jsonb),
    'codeLimits', coalesce((select jsonb_agg(jsonb_build_object(
      'codeId', cl.code_id, 'code', c.normalized_code, 'channel', cl.channel, 'usageLimit', cl.usage_limit,
      'redeemedCount', cl.redeemed_count, 'reservedCount', cl.reserved_count) order by c.normalized_code, cl.channel)
      from public.promotion_code_channel_limits cl join public.promotion_codes c on c.tenant_id = cl.tenant_id and c.id = cl.code_id
      where cl.tenant_id = p_tenant and c.promotion_id = p_promotion), '[]'::jsonb));
$function$;

-- p_payload: {usageLimit, offlineEnabled, offlineQuotaPerGrant, requiresAdminCredentials,
--             maxDiscountPerRedemptionMinor, maxDiscountPerGrantMinor}
-- Any change that narrows offline authority bumps version, so outstanding grants turn into exceptions
-- (VX_POLICY_WITHDRAWN) instead of being honoured under the old terms.
create function promotions_private.upsert_channel_policy(p_tenant uuid, p_promotion uuid, p_channel text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_old public.promotion_channel_policies%rowtype; v_new public.promotion_channel_policies%rowtype; v_bump boolean := false;
begin
  if p_channel not in ('pos', 'online') then raise exception using errcode = '22023', message = 'channel must be pos or online'; end if;
  perform 1 from public.promotions where tenant_id = p_tenant and id = p_promotion for update;
  if not found then raise exception using errcode = 'PR404', message = 'promotion not found'; end if;
  select * into v_old from public.promotion_channel_policies where tenant_id = p_tenant and promotion_id = p_promotion and channel = p_channel for update;
  v_new.usage_limit := nullif(p_payload->>'usageLimit', '')::bigint;
  v_new.offline_enabled := coalesce((p_payload->>'offlineEnabled')::boolean, false);
  v_new.offline_quota_per_grant := nullif(p_payload->>'offlineQuotaPerGrant', '')::integer;
  v_new.requires_admin_credentials := coalesce((p_payload->>'requiresAdminCredentials')::boolean, false);
  v_new.max_discount_per_redemption_minor := nullif(p_payload->>'maxDiscountPerRedemptionMinor', '')::bigint;
  v_new.max_discount_per_grant_minor := nullif(p_payload->>'maxDiscountPerGrantMinor', '')::bigint;
  if v_old.id is not null and v_new.usage_limit is not null and v_new.usage_limit < v_old.redeemed_count + v_old.reserved_count then
    raise exception using errcode = 'PR422', message = 'usage limit below uses already redeemed or reserved';
  end if;
  if v_old.id is not null then
    v_bump := (v_old.offline_enabled and not v_new.offline_enabled)
      or (v_new.requires_admin_credentials and not v_old.requires_admin_credentials)
      or coalesce(v_new.max_discount_per_redemption_minor, 0) < coalesce(v_old.max_discount_per_redemption_minor, 0)
      or coalesce(v_new.max_discount_per_grant_minor, 0) < coalesce(v_old.max_discount_per_grant_minor, 0);
    update public.promotion_channel_policies set usage_limit = v_new.usage_limit, offline_enabled = v_new.offline_enabled,
      offline_quota_per_grant = v_new.offline_quota_per_grant, requires_admin_credentials = v_new.requires_admin_credentials,
      max_discount_per_redemption_minor = v_new.max_discount_per_redemption_minor,
      max_discount_per_grant_minor = v_new.max_discount_per_grant_minor,
      version = version + case when v_bump then 1 else 0 end, updated_at = now()
     where id = v_old.id;
  else
    insert into public.promotion_channel_policies (tenant_id, promotion_id, channel, usage_limit, offline_enabled,
      offline_quota_per_grant, requires_admin_credentials, max_discount_per_redemption_minor, max_discount_per_grant_minor)
    values (p_tenant, p_promotion, p_channel, v_new.usage_limit, v_new.offline_enabled, v_new.offline_quota_per_grant,
      v_new.requires_admin_credentials, v_new.max_discount_per_redemption_minor, v_new.max_discount_per_grant_minor);
  end if;
  return promotions_private.channel_policies(p_tenant, p_promotion);
end;
$function$;

create function promotions_private.upsert_code_channel_limit(p_tenant uuid, p_code uuid, p_channel text, p_usage_limit bigint)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_promotion uuid; v_old public.promotion_code_channel_limits%rowtype;
begin
  if p_channel not in ('pos', 'online') then raise exception using errcode = '22023', message = 'channel must be pos or online'; end if;
  select c.promotion_id into v_promotion from public.promotion_codes c where c.tenant_id = p_tenant and c.id = p_code for update;
  if not found then raise exception using errcode = 'PR404', message = 'promotion code not found'; end if;
  select * into v_old from public.promotion_code_channel_limits where tenant_id = p_tenant and code_id = p_code and channel = p_channel for update;
  if p_usage_limit is null then
    if v_old.id is not null and (v_old.redeemed_count > 0 or v_old.reserved_count > 0) then
      raise exception using errcode = 'PR422', message = 'a used code limit cannot be removed';
    end if;
    -- Removing an unused limit is represented by never having one: nothing to keep.
    return promotions_private.channel_policies(p_tenant, v_promotion);
  end if;
  if v_old.id is not null then
    if p_usage_limit < v_old.redeemed_count + v_old.reserved_count then
      raise exception using errcode = 'PR422', message = 'usage limit below uses already redeemed or reserved';
    end if;
    update public.promotion_code_channel_limits set usage_limit = p_usage_limit, updated_at = now() where id = v_old.id;
  else
    insert into public.promotion_code_channel_limits (tenant_id, code_id, channel, usage_limit)
    values (p_tenant, p_code, p_channel, p_usage_limit);
  end if;
  return promotions_private.channel_policies(p_tenant, v_promotion);
end;
$function$;

-- Report of offline discount exceptions (report-only; no tasks).
create function promotions_private.offline_voucher_exception_report(p_tenant uuid, p_limit integer, p_offset integer)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(jsonb_agg(jsonb_build_object('orderId', e.order_id, 'promotionId', e.promotion_id, 'codeId', e.code_id,
    'code', e.code, 'discountTotalMinor', e.discount_total_minor, 'createdAt', e.created_at) order by e.created_at desc, e.id), '[]'::jsonb)
  from (select * from public.offline_voucher_exceptions x where x.tenant_id = p_tenant
         order by x.created_at desc, x.id limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) e;
$function$;

-- ---------------------------------------------------------------------------------------------------------
-- Ownership + grants
-- ---------------------------------------------------------------------------------------------------------
grant select on public.offline_grants, public.offline_sale_ingestions to promotions_writer;
create policy promotions_writer_offline_grant_read on public.offline_grants for select to promotions_writer using (true);
create policy promotions_writer_offline_ingestion_read on public.offline_sale_ingestions for select to promotions_writer using (true);
grant select on public.order_lines to promotions_writer;
grant usage on schema inventory_private to promotions_writer;
grant execute on function inventory_private.stock_grant_ordinals_complete(uuid, uuid, integer) to promotions_writer;

grant create on schema public, promotions_private to promotions_writer;
alter table public.promotion_channel_policies owner to promotions_writer;
alter table public.promotion_code_channel_limits owner to promotions_writer;
alter table public.offline_pos_voucher_grants owner to promotions_writer;
alter table public.offline_voucher_exceptions owner to promotions_writer;
alter function promotions_private.channel_has_capacity(uuid, uuid, uuid, text) owner to promotions_writer;
alter function promotions_private.channel_redemption_guard() owner to promotions_writer;
alter function promotions_private.offline_voucher_terms(public.promotions, public.promotion_codes) owner to promotions_writer;
alter function promotions_private.offline_voucher_discount(jsonb, jsonb) owner to promotions_writer;
alter function promotions_private.voucher_grant_release_one(public.offline_pos_voucher_grants, integer) owner to promotions_writer;
alter function promotions_private.end_offline_voucher_grants(uuid, uuid, text) owner to promotions_writer;
alter function promotions_private.voucher_grants_json(uuid, uuid) owner to promotions_writer;
alter function promotions_private.issue_offline_voucher_grants(uuid, uuid, uuid, integer) owner to promotions_writer;
alter function promotions_private.release_expired_offline_voucher_grants(uuid) owner to promotions_writer;
alter function promotions_private.redeem_offline_voucher(uuid, uuid, uuid, uuid, jsonb, text) owner to promotions_writer;
alter function promotions_private.channel_policies(uuid, uuid) owner to promotions_writer;
alter function promotions_private.upsert_channel_policy(uuid, uuid, text, jsonb) owner to promotions_writer;
alter function promotions_private.upsert_code_channel_limit(uuid, uuid, text, bigint) owner to promotions_writer;
alter function promotions_private.offline_voucher_exception_report(uuid, integer, integer) owner to promotions_writer;
revoke create on schema public, promotions_private from promotions_writer;
revoke all on function
  promotions_private.channel_has_capacity(uuid, uuid, uuid, text),
  promotions_private.channel_redemption_guard(),
  promotions_private.offline_voucher_terms(public.promotions, public.promotion_codes),
  promotions_private.offline_voucher_discount(jsonb, jsonb),
  promotions_private.voucher_grant_release_one(public.offline_pos_voucher_grants, integer),
  promotions_private.end_offline_voucher_grants(uuid, uuid, text),
  promotions_private.voucher_grants_json(uuid, uuid),
  promotions_private.issue_offline_voucher_grants(uuid, uuid, uuid, integer),
  promotions_private.release_expired_offline_voucher_grants(uuid),
  promotions_private.redeem_offline_voucher(uuid, uuid, uuid, uuid, jsonb, text),
  promotions_private.channel_policies(uuid, uuid),
  promotions_private.upsert_channel_policy(uuid, uuid, text, jsonb),
  promotions_private.upsert_code_channel_limit(uuid, uuid, text, bigint),
  promotions_private.offline_voucher_exception_report(uuid, integer, integer)
from public;
grant usage on schema promotions_private to offline_pos_writer;
grant execute on function promotions_private.redeem_offline_voucher(uuid, uuid, uuid, uuid, jsonb, text) to offline_pos_writer;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      promotions_private.issue_offline_voucher_grants(uuid, uuid, uuid, integer),
      promotions_private.release_expired_offline_voucher_grants(uuid),
      promotions_private.channel_policies(uuid, uuid),
      promotions_private.upsert_channel_policy(uuid, uuid, text, jsonb),
      promotions_private.upsert_code_channel_limit(uuid, uuid, text, bigint),
      promotions_private.offline_voucher_exception_report(uuid, integer, integer)
    to service_role;
    grant select on public.promotion_channel_policies, public.promotion_code_channel_limits,
      public.offline_pos_voucher_grants, public.offline_voucher_exceptions to service_role;
  end if;
end $b$;

-- ---------------------------------------------------------------------------------------------------------
-- Quoting: evaluate (20261113120000) with the channel capacity filter added to both candidate queries.
-- ---------------------------------------------------------------------------------------------------------
create or replace function promotions_private.evaluate(
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
  v_best_promo public.promotions%rowtype;
  v_best_code public.promotion_codes%rowtype;
  v_best_source text;
  v_best_discount bigint := 0;
  v_best_basis bigint := 0;
  v_have_best boolean := false;
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

  for v_promo in
    select * from public.promotions p
    where p.tenant_id = p_tenant and p.status = 'active' and p.activation_type = 'automatic'
      and (p.starts_at is null or p.starts_at <= v_now)
      and (p.ends_at is null or p.ends_at > v_now)
      and (p.channel is null or p.channel = p_channel)
      and (p.brand_id is null or p.brand_id = p_brand)
      and (p.branch_id is null or p.branch_id = p_branch)
      and (p.global_redemption_limit is null or p.redemption_count < p.global_redemption_limit)
      and promotions_private.channel_has_capacity(p.tenant_id, p.id, null::uuid, p_channel)
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
      and promotions_private.channel_has_capacity(p.tenant_id, p.id, c.id, p_channel)
      and (p.benefit_type <> 'fixed_amount' or p.benefit_currency = p_currency)
  loop
    v_source := case when v_promo.activation_type = 'code' then 'code' else 'automatic' end;
    if v_source = 'code' then
      select * into v_code from public.promotion_codes c
      where c.tenant_id = p_tenant and c.promotion_id = v_promo.id and c.normalized_code = v_code_norm;
      v_code_status := 'valid';
    end if;

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

    if v_promo.min_subtotal_minor is not null and v_gross < v_promo.min_subtotal_minor then
      continue;
    end if;
    if v_basis <= 0 then
      continue;
    end if;

    if v_promo.benefit_type = 'percentage' then
      v_discount := floor(v_basis::numeric * v_promo.benefit_percent_bp::numeric / 10000)::bigint;
    elsif v_promo.benefit_type = 'buy_x_get_y' then
      v_discount := promotions_private.bxgy_discount(
        p_tenant, v_promo.id, v_promo.target_type, v_promo.buy_quantity, v_promo.get_quantity, p_lines);
    else
      v_discount := least(v_promo.benefit_amount_minor, v_basis);
    end if;
    if v_promo.max_discount_minor is not null then
      v_discount := least(v_discount, v_promo.max_discount_minor);
    end if;
    v_discount := least(v_discount, v_gross, v_basis);
    if v_discount <= 0 then
      continue;
    end if;

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
    'benefitValue', case
      when v_best_promo.benefit_type = 'percentage' then v_best_promo.benefit_percent_bp::bigint
      when v_best_promo.benefit_type = 'buy_x_get_y' then v_best_promo.get_quantity::bigint
      else v_best_promo.benefit_amount_minor end,
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

-- ---------------------------------------------------------------------------------------------------------
-- Offline sale ingestion: 20261114160000 plus the voucher block (net totals, redemption before capture).
-- ---------------------------------------------------------------------------------------------------------
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
   v_credential:=offline_pos_private.consume_admin_assertion(p_tenant_id,v_grant.id,v_sync,p_command->'voucher'->'adminAssertion','promotions.manage');
   v_voucher:=promotions_private.redeem_offline_voucher(p_tenant_id,v_order,v_grant.id,v_sync,p_command->'voucher',v_credential);
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
     if coalesce(v_quantity,0)<(v_element->>'quantity')::bigint then v_sufficient:=false; end if;
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
