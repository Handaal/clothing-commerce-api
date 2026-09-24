-- Phase 2P-A (1/3): promotion configuration, immutable sale-time adjustments, and the canonical
-- Order accounting evolution (gross_subtotal / discount_total / net total).
--
-- Enforcement boundary mirrors every prior money domain: a dedicated non-login promotions_writer owns
-- the promotion + adjustment tables and the SECURITY DEFINER functions (migrations 2/3). service_role
-- is transport only: it may SELECT projections and EXECUTE the sanctioned RPCs, never DML the tables.
-- Append-only triggers protect immutable sale-time history as defense-in-depth, never the boundary.

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'promotions_writer') then
    create role promotions_writer nologin noinherit nobypassrls;
  end if;
  execute pg_catalog.format('grant promotions_writer to %I with set true', current_user);
end;
$block$;

comment on role promotions_writer is
  'Owns promotion configuration + immutable adjustment tables and the sanctioned promotion functions; the sole path able to write promotion economics. Never a login or client role.';

create schema promotions_private;
revoke all on schema promotions_private from public;
grant usage on schema public, promotions_private to promotions_writer;

-- Tenant-wide management permissions. Promotions are tenant-owned; brand/branch-only grants are
-- insufficient. Catalog seed only; never assigns to a Role.
insert into public.permissions (key, description) values
  ('promotions.read', 'Read promotions, codes, and redemption usage in the tenant.'),
  ('promotions.manage', 'Create, edit, activate/deactivate promotions and codes in the tenant.')
on conflict (key) do nothing;

-- ============================================================================================
-- Promotion configuration (tenant-owned, mutable while no redemption exists — enforced in 2/3).
-- ============================================================================================
create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  description text,
  benefit_type text not null,
  -- Percentage benefit is stored in basis points (1..10000 = 0.01%..100%). Fixed benefit is a minor
  -- amount in benefit_currency. Exactly one shape is populated (see benefit_shape_consistent).
  benefit_percent_bp integer,
  benefit_amount_minor bigint,
  benefit_currency text,
  target_type text not null,
  activation_type text not null,
  min_subtotal_minor bigint,
  max_discount_minor bigint,
  starts_at timestamptz,
  ends_at timestamptz,
  channel text,
  brand_id uuid,
  branch_id uuid,
  global_redemption_limit bigint,
  redemption_count bigint not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotions_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint promotions_brand_tenant_fk foreign key (tenant_id, brand_id)
    references public.brands (tenant_id, id) on delete restrict,
  constraint promotions_branch_tenant_fk foreign key (tenant_id, branch_id)
    references public.branches (tenant_id, id) on delete restrict,
  constraint promotions_name_not_empty check (btrim(name) <> '' and length(name) <= 200),
  constraint promotions_description_not_empty check (description is null or btrim(description) <> ''),
  constraint promotions_benefit_type_valid check (benefit_type in ('percentage', 'fixed_amount')),
  constraint promotions_target_type_valid check (target_type in ('order', 'variant_scope')),
  constraint promotions_activation_type_valid check (activation_type in ('automatic', 'code')),
  constraint promotions_status_valid check (status in ('active', 'inactive')),
  constraint promotions_channel_valid check (channel is null or channel in ('pos', 'online')),
  constraint promotions_percent_range check (
    benefit_percent_bp is null or (benefit_percent_bp between 1 and 10000)
  ),
  constraint promotions_amount_positive check (
    benefit_amount_minor is null or benefit_amount_minor > 0
  ),
  constraint promotions_currency_valid check (benefit_currency is null or benefit_currency ~ '^[A-Z]{3}$'),
  -- Percentage → bp set, amount/currency null. Fixed → amount+currency set, bp null.
  constraint promotions_benefit_shape_consistent check (
    (benefit_type = 'percentage'
      and benefit_percent_bp is not null and benefit_amount_minor is null and benefit_currency is null)
    or (benefit_type = 'fixed_amount'
      and benefit_amount_minor is not null and benefit_currency is not null and benefit_percent_bp is null)
  ),
  constraint promotions_min_subtotal_nonneg check (min_subtotal_minor is null or min_subtotal_minor >= 0),
  constraint promotions_max_discount_positive check (max_discount_minor is null or max_discount_minor > 0),
  constraint promotions_window_ordered check (
    starts_at is null or ends_at is null or ends_at > starts_at
  ),
  constraint promotions_global_limit_positive check (
    global_redemption_limit is null or global_redemption_limit > 0
  ),
  constraint promotions_redemption_count_nonneg check (redemption_count >= 0),
  constraint promotions_redemption_within_limit check (
    global_redemption_limit is null or redemption_count <= global_redemption_limit
  ),
  constraint promotions_updated_after_created check (updated_at >= created_at),
  constraint promotions_tenant_id_unique unique (tenant_id, id),
  constraint promotions_tenant_id_activation_unique unique (tenant_id, id, activation_type)
);

comment on table public.promotions is
  'Tenant-owned configurable commercial offer. Economics freeze once a redemption exists (enforced by the sanctioned functions). Effective states (scheduled/expired/exhausted) are DERIVED, not persisted; persisted lifecycle is only active/inactive.';
comment on column public.promotions.benefit_percent_bp is
  'Percentage benefit in basis points (1..10000). Discount = floor(basis_minor * bp / 10000).';
comment on column public.promotions.redemption_count is
  'Transactionally maintained successful-redemption tally; incremented only inside the sanctioned placement transaction. Never restored on cancel/return/refund in V1.';

create index promotions_tenant_active_idx on public.promotions (tenant_id, status, activation_type);
create index promotions_tenant_created_idx on public.promotions (tenant_id, created_at, id);

-- Selected Product/Variant scope (only meaningful for target_type='variant_scope'). Each row targets
-- exactly one product (all its variants) OR one variant.
create table public.promotion_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  promotion_id uuid not null,
  product_id uuid,
  variant_id uuid,
  created_at timestamptz not null default now(),
  constraint promotion_targets_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint promotion_targets_promotion_fk foreign key (tenant_id, promotion_id)
    references public.promotions (tenant_id, id) on delete restrict,
  constraint promotion_targets_product_fk foreign key (tenant_id, product_id)
    references public.products (tenant_id, id) on delete restrict,
  constraint promotion_targets_variant_fk foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id) on delete restrict,
  constraint promotion_targets_exactly_one check ((product_id is null) <> (variant_id is null)),
  constraint promotion_targets_tenant_id_unique unique (tenant_id, id)
);
create unique index promotion_targets_product_idx
  on public.promotion_targets (tenant_id, promotion_id, product_id) where product_id is not null;
create unique index promotion_targets_variant_idx
  on public.promotion_targets (tenant_id, promotion_id, variant_id) where variant_id is not null;
create index promotion_targets_promotion_idx on public.promotion_targets (tenant_id, promotion_id);

comment on table public.promotion_targets is
  'Selected Product/Variant eligibility for variant_scope promotions. A product target matches every current variant of that product at evaluation time.';

-- ============================================================================================
-- Codes / coupons / vouchers. A voucher is simply a code with max_redemptions = 1 — no separate engine.
-- ============================================================================================
create table public.promotion_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  promotion_id uuid not null,
  code text not null,
  normalized_code text generated always as (upper(btrim(code))) stored,
  max_redemptions bigint,
  redemption_count bigint not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotion_codes_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint promotion_codes_promotion_fk foreign key (tenant_id, promotion_id)
    references public.promotions (tenant_id, id) on delete restrict,
  constraint promotion_codes_charset check (normalized_code ~ '^[A-Z0-9_-]{1,64}$'),
  constraint promotion_codes_max_redemptions_positive check (max_redemptions is null or max_redemptions > 0),
  constraint promotion_codes_redemption_count_nonneg check (redemption_count >= 0),
  constraint promotion_codes_redemption_within_limit check (
    max_redemptions is null or redemption_count <= max_redemptions
  ),
  constraint promotion_codes_status_valid check (status in ('active', 'disabled')),
  constraint promotion_codes_updated_after_created check (updated_at >= created_at),
  constraint promotion_codes_tenant_id_unique unique (tenant_id, id),
  constraint promotion_codes_tenant_code_unique unique (tenant_id, normalized_code)
);
create index promotion_codes_promotion_idx on public.promotion_codes (tenant_id, promotion_id);

comment on table public.promotion_codes is
  'Reusable entered code linked to a Promotion. Canonical form is trim+uppercase over [A-Z0-9_-]. max_redemptions = 1 is a single-use voucher. One entered code maximum per quote/order.';

-- ============================================================================================
-- Order accounting evolution. Existing invariant order_lines.line_total = quantity * unit_price is
-- UNCHANGED; unit_price_minor stays the gross list price. Discount lives in a separate immutable layer.
-- ============================================================================================
-- The orders_guard trigger forbids UPDATE unless the sanctioned allow flag is on; the historical
-- backfill sets it for the duration of this migration only (a defense-in-depth GUC, not the boundary).
select pg_catalog.set_config('orders_private.allow_order_write', 'on', false);

alter table public.orders
  add column gross_subtotal_minor bigint,
  add column discount_total_minor bigint not null default 0;

-- Historical orders naturally mean "no adjustments": gross = prior total, discount = 0, net unchanged.
-- No fake adjustment rows are created.
update public.orders set gross_subtotal_minor = total_minor where gross_subtotal_minor is null;

alter table public.orders
  alter column gross_subtotal_minor set not null,
  add constraint orders_gross_subtotal_nonnegative check (gross_subtotal_minor >= 0),
  add constraint orders_discount_total_nonnegative check (discount_total_minor >= 0),
  add constraint orders_discount_within_gross check (discount_total_minor <= gross_subtotal_minor),
  add constraint orders_net_total_identity check (total_minor = gross_subtotal_minor - discount_total_minor);

select pg_catalog.set_config('orders_private.allow_order_write', 'off', false);

comment on column public.orders.gross_subtotal_minor is
  'Σ order_lines.line_total_minor (pre-discount). For historical orders equals total_minor.';
comment on column public.orders.discount_total_minor is
  'Total applied promotion discount in orders.currency minor units. 0 for historical/undiscounted orders.';
comment on column public.orders.total_minor is
  'Payable NET total = gross_subtotal_minor - discount_total_minor. Payment amount equals this. For historical orders discount is 0 so it equals the gross subtotal (backward compatible).';

-- ============================================================================================
-- Immutable sale-time adjustment snapshots. Carry enough evidence to explain a historical order after
-- the live Promotion is edited, deactivated, or its code deleted — never reconstructed from live config.
-- ============================================================================================
create table public.order_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  promotion_id uuid not null,
  code_id uuid,
  promotion_name_snapshot text not null,
  benefit_type_snapshot text not null,
  benefit_value_snapshot bigint not null,
  benefit_currency_snapshot text,
  code_snapshot text,
  target_type_snapshot text not null,
  gross_subtotal_minor bigint not null,
  eligible_basis_minor bigint not null,
  discount_total_minor bigint not null,
  created_at timestamptz not null default now(),
  constraint order_adjustments_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint order_adjustments_order_fk foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete restrict,
  constraint order_adjustments_promotion_fk foreign key (tenant_id, promotion_id)
    references public.promotions (tenant_id, id) on delete restrict,
  constraint order_adjustments_code_fk foreign key (tenant_id, code_id)
    references public.promotion_codes (tenant_id, id) on delete restrict,
  constraint order_adjustments_benefit_type_snapshot check (benefit_type_snapshot in ('percentage', 'fixed_amount')),
  constraint order_adjustments_target_type_snapshot check (target_type_snapshot in ('order', 'variant_scope')),
  constraint order_adjustments_values_nonneg check (
    benefit_value_snapshot >= 0 and gross_subtotal_minor >= 0
    and eligible_basis_minor >= 0 and discount_total_minor >= 0
  ),
  constraint order_adjustments_discount_within_gross check (discount_total_minor <= gross_subtotal_minor),
  constraint order_adjustments_discount_within_basis check (discount_total_minor <= eligible_basis_minor),
  constraint order_adjustments_code_snapshot_consistent check ((code_id is null) = (code_snapshot is null)),
  constraint order_adjustments_tenant_id_unique unique (tenant_id, id),
  constraint order_adjustments_one_per_order unique (tenant_id, order_id)
);
create index order_adjustments_promotion_idx on public.order_adjustments (tenant_id, promotion_id);

comment on table public.order_adjustments is
  'Immutable sale-time summary of the single applied promotion. Self-contained economic evidence; a later Promotion edit/deactivation/code deletion never changes it.';

create table public.order_line_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  promotion_id uuid not null,
  discount_minor bigint not null,
  created_at timestamptz not null default now(),
  constraint order_line_adjustments_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint order_line_adjustments_order_fk foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete restrict,
  constraint order_line_adjustments_line_fk foreign key (tenant_id, order_line_id)
    references public.order_lines (tenant_id, id) on delete restrict,
  constraint order_line_adjustments_promotion_fk foreign key (tenant_id, promotion_id)
    references public.promotions (tenant_id, id) on delete restrict,
  constraint order_line_adjustments_discount_nonneg check (discount_minor >= 0),
  constraint order_line_adjustments_tenant_id_unique unique (tenant_id, id),
  constraint order_line_adjustments_one_per_line unique (tenant_id, order_line_id)
);
create index order_line_adjustments_order_idx on public.order_line_adjustments (tenant_id, order_id);

comment on table public.order_line_adjustments is
  'Immutable allocation of the order discount to an OrderLine. Returns derive the net refundable basis from these allocations, never from the live Promotion.';

-- ============================================================================================
-- Redemption: immutable successful-consumption fact, tied to the canonical Order. One per order.
-- ============================================================================================
create table public.promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  promotion_id uuid not null,
  code_id uuid,
  order_id uuid not null,
  customer_id uuid,
  channel text not null,
  discount_total_minor bigint not null,
  redeemed_at timestamptz not null default now(),
  constraint promotion_redemptions_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint promotion_redemptions_promotion_fk foreign key (tenant_id, promotion_id)
    references public.promotions (tenant_id, id) on delete restrict,
  constraint promotion_redemptions_code_fk foreign key (tenant_id, code_id)
    references public.promotion_codes (tenant_id, id) on delete restrict,
  constraint promotion_redemptions_order_fk foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete restrict,
  constraint promotion_redemptions_customer_fk foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete restrict,
  constraint promotion_redemptions_channel_valid check (channel in ('pos', 'online')),
  constraint promotion_redemptions_discount_nonneg check (discount_total_minor >= 0),
  constraint promotion_redemptions_tenant_id_unique unique (tenant_id, id),
  constraint promotion_redemptions_one_per_order unique (tenant_id, order_id)
);
create index promotion_redemptions_promotion_idx on public.promotion_redemptions (tenant_id, promotion_id, redeemed_at);
create index promotion_redemptions_code_idx on public.promotion_redemptions (tenant_id, code_id) where code_id is not null;

comment on table public.promotion_redemptions is
  'Immutable fact that a Promotion was consumed by a successful Order. V1 never reverses it: cancel/return/refund do NOT restore usage. customer_id is snapshot-only (no per-customer cap in V1).';

-- ============================================================================================
-- Immutability: adjustments and redemptions are append-only; codes/promotions stay mutable per policy
-- enforced in migration 2. Promotion config mutation freeze is enforced in the sanctioned functions.
-- ============================================================================================
create function promotions_private.forbid_history_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $function$
begin
  raise exception using errcode = '42501',
    message = pg_catalog.format('%I is immutable sale-time history', tg_table_name);
end;
$function$;

create trigger order_adjustments_immutable before update or delete on public.order_adjustments
  for each row execute function promotions_private.forbid_history_mutation();
create trigger order_line_adjustments_immutable before update or delete on public.order_line_adjustments
  for each row execute function promotions_private.forbid_history_mutation();
create trigger promotion_redemptions_immutable before update or delete on public.promotion_redemptions
  for each row execute function promotions_private.forbid_history_mutation();

-- ============================================================================================
-- Ownership + privilege boundary. Writer owns the tables; PUBLIC/anon/authenticated have nothing;
-- service_role gets SELECT only (RPC EXECUTE is granted in migrations 2/3).
-- ============================================================================================
grant create on schema public, promotions_private to promotions_writer;
do $block$
declare t text;
begin
  foreach t in array array[
    'promotions', 'promotion_targets', 'promotion_codes',
    'order_adjustments', 'order_line_adjustments', 'promotion_redemptions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    execute format('alter table public.%I owner to promotions_writer', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on public.%I from service_role', t);
      execute format('grant select on public.%I to service_role', t);
    end if;
  end loop;
end;
$block$;
alter function promotions_private.forbid_history_mutation() owner to promotions_writer;
revoke create on schema public, promotions_private from promotions_writer;
revoke all on function promotions_private.forbid_history_mutation() from public;

-- The writer resolves catalog/order/customer state through narrow read-only policies (no DML on them).
do $block$
declare t text;
begin
  foreach t in array array[
    'tenants', 'brands', 'branches', 'branch_brands', 'products', 'product_variants',
    'variant_prices', 'orders', 'order_lines', 'customers'
  ] loop
    execute format('grant select on public.%I to promotions_writer', t);
    execute format('create policy promotions_writer_read on public.%I for select to promotions_writer using (true)', t);
  end loop;
end;
$block$;

-- The sole order-creation path now also records the immutable gross subtotal. At creation there is no
-- discount, so gross_subtotal_minor = total_minor and the net identity holds; a later sanctioned
-- promotion adjustment is the only thing that moves discount_total_minor above zero. This is a verbatim
-- re-declaration of orders_private.create_order with the single accounting addition to the INSERT; the
-- signature, idempotency, counter, and integrity behavior are unchanged (grants therefore persist).
create or replace function orders_private.create_order(
  p_tenant_id uuid,
  p_channel text,
  p_currency text,
  p_brand_id uuid,
  p_branch_id uuid,
  p_register_id uuid,
  p_actor_membership_id uuid,
  p_idempotency_key text,
  p_placed_at timestamptz,
  p_notes text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  bigint_max constant numeric := 9223372036854775807;
  v_norm text := lower(btrim(p_idempotency_key));
  v_fingerprint text;
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_order_id uuid;
  v_order_number text;
  v_next bigint;
  v_element jsonb;
  v_quantity bigint;
  v_unit_price bigint;
  v_line_total numeric;
  v_total numeric := 0;
  v_line_number integer;
begin
  if p_tenant_id is null or p_brand_id is null then
    raise exception using errcode = '22004', message = 'tenant and brand are required';
  end if;
  if p_channel not in ('pos', 'online') then
    raise exception using errcode = '22023', message = 'channel must be pos or online';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'currency must be an uppercase ISO 4217 code';
  end if;
  if p_channel = 'pos' and (p_branch_id is null or p_register_id is null) then
    raise exception using errcode = '22023', message = 'pos orders require a branch and a register';
  end if;
  if p_channel = 'online' and (p_branch_id is not null or p_register_id is not null) then
    raise exception using errcode = '22023', message = 'online orders must not carry a branch or register';
  end if;
  if pg_catalog.jsonb_typeof(p_lines) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = '22023', message = 'an order must contain at least one line';
  end if;
  if p_idempotency_key is not null and v_norm = '' then
    raise exception using errcode = '22023', message = 'idempotency_key must not be blank';
  end if;

  for v_element in
    select ordered.value
    from pg_catalog.jsonb_array_elements(p_lines) with ordinality as ordered(value, ord)
    order by ordered.ord
  loop
    if (v_element ->> 'variant_id') is null
      or (v_element ->> 'product_id') is null
      or (v_element ->> 'quantity') is null
      or (v_element ->> 'unit_price_minor') is null
      or (v_element ->> 'product_name') is null
      or (v_element ->> 'sku') is null then
      raise exception using errcode = '22023', message = 'each line requires variant, product, quantity, price, name, and sku';
    end if;
    v_quantity := (v_element ->> 'quantity')::bigint;
    v_unit_price := (v_element ->> 'unit_price_minor')::bigint;
    if v_quantity <= 0 then
      raise exception using errcode = '22023', message = 'line quantity must be positive';
    end if;
    if v_unit_price < 0 then
      raise exception using errcode = '22023', message = 'line unit price must be non-negative';
    end if;
    v_line_total := v_quantity::numeric * v_unit_price::numeric;
    if v_line_total > bigint_max then
      raise exception using errcode = '22003', message = 'line total exceeds the supported range';
    end if;
    v_total := v_total + v_line_total;
    if v_total > bigint_max then
      raise exception using errcode = '22003', message = 'order total exceeds the supported range';
    end if;
  end loop;

  v_fingerprint := orders_private.order_intent_fingerprint(
    p_tenant_id, p_channel, p_currency, p_register_id, p_lines
  );

  if p_idempotency_key is not null then
    select o.id, o.payload_fingerprint
    into v_existing_id, v_existing_fingerprint
    from public.orders as o
    where o.tenant_id = p_tenant_id
      and o.normalized_idempotency_key = v_norm;
    if v_existing_id is not null then
      if v_existing_fingerprint is distinct from v_fingerprint then
        raise exception using errcode = 'ID409', message = 'idempotency key reused with a different order intent';
      end if;
      return v_existing_id;
    end if;
  end if;

  begin
    loop
      perform 1 from public.order_number_sequences where tenant_id = p_tenant_id for update;
      exit when found;
      begin
        insert into public.order_number_sequences (tenant_id, next_value) values (p_tenant_id, 0);
        exit;
      exception
        when unique_violation then
          null;
      end;
    end loop;

    update public.order_number_sequences
      set next_value = next_value + 1, updated_at = pg_catalog.now()
      where tenant_id = p_tenant_id
      returning next_value into v_next;

    v_order_number := v_next::text;

    insert into public.orders (
      tenant_id, brand_id, branch_id, register_id, order_number, channel, status, currency,
      total_minor, gross_subtotal_minor, actor_membership_id, idempotency_key, payload_fingerprint,
      notes, placed_at
    )
    values (
      p_tenant_id, p_brand_id, p_branch_id, p_register_id, v_order_number, p_channel, 'placed',
      p_currency, v_total::bigint, v_total::bigint, p_actor_membership_id, p_idempotency_key,
      case when p_idempotency_key is null then null else v_fingerprint end,
      p_notes, coalesce(p_placed_at, pg_catalog.now())
    )
    returning id into v_order_id;

    v_line_number := 0;
    for v_element in
      select ordered.value
      from pg_catalog.jsonb_array_elements(p_lines) with ordinality as ordered(value, ord)
      order by ordered.ord
    loop
      v_line_number := v_line_number + 1;
      v_quantity := (v_element ->> 'quantity')::bigint;
      v_unit_price := (v_element ->> 'unit_price_minor')::bigint;
      insert into public.order_lines (
        tenant_id, order_id, brand_id, product_id, variant_id, line_number, quantity,
        unit_price_minor, line_total_minor, product_name_snapshot, variant_name_snapshot,
        sku_snapshot, option_summary_snapshot
      )
      values (
        p_tenant_id, v_order_id, p_brand_id, (v_element ->> 'product_id')::uuid,
        (v_element ->> 'variant_id')::uuid, v_line_number, v_quantity, v_unit_price,
        (v_quantity::numeric * v_unit_price::numeric)::bigint,
        v_element ->> 'product_name', v_element ->> 'variant_name',
        v_element ->> 'sku', v_element ->> 'option_summary'
      );
    end loop;
  exception
    when unique_violation then
      if p_idempotency_key is null then
        raise;
      end if;
      select o.id, o.payload_fingerprint
      into v_existing_id, v_existing_fingerprint
      from public.orders as o
      where o.tenant_id = p_tenant_id
        and o.normalized_idempotency_key = v_norm;
      if v_existing_id is null then
        raise;
      end if;
      if v_existing_fingerprint is distinct from v_fingerprint then
        raise exception using errcode = 'ID409', message = 'idempotency key reused with a different order intent';
      end if;
      return v_existing_id;
  end;

  return v_order_id;
end;
$function$;
