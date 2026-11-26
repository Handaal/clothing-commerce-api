-- ADR-042 §13.6 — OFFLINE REDEMPTION OF EXISTING VOUCHERS FROM A CACHED POLICY SNAPSHOT (owner decision
-- 2026-11-15). Forward-only and additive. Nothing applied earlier is edited or dropped.
--
-- The superseded design (20261114170000) RESERVED voucher quota into per-till grants. That entry point is
-- revoked (20261115150000) and stays dormant. This migration replaces it with:
--
-- Part A  offline_voucher_policy_issuances: an immutable server-side record of exactly which voucher policy
--         each offline grant (lease) received at bootstrap: the canonical terms, the channel-policy version,
--         a SHA-256 policy digest and the SHARED remaining usage OBSERVED at fetch time. Issuing it reserves
--         NOTHING: no counter moves, no quota is partitioned, the Website keeps consuming the same limits.
-- Part B  promotions_private.redeem_offline_voucher_cached: reconciliation at sync. The completed sale ALWAYS
--         stands at the cashier-recorded price. If the snapshot is valid, the voucher is still live, unchanged
--         and has shared capacity, exactly one ordinary redemption is recorded. Otherwise a deterministic
--         exception (VX_*) with evidence is written; the contested discount is applied to the order total (so
--         order total = tender) but is NOT attributed to the promotion and is NOT a redemption. No later
--         charge, no reprice, no approval task.
-- Part C  The voucher exception evidence columns + the Sync Conflicts detector now carry observed vs server
--         remaining usage, policy digests/versions, and the local sale reference.
-- Part D  record_offline_sale routes a cached-policy voucher (command carries policyIssuanceId) to Part B.
--
-- Eligibility for a cached offline policy (anything else stays ONLINE-ONLY, fail closed):
--   * a 'pos' channel policy with offline_enabled = true and requires_admin_credentials = false
--     (credential-gated vouchers are never issued: the offline override check is not yet proven to bind the
--     password to the exact transaction — see ADR-042 §13.6);
--   * code-activated, active, started, not ended, channel null|'pos', branch null|grant branch, brand null
--     (the 'ov1' till formula has no brand input), benefit percentage|fixed_amount (fixed in grant currency);
--   * the code is active and the shared remaining usage observed now is > 0 (or unlimited).

-- =========================================================================================================
-- Part A — issuance record
-- =========================================================================================================
create table public.offline_voucher_policy_issuances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  offline_grant_id uuid not null,
  register_id uuid not null,
  device_id uuid not null,
  promotion_id uuid not null,
  code_id uuid not null,
  code_fingerprint text not null,
  channel_policy_version integer not null,
  policy_digest text not null,
  calculation_version text not null default 'ov1',
  terms jsonb not null,
  observed_remaining bigint,
  max_discount_per_redemption_minor bigint,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint offline_voucher_policy_issuances_grant_fk foreign key (tenant_id, offline_grant_id)
    references public.offline_grants (tenant_id, id) on delete restrict,
  constraint offline_voucher_policy_issuances_promotion_fk foreign key (tenant_id, promotion_id)
    references public.promotions (tenant_id, id) on delete restrict,
  constraint offline_voucher_policy_issuances_code_fk foreign key (tenant_id, code_id)
    references public.promotion_codes (tenant_id, id) on delete restrict,
  constraint offline_voucher_policy_issuances_digest check (policy_digest ~ '^[0-9a-f]{64}$'),
  constraint offline_voucher_policy_issuances_fingerprint check (code_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint offline_voucher_policy_issuances_calc check (calculation_version = 'ov1'),
  constraint offline_voucher_policy_issuances_remaining check (observed_remaining is null or observed_remaining > 0),
  constraint offline_voucher_policy_issuances_cap check (
    max_discount_per_redemption_minor is null or max_discount_per_redemption_minor > 0),
  constraint offline_voucher_policy_issuances_window check (expires_at > fetched_at),
  constraint offline_voucher_policy_issuances_unique unique (tenant_id, offline_grant_id, code_id),
  constraint offline_voucher_policy_issuances_tenant_id_unique unique (tenant_id, id)
);
comment on table public.offline_voucher_policy_issuances is
  'ADR-042 §13.6: the cached voucher policy each offline lease received (terms, digest, shared remaining usage OBSERVED at fetch). Reserves nothing; the Website keeps consuming the same shared limits. Immutable.';
alter table public.offline_voucher_policy_issuances enable row level security;
revoke all on public.offline_voucher_policy_issuances from public;
create trigger offline_voucher_policy_issuances_immutable
  before update or delete on public.offline_voucher_policy_issuances
  for each row execute function promotions_private.forbid_history_mutation();

-- Shared remaining usage right now (null = no finite limit). Every finite limit that an ordinary POS
-- redemption would hit: promotion global limit, code max, POS channel policy, POS code channel limit.
create function promotions_private.voucher_shared_remaining(p_tenant uuid, p_promotion uuid, p_code uuid)
returns bigint language sql stable security definer set search_path = '' as $function$
  select least(
    (select p.global_redemption_limit - p.redemption_count from public.promotions p
      where p.tenant_id = p_tenant and p.id = p_promotion and p.global_redemption_limit is not null),
    (select c.max_redemptions - c.redemption_count from public.promotion_codes c
      where c.tenant_id = p_tenant and c.id = p_code and c.max_redemptions is not null),
    (select cp.usage_limit - cp.redeemed_count - cp.reserved_count from public.promotion_channel_policies cp
      where cp.tenant_id = p_tenant and cp.promotion_id = p_promotion and cp.channel = 'pos'
        and cp.usage_limit is not null),
    (select cl.usage_limit - cl.redeemed_count - cl.reserved_count from public.promotion_code_channel_limits cl
      where cl.tenant_id = p_tenant and cl.code_id = p_code and cl.channel = 'pos'));
$function$;

-- Canonical terms shipped to the till: the 20261114170000 'ov1' terms WITHOUT the raw code text.
create function promotions_private.offline_voucher_cached_terms(p_promo public.promotions, p_code public.promotion_codes)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select promotions_private.offline_voucher_terms(p_promo, p_code) - 'code';
$function$;

-- SHA-256 over the jsonb text of everything that decides the offline discount and its authority. jsonb::text
-- is deterministic for equal values, so recomputing from live rows detects ANY change.
create function promotions_private.offline_voucher_policy_digest(
  p_promo public.promotions, p_code public.promotion_codes, p_policy public.promotion_channel_policies
) returns text language sql stable security definer set search_path = '' as $function$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'calculationVersion', 'ov1',
    'terms', promotions_private.offline_voucher_cached_terms(p_promo, p_code),
    'startsAt', p_promo.starts_at,
    'channel', p_promo.channel, 'branchId', p_promo.branch_id, 'brandId', p_promo.brand_id,
    'promotionStatus', p_promo.status, 'codeStatus', p_code.status,
    'channelPolicyVersion', p_policy.version, 'offlineEnabled', p_policy.offline_enabled,
    'requiresAdminCredentials', p_policy.requires_admin_credentials,
    'maxDiscountPerRedemptionMinor', p_policy.max_discount_per_redemption_minor)::text, 'UTF8')), 'hex');
$function$;

create function promotions_private.offline_voucher_policies_json(p_tenant uuid, p_offline_grant_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'policyIssuanceId', i.id, 'promotionId', i.promotion_id, 'codeId', i.code_id,
    'codeFingerprint', i.code_fingerprint, 'channelPolicyVersion', i.channel_policy_version,
    'policyDigest', i.policy_digest, 'calculationVersion', i.calculation_version,
    'observedRemaining', i.observed_remaining,
    'maxDiscountPerRedemptionMinor', i.max_discount_per_redemption_minor,
    'requiresAdminCredentials', false,
    'fetchedAt', i.fetched_at, 'expiresAt', i.expires_at, 'terms', i.terms)
    order by i.promotion_id, i.code_id), '[]'::jsonb)
  from public.offline_voucher_policy_issuances i
  where i.tenant_id = p_tenant and i.offline_grant_id = p_offline_grant_id;
$function$;

-- Bootstrap: record (once per lease) the cached policy of every eligible voucher. Idempotent per lease: a
-- replayed bootstrap returns the same rows. Moves no counter.
create function promotions_private.issue_offline_voucher_policies(p_tenant uuid, p_offline_grant_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_grant public.offline_grants%rowtype; v_promo public.promotions%rowtype;
  v_code public.promotion_codes%rowtype; v_policy public.promotion_channel_policies%rowtype;
  v_remaining bigint; v_now timestamptz := now(); v_ids record;
begin
  select * into v_grant from public.offline_grants g where g.tenant_id = p_tenant and g.id = p_offline_grant_id;
  if not found then raise exception using errcode = 'OG404', message = 'grant not found'; end if;
  if exists (select 1 from public.offline_voucher_policy_issuances i
              where i.tenant_id = p_tenant and i.offline_grant_id = p_offline_grant_id) then
    return promotions_private.offline_voucher_policies_json(p_tenant, p_offline_grant_id);
  end if;
  for v_ids in
    select cp.id as policy_id, p.id as promotion_id, c.id as code_id
      from public.promotion_channel_policies cp
      join public.promotions p on p.tenant_id = cp.tenant_id and p.id = cp.promotion_id
      join public.promotion_codes c on c.tenant_id = p.tenant_id and c.promotion_id = p.id
     where cp.tenant_id = p_tenant and cp.channel = 'pos' and cp.offline_enabled
       and not cp.requires_admin_credentials
       and p.status = 'active' and p.activation_type = 'code'
       and (p.starts_at is null or p.starts_at <= v_now) and (p.ends_at is null or p.ends_at > v_now)
       and (p.channel is null or p.channel = 'pos')
       and (p.branch_id is null or p.branch_id = v_grant.branch_id)
       and p.brand_id is null
       and p.benefit_type in ('percentage', 'fixed_amount')
       and (p.benefit_type <> 'fixed_amount' or p.benefit_currency = v_grant.currency)
       and c.status = 'active'
     order by p.id, c.id
  loop
    select * into v_policy from public.promotion_channel_policies where id = v_ids.policy_id;
    select * into v_promo from public.promotions where tenant_id = p_tenant and id = v_ids.promotion_id;
    select * into v_code from public.promotion_codes where tenant_id = p_tenant and id = v_ids.code_id;
    v_remaining := promotions_private.voucher_shared_remaining(p_tenant, v_promo.id, v_code.id);
    continue when v_remaining is not null and v_remaining <= 0;
    insert into public.offline_voucher_policy_issuances (tenant_id, offline_grant_id, register_id, device_id,
      promotion_id, code_id, code_fingerprint, channel_policy_version, policy_digest, terms, observed_remaining,
      max_discount_per_redemption_minor, fetched_at, expires_at)
    values (p_tenant, v_grant.id, v_grant.register_id, v_grant.device_id, v_promo.id, v_code.id,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_tenant::text || ':' || v_code.normalized_code, 'UTF8')), 'hex'),
      v_policy.version, promotions_private.offline_voucher_policy_digest(v_promo, v_code, v_policy),
      promotions_private.offline_voucher_cached_terms(v_promo, v_code), v_remaining,
      v_policy.max_discount_per_redemption_minor, v_now,
      least(v_grant.accepted_until, coalesce(v_promo.ends_at, v_grant.accepted_until)));
  end loop;
  return promotions_private.offline_voucher_policies_json(p_tenant, p_offline_grant_id);
end;
$function$;

-- =========================================================================================================
-- Part C — exception evidence (columns first: Part B writes them)
-- =========================================================================================================
alter table public.offline_voucher_exceptions
  add column policy_issuance_id uuid,
  add column register_id uuid,
  add column device_id uuid,
  add column local_sale_id text,
  add column accepted_at timestamptz,
  add column observed_remaining bigint,
  add column server_remaining bigint,
  add column local_policy_digest text,
  add column server_policy_digest text,
  add column local_channel_policy_version integer,
  add column server_channel_policy_version integer,
  add column evidence jsonb not null default '{}'::jsonb;
alter table public.offline_voucher_exceptions drop constraint offline_voucher_exceptions_code;
alter table public.offline_voucher_exceptions add constraint offline_voucher_exceptions_code check (code in (
  'VX_GRANT_INVALID', 'VX_REVOKED', 'VX_POLICY_WITHDRAWN', 'VX_DISCOUNT_MISMATCH', 'VX_CAP_EXCEEDED',
  'VX_CREDENTIAL_MISSING', 'VX_CREDENTIAL_INVALID', 'VX_CREDENTIAL_NOT_ISSUED', 'VX_CREDENTIAL_REUSED',
  -- ADR-042 §13.6 cached-policy reconciliation:
  'VX_SNAPSHOT_INVALID', 'VX_EXPIRED', 'VX_POLICY_CHANGED', 'VX_USAGE_EXHAUSTED'));
alter table public.offline_voucher_exceptions add constraint offline_voucher_exceptions_evidence
  check (jsonb_typeof(evidence) = 'object');
comment on column public.offline_voucher_exceptions.discount_total_minor is
  'The contested discount the cashier gave. Applied to the order total (order = tender) but NOT attributed to the promotion and NOT a redemption.';

-- =========================================================================================================
-- Part B — reconciliation at sync
-- p_voucher: {policyIssuanceId, promotionId, codeId, policyDigest, observedRemaining|null, discountTotalMinor}
-- p_context: {registerId, deviceId, localSaleId}
-- =========================================================================================================
create function promotions_private.redeem_offline_voucher_cached(
  p_tenant uuid, p_order uuid, p_offline_grant_id uuid, p_sync uuid, p_voucher jsonb,
  p_accepted timestamptz, p_context jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_order public.orders%rowtype; v_issue public.offline_voucher_policy_issuances%rowtype;
  v_promo public.promotions%rowtype; v_code public.promotion_codes%rowtype;
  v_policy public.promotion_channel_policies%rowtype;
  v_discount bigint := (p_voucher->>'discountTotalMinor')::bigint; v_lines jsonb := '[]'::jsonb; v_line record;
  v_exception text; v_server_digest text; v_remaining bigint; v_basis bigint := 0; v_target text;
  v_alloc jsonb; v_a jsonb; v_line_id uuid; v_sum bigint := 0; v_adj uuid := gen_random_uuid();
  v_since jsonb := '{}'::jsonb;
begin
  select * into v_order from public.orders where tenant_id = p_tenant and id = p_order;
  for v_line in select line_number, id, variant_id, product_id, line_total_minor from public.order_lines
                 where tenant_id = p_tenant and order_id = p_order order by line_number loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ord', v_line.line_number, 'orderLineId', v_line.id,
      'variantId', v_line.variant_id, 'productId', v_line.product_id, 'lineTotalMinor', v_line.line_total_minor));
  end loop;

  select * into v_issue from public.offline_voucher_policy_issuances i
   where i.tenant_id = p_tenant and i.id = nullif(p_voucher->>'policyIssuanceId', '')::uuid
     and i.offline_grant_id = p_offline_grant_id
     and i.promotion_id = nullif(p_voucher->>'promotionId', '')::uuid
     and i.code_id = nullif(p_voucher->>'codeId', '')::uuid;
  if not found or v_issue.policy_digest is distinct from p_voucher->>'policyDigest' then
    v_exception := 'VX_SNAPSHOT_INVALID';
  elsif p_accepted > v_issue.expires_at then
    v_exception := 'VX_EXPIRED';
  elsif v_discount <> promotions_private.offline_voucher_discount(v_issue.terms, v_lines) then
    v_exception := 'VX_DISCOUNT_MISMATCH';
  elsif v_issue.max_discount_per_redemption_minor is not null and v_discount > v_issue.max_discount_per_redemption_minor then
    v_exception := 'VX_CAP_EXCEEDED';
  else
    -- Live, locked state (same lock order as promotions_private.redeem: promotion, then code, then policy).
    select * into v_promo from public.promotions where tenant_id = p_tenant and id = v_issue.promotion_id for update;
    select * into v_code from public.promotion_codes where tenant_id = p_tenant and id = v_issue.code_id for update;
    select * into v_policy from public.promotion_channel_policies cp
     where cp.tenant_id = p_tenant and cp.promotion_id = v_issue.promotion_id and cp.channel = 'pos' for update;
    if v_promo.status <> 'active' or v_code.status <> 'active' then
      v_exception := 'VX_REVOKED';
    elsif (v_promo.ends_at is not null and v_promo.ends_at <= p_accepted)
          or (v_promo.starts_at is not null and v_promo.starts_at > p_accepted) then
      v_exception := 'VX_EXPIRED';
    else
      if v_policy.id is not null then
        v_server_digest := promotions_private.offline_voucher_policy_digest(v_promo, v_code, v_policy);
      end if;
      if v_policy.id is null or v_server_digest is distinct from v_issue.policy_digest then
        v_exception := 'VX_POLICY_CHANGED';
      else
        v_remaining := promotions_private.voucher_shared_remaining(p_tenant, v_promo.id, v_code.id);
        if v_remaining is not null and v_remaining < 1 then
          v_exception := 'VX_USAGE_EXHAUSTED';
        end if;
      end if;
    end if;
  end if;
  if v_exception is not null and v_remaining is null and v_issue.id is not null then
    v_remaining := promotions_private.voucher_shared_remaining(p_tenant, v_issue.promotion_id, v_issue.code_id);
  end if;
  if v_exception is not null and v_policy.id is null and v_issue.id is not null then
    select * into v_policy from public.promotion_channel_policies cp
     where cp.tenant_id = p_tenant and cp.promotion_id = v_issue.promotion_id and cp.channel = 'pos';
  end if;

  -- Basis + allocation. Accepted: the promotion's own target scope. Exception: order-wide, unattributed.
  v_target := case when v_exception is null then v_issue.terms->>'targetType' else 'order' end;
  for v_a in select value from jsonb_array_elements(v_lines) loop
    if v_target = 'order' or (v_issue.terms->'targetVariantIds') ? (v_a->>'variantId')
       or (v_issue.terms->'targetProductIds') ? (v_a->>'productId') then
      v_basis := v_basis + (v_a->>'lineTotalMinor')::bigint;
    end if;
  end loop;
  if v_discount <= 0 or v_discount > v_basis then
    raise exception using errcode = 'OS422', message = 'offline voucher discount outside the sale';
  end if;

  if v_exception is null then
    v_alloc := promotions_private.allocate(p_tenant, v_promo.id, v_target, v_lines, v_basis, v_discount);
    update public.promotions set redemption_count = redemption_count + 1, updated_at = now()
     where tenant_id = p_tenant and id = v_promo.id;
    update public.promotion_codes set redemption_count = redemption_count + 1, updated_at = now()
     where tenant_id = p_tenant and id = v_code.id;
    insert into public.order_adjustments(id, tenant_id, order_id, promotion_id, code_id, promotion_name_snapshot,
      benefit_type_snapshot, benefit_value_snapshot, benefit_currency_snapshot, code_snapshot, target_type_snapshot,
      gross_subtotal_minor, eligible_basis_minor, discount_total_minor)
    values (v_adj, p_tenant, p_order, v_promo.id, v_code.id, coalesce(v_issue.terms->>'name', v_promo.name),
      v_issue.terms->>'benefitType',
      coalesce((v_issue.terms->>'benefitPercentBp')::bigint, (v_issue.terms->>'benefitAmountMinor')::bigint),
      v_issue.terms->>'benefitCurrency', v_code.normalized_code, v_target, v_order.gross_subtotal_minor, v_basis,
      v_discount);
    for v_a in select value from jsonb_array_elements(v_alloc) loop
      continue when (v_a->>'discountMinor')::bigint = 0;
      select id into v_line_id from public.order_lines where tenant_id = p_tenant and order_id = p_order
         and line_number = (v_a->>'ord')::int;
      insert into public.order_line_adjustments(tenant_id, order_id, order_line_id, promotion_id, discount_minor)
      values (p_tenant, p_order, v_line_id, v_promo.id, (v_a->>'discountMinor')::bigint);
      v_sum := v_sum + (v_a->>'discountMinor')::bigint;
    end loop;
    if v_sum <> v_discount then
      raise exception using errcode = 'PR500', message = 'allocation did not reconcile to discount total';
    end if;
    -- Ordinary (non-reserved) path through promotions_private.channel_redemption_guard: it re-checks the
    -- POS channel capacity under its own lock and increments redeemed_count.
    insert into public.promotion_redemptions(tenant_id, promotion_id, code_id, order_id, customer_id, channel, discount_total_minor)
    values (p_tenant, v_promo.id, v_code.id, p_order, v_order.customer_id, 'pos', v_discount);
  else
    if v_issue.id is not null then
      select coalesce(pg_catalog.jsonb_object_agg(r.channel, r.n), '{}'::jsonb) into v_since
        from (select pr.channel, count(*) as n from public.promotion_redemptions pr
               where pr.tenant_id = p_tenant and pr.promotion_id = v_issue.promotion_id
                 and pr.code_id = v_issue.code_id and pr.redeemed_at > v_issue.fetched_at
               group by pr.channel) r;
    end if;
    insert into public.offline_voucher_exceptions(tenant_id, order_id, offline_grant_id, voucher_grant_id,
      promotion_id, code_id, sync_command_id, code, discount_total_minor, policy_issuance_id, register_id,
      device_id, local_sale_id, accepted_at, observed_remaining, server_remaining, local_policy_digest,
      server_policy_digest, local_channel_policy_version, server_channel_policy_version, evidence)
    values (p_tenant, p_order, p_offline_grant_id, null,
      coalesce(v_issue.promotion_id, nullif(p_voucher->>'promotionId', '')::uuid),
      coalesce(v_issue.code_id, nullif(p_voucher->>'codeId', '')::uuid), p_sync, v_exception, v_discount,
      v_issue.id, nullif(p_context->>'registerId', '')::uuid, nullif(p_context->>'deviceId', '')::uuid,
      p_context->>'localSaleId', p_accepted, nullif(p_voucher->>'observedRemaining', '')::bigint, v_remaining,
      left(p_voucher->>'policyDigest', 64), v_server_digest, v_issue.channel_policy_version, v_policy.version,
      pg_catalog.jsonb_build_object('issuedObservedRemaining', v_issue.observed_remaining,
        'snapshotFetchedAt', v_issue.fetched_at, 'snapshotExpiresAt', v_issue.expires_at,
        'redemptionsSinceFetchByChannel', v_since,
        'promotionStatus', v_promo.status, 'codeStatus', v_code.status, 'promotionEndsAt', v_promo.ends_at));
  end if;

  perform orders_private.apply_order_discount(p_tenant, p_order, v_discount);
  return jsonb_build_object('state', case when v_exception is null then 'redeemed' else 'exception' end,
    'exceptionCode', v_exception, 'discountTotalMinor', v_discount, 'policyIssuanceId', v_issue.id,
    'serverRemaining', v_remaining);
end;
$function$;

-- Sync Conflicts detector (replaces 20261115150000 B.2). The ingestion row is written AFTER the redemption in
-- record_offline_sale, so the local reference comes from the exception row itself when present.
create or replace function offline_pos_private.conflicts_from_voucher_exception()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_ing public.offline_sale_ingestions%rowtype; v_grant public.offline_grants%rowtype;
  v_row public.pos_sync_conflicts;
begin
  select * into v_ing from public.offline_sale_ingestions
   where tenant_id = new.tenant_id and sync_command_id = new.sync_command_id;
  select * into v_grant from public.offline_grants where tenant_id = new.tenant_id and id = new.offline_grant_id;
  v_row.tenant_id := new.tenant_id;
  v_row.dedupe_key := 'voucher:' || new.id::text;
  v_row.kind := 'voucher';
  v_row.reason_code := new.code;
  v_row.branch_id := coalesce(v_ing.branch_id, v_grant.branch_id);
  v_row.inventory_location_id := coalesce(v_ing.inventory_location_id, v_grant.inventory_location_id);
  v_row.device_id := coalesce(new.device_id, v_ing.device_id, v_grant.device_id);
  v_row.register_id := coalesce(new.register_id, v_ing.register_id, v_grant.register_id);
  v_row.grant_id := new.offline_grant_id;
  v_row.source_table := 'offline_voucher_exceptions';
  v_row.source_id := new.id;
  v_row.sync_command_id := new.sync_command_id;
  v_row.local_reference := coalesce(new.local_sale_id, v_ing.local_sale_id);
  v_row.order_id := new.order_id;
  v_row.promotion_id := new.promotion_id;
  v_row.amount_minor := new.discount_total_minor;
  v_row.currency := v_grant.currency;
  v_row.local_event_at := coalesce(new.accepted_at, v_ing.accepted_at);
  v_row.local_evidence := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'discountTotalMinor', new.discount_total_minor, 'codeId', new.code_id,
    'voucherGrantId', new.voucher_grant_id, 'policyIssuanceId', new.policy_issuance_id,
    'observedRemaining', new.observed_remaining, 'policyDigest', new.local_policy_digest,
    'channelPolicyVersion', new.local_channel_policy_version,
    'snapshotFetchedAt', new.evidence->'snapshotFetchedAt',
    'snapshotExpiresAt', new.evidence->'snapshotExpiresAt', 'acceptedAt', new.accepted_at));
  v_row.server_evidence := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'exceptionCode', new.code, 'serverRemaining', new.server_remaining,
    'serverPolicyDigest', new.server_policy_digest,
    'serverChannelPolicyVersion', new.server_channel_policy_version,
    'redemptionsSinceFetchByChannel', new.evidence->'redemptionsSinceFetchByChannel',
    'promotionStatus', new.evidence->'promotionStatus', 'codeStatus', new.evidence->'codeStatus',
    'promotionEndsAt', new.evidence->'promotionEndsAt',
    'saleStandsAtPricePaid', true, 'redemptionApproved', false, 'redemptionRecorded', false,
    'discountAttributedToPromotion', false));
  perform offline_pos_private.record_sync_conflict(v_row);
  return new;
end;
$function$;

-- =========================================================================================================
-- Ownership + grants (same pattern as 20261114170000)
-- =========================================================================================================
grant select on public.offline_grants to promotions_writer;
grant create on schema public, promotions_private to promotions_writer;
alter table public.offline_voucher_policy_issuances owner to promotions_writer;
alter function promotions_private.voucher_shared_remaining(uuid, uuid, uuid) owner to promotions_writer;
alter function promotions_private.offline_voucher_cached_terms(public.promotions, public.promotion_codes) owner to promotions_writer;
alter function promotions_private.offline_voucher_policy_digest(public.promotions, public.promotion_codes, public.promotion_channel_policies) owner to promotions_writer;
alter function promotions_private.offline_voucher_policies_json(uuid, uuid) owner to promotions_writer;
alter function promotions_private.issue_offline_voucher_policies(uuid, uuid) owner to promotions_writer;
alter function promotions_private.redeem_offline_voucher_cached(uuid, uuid, uuid, uuid, jsonb, timestamptz, jsonb) owner to promotions_writer;
revoke create on schema public, promotions_private from promotions_writer;
revoke all on function
  promotions_private.voucher_shared_remaining(uuid, uuid, uuid),
  promotions_private.offline_voucher_cached_terms(public.promotions, public.promotion_codes),
  promotions_private.offline_voucher_policy_digest(public.promotions, public.promotion_codes, public.promotion_channel_policies),
  promotions_private.offline_voucher_policies_json(uuid, uuid),
  promotions_private.issue_offline_voucher_policies(uuid, uuid),
  promotions_private.redeem_offline_voucher_cached(uuid, uuid, uuid, uuid, jsonb, timestamptz, jsonb),
  offline_pos_private.conflicts_from_voucher_exception()
from public;
grant execute on function promotions_private.redeem_offline_voucher_cached(uuid, uuid, uuid, uuid, jsonb, timestamptz, jsonb)
  to offline_pos_writer;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function promotions_private.issue_offline_voucher_policies(uuid, uuid) to service_role;
  end if;
end $b$;

-- =========================================================================================================
-- Part D — record_offline_sale (20261114170000 definition; ONLY the voucher block changes)
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
