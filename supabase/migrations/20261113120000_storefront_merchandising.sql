-- Storefront merchandising: catalog sales, Buy-X-Get-Y offers, and editable home-page content.
--
-- 1. Catalog sales (public.catalog_sales + public.catalog_sale_products). A sale is a PER-UNIT price
--    reduction (percentage in basis points, or a fixed minor amount in one currency) scoped to every
--    product, one collection, or selected products, with an optional start/end window. Sales apply to
--    the ONLINE channel only: they change the effective unit price resolved by
--    online_private.resolve_line, so the Storefront catalog display, the non-consuming quote, and the
--    idempotent checkout all agree on the same server-authoritative figure. When several sales match a
--    product the LOWEST resulting price wins (best for the shopper; never stacked). The original list
--    price is surfaced publicly as compareAtAmountMinor so channels can render the struck-through price.
--    Promotions (codes / automatic order discounts) continue to apply on top of the sale-priced lines.
--    POS pricing is untouched.
--
-- 2. Buy-X-Get-Y. The single promotion engine gains benefit_type 'buy_x_get_y' (buy_quantity +
--    get_quantity). For every complete group of (buy + get) qualifying units the cheapest `get` units are
--    free. It remains ONE promotion per order (greatest eligible saving), uses the existing
--    largest-remainder allocation, and is ONLINE-only so older POS SDKs never receive an unknown
--    benefit type. Active automatic offers are surfaced on the public product projection (`offers`).
--
-- 3. Storefront content (public.storefront_content). One row per tenant: hero copy + hero image (an
--    object in the catalog media bucket under "<tenant>/storefront/") and the curated featured product /
--    collection id lists. The public projection only ever returns publicly visible products/collections.
--
-- Boundary: tables have RLS enabled with no policies (deny-by-default for anon/authenticated);
-- service_role holds SELECT only and writes exclusively through the SECURITY DEFINER functions below.

-- =====================================================================================================
-- 1. Catalog sales
-- =====================================================================================================
create table public.catalog_sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  creation_key text,
  name text not null,
  status text not null default 'active',
  benefit_type text not null,
  benefit_percent_bp integer,
  benefit_amount_minor bigint,
  benefit_currency text,
  scope text not null,
  collection_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_sales_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint catalog_sales_collection_fk foreign key (tenant_id, collection_id)
    references public.collections (tenant_id, id) on delete restrict,
  constraint catalog_sales_name_valid check (btrim(name) <> '' and length(name) <= 200),
  constraint catalog_sales_status_valid check (status in ('active', 'inactive')),
  constraint catalog_sales_benefit_type_valid check (benefit_type in ('percentage', 'fixed_amount')),
  constraint catalog_sales_scope_valid check (scope in ('all', 'collection', 'products')),
  constraint catalog_sales_percent_range check (benefit_percent_bp is null or benefit_percent_bp between 1 and 10000),
  constraint catalog_sales_amount_positive check (benefit_amount_minor is null or benefit_amount_minor > 0),
  constraint catalog_sales_currency_valid check (benefit_currency is null or benefit_currency ~ '^[A-Z]{3}$'),
  constraint catalog_sales_benefit_shape check (
    (benefit_type = 'percentage'
      and benefit_percent_bp is not null and benefit_amount_minor is null and benefit_currency is null)
    or (benefit_type = 'fixed_amount'
      and benefit_amount_minor is not null and benefit_currency is not null and benefit_percent_bp is null)
  ),
  constraint catalog_sales_scope_shape check ((scope = 'collection') = (collection_id is not null)),
  constraint catalog_sales_window_ordered check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint catalog_sales_updated_after_created check (updated_at >= created_at),
  constraint catalog_sales_tenant_id_unique unique (tenant_id, id)
);
create unique index catalog_sales_tenant_creation_key_idx
  on public.catalog_sales (tenant_id, creation_key) where creation_key is not null;
create index catalog_sales_tenant_active_idx on public.catalog_sales (tenant_id) where status = 'active';

create table public.catalog_sale_products (
  tenant_id uuid not null,
  sale_id uuid not null,
  product_id uuid not null,
  created_at timestamptz not null default now(),
  constraint catalog_sale_products_pk primary key (tenant_id, sale_id, product_id),
  constraint catalog_sale_products_sale_fk foreign key (tenant_id, sale_id)
    references public.catalog_sales (tenant_id, id) on delete cascade,
  constraint catalog_sale_products_product_fk foreign key (tenant_id, product_id)
    references public.products (tenant_id, id) on delete restrict
);
create index catalog_sale_products_product_idx on public.catalog_sale_products (tenant_id, product_id);

alter table public.catalog_sales enable row level security;
alter table public.catalog_sale_products enable row level security;
revoke all on public.catalog_sales, public.catalog_sale_products from public;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.catalog_sales, public.catalog_sale_products from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.catalog_sales, public.catalog_sale_products from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.catalog_sales, public.catalog_sale_products from service_role;
    grant select on public.catalog_sales, public.catalog_sale_products to service_role;
  end if;
end $b$;

-- Is the sale live right now for this product? (status + window + scope)
create function catalog_private.sale_applies(p_sale public.catalog_sales, p_product uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select p_sale.status = 'active'
    and (p_sale.starts_at is null or p_sale.starts_at <= now())
    and (p_sale.ends_at is null or p_sale.ends_at > now())
    and (
      p_sale.scope = 'all'
      or (p_sale.scope = 'collection' and exists (
        select 1 from public.product_collections m
        where m.tenant_id = p_sale.tenant_id and m.collection_id = p_sale.collection_id
          and m.product_id = p_product))
      or (p_sale.scope = 'products' and exists (
        select 1 from public.catalog_sale_products sp
        where sp.tenant_id = p_sale.tenant_id and sp.sale_id = p_sale.id and sp.product_id = p_product))
    );
$function$;

-- Effective (sale) unit price for one product price. Returns the list price when no sale applies.
-- Lowest resulting price wins; a fixed-amount sale only applies to a price in its own currency and can
-- never take the price below zero.
create function catalog_private.effective_unit_price(
  p_tenant uuid, p_product uuid, p_currency text, p_list_price bigint
) returns bigint language sql stable security definer set search_path = '' as $function$
  select least(p_list_price, coalesce((
    select min(case
      when s.benefit_type = 'percentage'
        then p_list_price - floor(p_list_price::numeric * s.benefit_percent_bp::numeric / 10000)::bigint
      else greatest(0, p_list_price - s.benefit_amount_minor)
    end)
    from public.catalog_sales s
    where s.tenant_id = p_tenant
      and (s.benefit_type <> 'fixed_amount' or s.benefit_currency = p_currency)
      and catalog_private.sale_applies(s, p_product)
  ), p_list_price));
$function$;

create function catalog_private.sale_detail(p_tenant uuid, p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'id', s.id, 'name', s.name, 'status', s.status,
    'benefitType', s.benefit_type, 'benefitPercentBp', s.benefit_percent_bp,
    'benefitAmountMinor', s.benefit_amount_minor, 'benefitCurrency', s.benefit_currency,
    'scope', s.scope, 'collectionId', s.collection_id,
    'productIds', coalesce((select jsonb_agg(sp.product_id order by sp.created_at, sp.product_id)
      from public.catalog_sale_products sp where sp.tenant_id = s.tenant_id and sp.sale_id = s.id), '[]'::jsonb),
    'startsAt', to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt', to_char(s.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'createdAt', to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  from public.catalog_sales s where s.tenant_id = p_tenant and s.id = p_id;
$function$;

create function catalog_private.list_sales(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object('items', coalesce((
    select jsonb_agg(catalog_private.sale_detail(p_tenant, s.id) order by s.created_at desc, s.id desc)
    from public.catalog_sales s where s.tenant_id = p_tenant), '[]'::jsonb));
$function$;

-- Replace the product scope atomically, validating tenant ownership of every product.
create function catalog_private.write_sale_products(p_tenant uuid, p_sale uuid, p_products jsonb)
returns void language plpgsql security definer set search_path = '' as $function$
declare v_id uuid;
begin
  delete from public.catalog_sale_products where tenant_id = p_tenant and sale_id = p_sale;
  if jsonb_typeof(p_products) <> 'array' then return; end if;
  for v_id in select distinct (value #>> '{}')::uuid from jsonb_array_elements(p_products) loop
    if not exists (select 1 from public.products where tenant_id = p_tenant and id = v_id) then
      raise exception using errcode = 'SL422', message = 'sale product not found';
    end if;
    insert into public.catalog_sale_products (tenant_id, sale_id, product_id) values (p_tenant, p_sale, v_id);
  end loop;
end;
$function$;

create function catalog_private.assert_sale_shape(p_tenant uuid, p_sale uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare v public.catalog_sales;
begin
  select * into v from public.catalog_sales where tenant_id = p_tenant and id = p_sale;
  if v.scope = 'products' and not exists (
    select 1 from public.catalog_sale_products where tenant_id = p_tenant and sale_id = p_sale) then
    raise exception using errcode = 'SL422', message = 'a products-scoped sale needs at least one product';
  end if;
end;
$function$;

create function catalog_private.create_sale(p_tenant uuid, p_key text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_id uuid; v_existing uuid; v_key text := nullif(lower(btrim(coalesce(p_key, ''))), '');
begin
  perform pg_advisory_xact_lock(hashtextextended('catalog_sale_create:' || p_tenant::text || ':' || coalesce(v_key, ''), 0));
  if v_key is not null then
    select id into v_existing from public.catalog_sales where tenant_id = p_tenant and creation_key = v_key;
    if found then return catalog_private.sale_detail(p_tenant, v_existing); end if;
  end if;
  if p_payload->>'scope' = 'collection' and not exists (
    select 1 from public.collections where tenant_id = p_tenant and id = (p_payload->>'collectionId')::uuid) then
    raise exception using errcode = 'SL422', message = 'sale collection not found';
  end if;
  insert into public.catalog_sales (tenant_id, creation_key, name, status, benefit_type, benefit_percent_bp,
    benefit_amount_minor, benefit_currency, scope, collection_id, starts_at, ends_at)
  values (p_tenant, v_key, btrim(p_payload->>'name'), coalesce(p_payload->>'status', 'active'),
    p_payload->>'benefitType', (p_payload->>'benefitPercentBp')::int, (p_payload->>'benefitAmountMinor')::bigint,
    p_payload->>'benefitCurrency', p_payload->>'scope',
    case when p_payload->>'scope' = 'collection' then (p_payload->>'collectionId')::uuid else null end,
    (p_payload->>'startsAt')::timestamptz, (p_payload->>'endsAt')::timestamptz)
  returning id into v_id;
  if p_payload->>'scope' = 'products' then
    perform catalog_private.write_sale_products(p_tenant, v_id, p_payload->'productIds');
  end if;
  perform catalog_private.assert_sale_shape(p_tenant, v_id);
  return catalog_private.sale_detail(p_tenant, v_id);
end;
$function$;

-- Sales hold no sale-time history (order lines snapshot the charged unit price), so every field stays
-- editable. Changing the benefit replaces both shapes; changing the scope replaces the targets.
create function catalog_private.update_sale(p_tenant uuid, p_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v public.catalog_sales; v_type text; v_scope text;
begin
  select * into v from public.catalog_sales where tenant_id = p_tenant and id = p_id for update;
  if not found then raise exception using errcode = 'SL404', message = 'sale not found'; end if;
  v_type := coalesce(p_payload->>'benefitType', v.benefit_type);
  v_scope := coalesce(p_payload->>'scope', v.scope);
  if v_scope = 'collection' and (p_payload ? 'collectionId') and not exists (
    select 1 from public.collections where tenant_id = p_tenant and id = (p_payload->>'collectionId')::uuid) then
    raise exception using errcode = 'SL422', message = 'sale collection not found';
  end if;
  update public.catalog_sales set
    name = coalesce(btrim(p_payload->>'name'), name),
    benefit_type = v_type,
    benefit_percent_bp = case when v_type = 'percentage'
      then coalesce((p_payload->>'benefitPercentBp')::int, benefit_percent_bp) else null end,
    benefit_amount_minor = case when v_type = 'fixed_amount'
      then coalesce((p_payload->>'benefitAmountMinor')::bigint, benefit_amount_minor) else null end,
    benefit_currency = case when v_type = 'fixed_amount'
      then coalesce(p_payload->>'benefitCurrency', benefit_currency) else null end,
    scope = v_scope,
    collection_id = case when v_scope = 'collection'
      then coalesce((p_payload->>'collectionId')::uuid, collection_id) else null end,
    starts_at = case when p_payload ? 'startsAt' then (p_payload->>'startsAt')::timestamptz else starts_at end,
    ends_at = case when p_payload ? 'endsAt' then (p_payload->>'endsAt')::timestamptz else ends_at end,
    updated_at = now()
  where tenant_id = p_tenant and id = p_id;
  if v_scope <> 'products' then
    delete from public.catalog_sale_products where tenant_id = p_tenant and sale_id = p_id;
  elsif p_payload ? 'productIds' then
    perform catalog_private.write_sale_products(p_tenant, p_id, p_payload->'productIds');
  end if;
  perform catalog_private.assert_sale_shape(p_tenant, p_id);
  return catalog_private.sale_detail(p_tenant, p_id);
end;
$function$;

create function catalog_private.set_sale_status(p_tenant uuid, p_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if p_status not in ('active', 'inactive') then raise exception using errcode = '22023', message = 'invalid status'; end if;
  update public.catalog_sales set status = p_status, updated_at = now() where tenant_id = p_tenant and id = p_id;
  if not found then raise exception using errcode = 'SL404', message = 'sale not found'; end if;
  return catalog_private.sale_detail(p_tenant, p_id);
end;
$function$;

create function catalog_private.delete_sale(p_tenant uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  delete from public.catalog_sales where tenant_id = p_tenant and id = p_id;
  if not found then raise exception using errcode = 'SL404', message = 'sale not found'; end if;
  return jsonb_build_object('id', p_id, 'deleted', true);
end;
$function$;

-- Online checkout + quote resolve the sale-adjusted unit price. Identical signature/shape as before;
-- only unit_price_minor now reflects the live sale. Order lines snapshot the charged price as always.
create or replace function online_private.resolve_line(p_tenant uuid,p_brand uuid,p_variant uuid,p_currency text,p_quantity bigint)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r record;
begin
  select v.id,v.product_id,v.sku,v.display_name,v.option_signature,p.name,pr.amount_minor into r
    from public.product_variants v
    join public.products p on p.tenant_id=v.tenant_id and p.id=v.product_id
    join public.variant_prices pr on pr.tenant_id=v.tenant_id and pr.variant_id=v.id
    where v.tenant_id=p_tenant and v.id=p_variant and p.brand_id=p_brand
      and v.status='active' and p.status='active' and p.storefront_status='published'
      and pr.status='active' and pr.currency=p_currency
    for share of p,v,pr;
  if not found then raise exception using errcode='OC002',message='variant not sellable'; end if;
  return jsonb_build_object('variant_id',r.id,'product_id',r.product_id,'sku',r.sku,
    'variant_name',r.display_name,'option_summary',r.option_signature,'product_name',r.name,
    'unit_price_minor',catalog_private.effective_unit_price(p_tenant,r.product_id,p_currency,r.amount_minor),
    'quantity',p_quantity);
end;
$function$;
grant usage on schema catalog_private to online_writer;
grant execute on function catalog_private.effective_unit_price(uuid, uuid, text, bigint),
  catalog_private.sale_applies(public.catalog_sales, uuid) to online_writer;

-- =====================================================================================================
-- 2. Buy-X-Get-Y promotion benefit
-- =====================================================================================================
alter table public.promotions
  add column buy_quantity integer,
  add column get_quantity integer;
alter table public.promotions drop constraint promotions_benefit_type_valid;
alter table public.promotions add constraint promotions_benefit_type_valid
  check (benefit_type in ('percentage', 'fixed_amount', 'buy_x_get_y'));
alter table public.promotions drop constraint promotions_benefit_shape_consistent;
alter table public.promotions add constraint promotions_benefit_shape_consistent check (
  (benefit_type = 'percentage'
    and benefit_percent_bp is not null and benefit_amount_minor is null and benefit_currency is null
    and buy_quantity is null and get_quantity is null)
  or (benefit_type = 'fixed_amount'
    and benefit_amount_minor is not null and benefit_currency is not null and benefit_percent_bp is null
    and buy_quantity is null and get_quantity is null)
  or (benefit_type = 'buy_x_get_y'
    and buy_quantity between 1 and 100 and get_quantity between 1 and 100
    and benefit_percent_bp is null and benefit_amount_minor is null and benefit_currency is null
    and channel = 'online')
);
alter table public.order_adjustments drop constraint order_adjustments_benefit_type_snapshot;
alter table public.order_adjustments add constraint order_adjustments_benefit_type_snapshot
  check (benefit_type_snapshot in ('percentage', 'fixed_amount', 'buy_x_get_y'));

-- Sum of the cheapest free units for a Buy-X-Get-Y promotion over the given lines.
create function promotions_private.bxgy_discount(
  p_tenant uuid, p_promotion uuid, p_target_type text, p_buy int, p_get int, p_lines jsonb
) returns bigint language plpgsql stable security definer set search_path = '' as $function$
declare v_units bigint := 0; v_free bigint;
begin
  select coalesce(sum((l->>'quantity')::bigint), 0) into v_units
  from jsonb_array_elements(p_lines) l
  where p_target_type = 'order' or promotions_private.line_matches_targets(
    p_tenant, p_promotion, (l->>'productId')::uuid, (l->>'variantId')::uuid);
  v_free := (v_units / (p_buy + p_get)) * p_get;
  if v_free <= 0 then return 0; end if;
  return (select coalesce(sum(u.price), 0) from (
    select (l->>'lineTotalMinor')::bigint / greatest((l->>'quantity')::bigint, 1) as price
    from jsonb_array_elements(p_lines) l
    cross join lateral generate_series(1, (l->>'quantity')::bigint)
    where p_target_type = 'order' or promotions_private.line_matches_targets(
      p_tenant, p_promotion, (l->>'productId')::uuid, (l->>'variantId')::uuid)
    order by 1 asc
    limit v_free) u);
end;
$function$;

-- The engine, unchanged except for the buy_x_get_y discount branch and its benefitValue (get_quantity).
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

-- Management projections + create learn the two new columns.
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
    'targets', coalesce((select jsonb_agg(jsonb_build_object('productId',t.product_id,'variantId',t.variant_id) order by t.created_at,t.id)
      from public.promotion_targets t where t.tenant_id=p.tenant_id and t.promotion_id=p.id),'[]'::jsonb),
    'codes', coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'code',c.normalized_code,'status',c.status,
      'maxRedemptions',c.max_redemptions,'redemptionCount',c.redemption_count,
      'remainingRedemptions',case when c.max_redemptions is null then null else greatest(0,c.max_redemptions-c.redemption_count) end)
      order by c.created_at,c.id) from public.promotion_codes c where c.tenant_id=p.tenant_id and c.promotion_id=p.id),'[]'::jsonb),
    'remainingRedemptions', case when p.global_redemption_limit is null then null else greatest(0,p.global_redemption_limit-p.redemption_count) end)
  from public.promotions p where p.tenant_id=p_tenant and p.id=p_id;
$function$;

create or replace function promotions_private.create_promotion(p_tenant uuid, p_key text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_id uuid; v_existing uuid; v_target jsonb; v_code jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('promotion_create:'||p_tenant::text||':'||lower(btrim(coalesce(p_key,''))),0));
  if p_key is not null then
    select id into v_existing from public.promotions where tenant_id=p_tenant and creation_key=lower(btrim(p_key));
    if found then return promotions_private.promotion_detail(p_tenant,v_existing); end if;
  end if;
  insert into public.promotions(tenant_id, creation_key, name, description, benefit_type, benefit_percent_bp,
    benefit_amount_minor, benefit_currency, buy_quantity, get_quantity, target_type, activation_type,
    min_subtotal_minor, max_discount_minor, starts_at, ends_at, channel, brand_id, branch_id,
    global_redemption_limit, status)
  values(p_tenant, lower(btrim(p_key)), p_payload->>'name', p_payload->>'description', p_payload->>'benefitType',
    (p_payload->>'benefitPercentBp')::int, (p_payload->>'benefitAmountMinor')::bigint, p_payload->>'benefitCurrency',
    (p_payload->>'buyQuantity')::int, (p_payload->>'getQuantity')::int,
    p_payload->>'targetType', p_payload->>'activationType', (p_payload->>'minSubtotalMinor')::bigint,
    (p_payload->>'maxDiscountMinor')::bigint, (p_payload->>'startsAt')::timestamptz, (p_payload->>'endsAt')::timestamptz,
    case when p_payload->>'benefitType' = 'buy_x_get_y' then 'online' else p_payload->>'channel' end,
    (p_payload->>'brandId')::uuid, (p_payload->>'branchId')::uuid,
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

-- An offer's channel is fixed to online; reject an edit that would move it.
create or replace function promotions_private.update_promotion(p_tenant uuid, p_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v public.promotions%rowtype; economic boolean;
begin
  select * into v from public.promotions where tenant_id=p_tenant and id=p_id for update;
  if not found then raise exception using errcode='PR404',message='promotion not found'; end if;
  economic := p_payload ?| array['benefitPercentBp','benefitAmountMinor','minSubtotalMinor','maxDiscountMinor','channel','brandId','branchId'];
  if economic and v.redemption_count > 0 then
    raise exception using errcode='PR423',message='promotion economics are locked after first redemption';
  end if;
  if v.benefit_type = 'buy_x_get_y' and (p_payload ? 'channel') and p_payload->>'channel' is distinct from 'online' then
    raise exception using errcode='22023',message='buy_x_get_y offers are online-only';
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

grant create on schema promotions_private to promotions_writer;
alter function promotions_private.bxgy_discount(uuid, uuid, text, int, int, jsonb) owner to promotions_writer;
revoke create on schema promotions_private from promotions_writer;
revoke all on function promotions_private.bxgy_discount(uuid, uuid, text, int, int, jsonb) from public;

-- Live automatic offers for one product (public badge projection).
create function catalog_private.product_offers(p_product public.products)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'buyQuantity', p.buy_quantity, 'getQuantity', p.get_quantity)
    order by p.created_at, p.id), '[]'::jsonb)
  from public.promotions p
  where p.tenant_id = p_product.tenant_id and p.status = 'active' and p.activation_type = 'automatic'
    and p.benefit_type = 'buy_x_get_y'
    and (p.starts_at is null or p.starts_at <= now()) and (p.ends_at is null or p.ends_at > now())
    and (p.brand_id is null or p.brand_id = p_product.brand_id)
    and (p.global_redemption_limit is null or p.redemption_count < p.global_redemption_limit)
    and (p.target_type = 'order' or exists (
      select 1 from public.promotion_targets t
      where t.tenant_id = p.tenant_id and t.promotion_id = p.id
        and (t.product_id = p_product.id or t.variant_id in (
          select v.id from public.product_variants v
          where v.tenant_id = p_product.tenant_id and v.product_id = p_product.id))));
$function$;

-- Public product projection: identical to the Phase 2N ATS projection, plus the sale-adjusted price
-- (amountMinor), the original (compareAtAmountMinor, null when not on sale), and the live offers.
create or replace function catalog_public.build_published_product(p_product public.products)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_product.id,
    'brandId', p_product.brand_id,
    'slug', p_product.slug,
    'name', p_product.name,
    'description', p_product.description,
    'publishedAt', p_product.storefront_published_at,
    'media', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', media.id,
          'variantId', media.variant_id,
          'bucket', media.storage_bucket,
          'path', media.storage_path,
          'altText', media.alt_text,
          'position', media.position,
          'isPrimary', media.is_primary
        )
        order by media.is_primary desc, media.position, media.id
      )
      from public.product_media as media
      where media.tenant_id = p_product.tenant_id
        and media.product_id = p_product.id
        and media.status = 'active'
    ), '[]'::jsonb),
    'variants', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', variant.id,
          'sku', variant.sku,
          'displayName', variant.display_name,
          'optionSignature', variant.option_signature,
          'prices', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'currency', priced.currency,
                'amountMinor', priced.effective,
                'compareAtAmountMinor', case when priced.effective < priced.amount_minor then priced.amount_minor else null end
              )
              order by priced.currency
            )
            from (
              select price.currency, price.amount_minor,
                catalog_private.effective_unit_price(p_product.tenant_id, p_product.id, price.currency, price.amount_minor) as effective
              from public.variant_prices as price
              where price.tenant_id = variant.tenant_id
                and price.variant_id = variant.id
                and price.status = 'active'
            ) as priced
          ), '[]'::jsonb),
          'availableQuantity', coalesce((
            select pg_catalog.sum(greatest(0, balance.on_hand_quantity - coalesce((
              select sum(r.quantity-r.consumed_quantity) from public.stock_reservations r
              where r.tenant_id=balance.tenant_id and r.variant_id=balance.variant_id
                and r.inventory_location_id=balance.inventory_location_id and r.status='active'
            ),0)))
            from public.inventory_balances as balance
            where balance.tenant_id = variant.tenant_id
              and balance.variant_id = variant.id
              and (not exists(select 1 from public.storefront_checkout_settings s where s.tenant_id=p_product.tenant_id and s.brand_id=p_product.brand_id)
                or balance.inventory_location_id=(select s.inventory_location_id from public.storefront_checkout_settings s where s.tenant_id=p_product.tenant_id and s.brand_id=p_product.brand_id))
          ), 0)
        )
        order by variant.created_at, variant.id
      )
      from public.product_variants as variant
      where variant.tenant_id = p_product.tenant_id
        and variant.product_id = p_product.id
        and variant.status = 'active'
        and exists (
          select 1 from public.variant_prices as price
          where price.tenant_id = variant.tenant_id
            and price.variant_id = variant.id
            and price.status = 'active'
        )
    ), '[]'::jsonb),
    'offers', catalog_private.product_offers(p_product)
  );
$function$;

-- =====================================================================================================
-- 3. Storefront content (hero + curated featured lists)
-- =====================================================================================================
create table public.storefront_content (
  tenant_id uuid primary key,
  hero_eyebrow text,
  hero_title text,
  hero_subtitle text,
  hero_cta_label text,
  hero_cta_href text,
  hero_image_bucket text,
  hero_image_path text,
  hero_image_alt text,
  featured_heading text,
  featured_product_ids uuid[] not null default '{}',
  featured_collection_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storefront_content_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint storefront_content_eyebrow_len check (hero_eyebrow is null or (btrim(hero_eyebrow) <> '' and length(hero_eyebrow) <= 80)),
  constraint storefront_content_title_len check (hero_title is null or (btrim(hero_title) <> '' and length(hero_title) <= 160)),
  constraint storefront_content_subtitle_len check (hero_subtitle is null or (btrim(hero_subtitle) <> '' and length(hero_subtitle) <= 400)),
  constraint storefront_content_cta_label_len check (hero_cta_label is null or (btrim(hero_cta_label) <> '' and length(hero_cta_label) <= 40)),
  constraint storefront_content_cta_href_safe check (hero_cta_href is null or (length(hero_cta_href) <= 300
    and (hero_cta_href ~ '^/[^/]' or hero_cta_href = '/' or hero_cta_href ~ '^https://'))),
  constraint storefront_content_image_pair check ((hero_image_bucket is null) = (hero_image_path is null)),
  constraint storefront_content_image_scoped check (hero_image_path is null
    or (hero_image_path like tenant_id::text || '/storefront/%' and hero_image_path !~ '\.\.')),
  constraint storefront_content_image_alt_len check (hero_image_alt is null or length(hero_image_alt) <= 300),
  constraint storefront_content_featured_heading_len check (featured_heading is null or (btrim(featured_heading) <> '' and length(featured_heading) <= 120)),
  constraint storefront_content_featured_products_max check (cardinality(featured_product_ids) <= 24),
  constraint storefront_content_featured_collections_max check (cardinality(featured_collection_ids) <= 12)
);
alter table public.storefront_content enable row level security;
revoke all on public.storefront_content from public;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.storefront_content from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.storefront_content from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.storefront_content from service_role;
    grant select on public.storefront_content to service_role;
  end if;
end $b$;

create function catalog_private.storefront_content_detail(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'hero', jsonb_build_object(
      'eyebrow', c.hero_eyebrow, 'title', c.hero_title, 'subtitle', c.hero_subtitle,
      'ctaLabel', c.hero_cta_label, 'ctaHref', c.hero_cta_href,
      'image', case when c.hero_image_path is null then null else jsonb_build_object(
        'bucket', c.hero_image_bucket, 'path', c.hero_image_path, 'altText', c.hero_image_alt) end),
    'featuredHeading', c.featured_heading,
    'featuredProductIds', to_jsonb(c.featured_product_ids),
    'featuredCollectionIds', to_jsonb(c.featured_collection_ids),
    'updatedAt', case when c.tenant_id is null then null
      else to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end)
  from (select 1) one
  left join public.storefront_content c on c.tenant_id = p_tenant;
$function$;

-- Full replacement of the content document (the client always sends the whole editor state).
create function catalog_private.upsert_storefront_content(p_tenant uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_products uuid[] := coalesce((select array_agg((value #>> '{}')::uuid order by ord)
    from jsonb_array_elements(coalesce(p_payload->'featuredProductIds', '[]'::jsonb)) with ordinality as e(value, ord)), '{}');
  v_collections uuid[] := coalesce((select array_agg((value #>> '{}')::uuid order by ord)
    from jsonb_array_elements(coalesce(p_payload->'featuredCollectionIds', '[]'::jsonb)) with ordinality as e(value, ord)), '{}');
  v_hero jsonb := coalesce(p_payload->'hero', '{}'::jsonb);
  v_image jsonb := v_hero->'image';
begin
  if cardinality(v_products) <> (select count(distinct x) from unnest(v_products) x)
    or cardinality(v_collections) <> (select count(distinct x) from unnest(v_collections) x) then
    raise exception using errcode = 'SC422', message = 'featured ids must be unique';
  end if;
  if exists (select 1 from unnest(v_products) x
    where not exists (select 1 from public.products p where p.tenant_id = p_tenant and p.id = x)) then
    raise exception using errcode = 'SC422', message = 'featured product not found';
  end if;
  if exists (select 1 from unnest(v_collections) x
    where not exists (select 1 from public.collections c where c.tenant_id = p_tenant and c.id = x)) then
    raise exception using errcode = 'SC422', message = 'featured collection not found';
  end if;
  insert into public.storefront_content as sc (tenant_id, hero_eyebrow, hero_title, hero_subtitle, hero_cta_label,
    hero_cta_href, hero_image_bucket, hero_image_path, hero_image_alt, featured_heading,
    featured_product_ids, featured_collection_ids)
  values (p_tenant, nullif(btrim(v_hero->>'eyebrow'), ''), nullif(btrim(v_hero->>'title'), ''),
    nullif(btrim(v_hero->>'subtitle'), ''), nullif(btrim(v_hero->>'ctaLabel'), ''),
    nullif(btrim(v_hero->>'ctaHref'), ''),
    case when jsonb_typeof(v_image) = 'object' then v_image->>'bucket' end,
    case when jsonb_typeof(v_image) = 'object' then v_image->>'path' end,
    case when jsonb_typeof(v_image) = 'object' then nullif(btrim(v_image->>'altText'), '') end,
    nullif(btrim(p_payload->>'featuredHeading'), ''), v_products, v_collections)
  on conflict (tenant_id) do update set
    hero_eyebrow = excluded.hero_eyebrow, hero_title = excluded.hero_title,
    hero_subtitle = excluded.hero_subtitle, hero_cta_label = excluded.hero_cta_label,
    hero_cta_href = excluded.hero_cta_href, hero_image_bucket = excluded.hero_image_bucket,
    hero_image_path = excluded.hero_image_path, hero_image_alt = excluded.hero_image_alt,
    featured_heading = excluded.featured_heading,
    featured_product_ids = excluded.featured_product_ids,
    featured_collection_ids = excluded.featured_collection_ids,
    updated_at = now();
  return catalog_private.storefront_content_detail(p_tenant);
end;
$function$;

-- Public projection: only publicly visible products (optionally one brand) and visible collections,
-- in the curated order. Unknown / unpublished ids are silently skipped.
create function catalog_public.get_storefront_content(p_tenant_id uuid, p_brand_id uuid default null)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'hero', case when c.tenant_id is null then null else jsonb_build_object(
      'eyebrow', c.hero_eyebrow, 'title', c.hero_title, 'subtitle', c.hero_subtitle,
      'ctaLabel', c.hero_cta_label, 'ctaHref', c.hero_cta_href,
      'image', case when c.hero_image_path is null then null else jsonb_build_object(
        'bucket', c.hero_image_bucket, 'path', c.hero_image_path, 'altText', c.hero_image_alt) end) end,
    'featuredHeading', c.featured_heading,
    'featuredProducts', coalesce((
      select jsonb_agg(catalog_public.build_published_product(p) order by f.ord)
      from unnest(c.featured_product_ids) with ordinality as f(id, ord)
      join public.products p on p.tenant_id = c.tenant_id and p.id = f.id
      where (p_brand_id is null or p.brand_id = p_brand_id)
        and catalog_public.is_publicly_visible(p)), '[]'::jsonb),
    'featuredCollections', coalesce((
      select jsonb_agg(catalog_public.build_collection_summary(col) order by f.ord)
      from unnest(c.featured_collection_ids) with ordinality as f(id, ord)
      join public.collections col on col.tenant_id = c.tenant_id and col.id = f.id
      where catalog_public.is_collection_publicly_visible(col)), '[]'::jsonb))
  from (select 1) one
  left join public.storefront_content c on c.tenant_id = p_tenant_id;
$function$;

-- =====================================================================================================
-- Grants
-- =====================================================================================================
revoke all on function
  catalog_private.sale_applies(public.catalog_sales, uuid),
  catalog_private.effective_unit_price(uuid, uuid, text, bigint),
  catalog_private.sale_detail(uuid, uuid),
  catalog_private.list_sales(uuid),
  catalog_private.write_sale_products(uuid, uuid, jsonb),
  catalog_private.assert_sale_shape(uuid, uuid),
  catalog_private.create_sale(uuid, text, jsonb),
  catalog_private.update_sale(uuid, uuid, jsonb),
  catalog_private.set_sale_status(uuid, uuid, text),
  catalog_private.delete_sale(uuid, uuid),
  catalog_private.product_offers(public.products),
  catalog_private.storefront_content_detail(uuid),
  catalog_private.upsert_storefront_content(uuid, jsonb),
  catalog_public.get_storefront_content(uuid, uuid)
from public;
grant execute on function catalog_private.effective_unit_price(uuid, uuid, text, bigint),
  catalog_private.sale_applies(public.catalog_sales, uuid) to online_writer;

do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      catalog_private.sale_detail(uuid, uuid),
      catalog_private.list_sales(uuid),
      catalog_private.create_sale(uuid, text, jsonb),
      catalog_private.update_sale(uuid, uuid, jsonb),
      catalog_private.set_sale_status(uuid, uuid, text),
      catalog_private.delete_sale(uuid, uuid),
      catalog_private.storefront_content_detail(uuid),
      catalog_private.upsert_storefront_content(uuid, jsonb),
      catalog_public.get_storefront_content(uuid, uuid)
    to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function catalog_public.get_storefront_content(uuid, uuid) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function catalog_public.get_storefront_content(uuid, uuid) to authenticated;
  end if;
end $b$;
