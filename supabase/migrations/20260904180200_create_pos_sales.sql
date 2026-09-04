-- Connected POS Sale V1 composed transaction boundary.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'pos_sales_writer') then
    create role pos_sales_writer nologin noinherit nobypassrls;
  end if;
  execute pg_catalog.format('grant pos_sales_writer to %I with set true', current_user);
end;
$block$;

create schema if not exists pos_sales_private;
revoke all on schema pos_sales_private from public;
grant usage on schema public, pos_sales_private, orders_private, payments_private, fulfillments_private
  to pos_sales_writer;

create table public.pos_sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  register_id uuid not null,
  branch_id uuid not null,
  inventory_location_id uuid not null,
  order_id uuid not null,
  payment_id uuid not null,
  fulfillment_id uuid not null,
  idempotency_key text not null,
  normalized_idempotency_key text generated always as (lower(btrim(idempotency_key))) stored,
  payload_fingerprint text not null,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint pos_sales_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint pos_sales_register_branch_fk foreign key (tenant_id, branch_id, register_id)
    references public.registers (tenant_id, branch_id, id) on delete restrict,
  constraint pos_sales_location_tenant_fk foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations (tenant_id, id) on delete restrict,
  constraint pos_sales_order_tenant_fk foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete restrict,
  constraint pos_sales_payment_tenant_fk foreign key (tenant_id, payment_id)
    references public.payments (tenant_id, id) on delete restrict,
  constraint pos_sales_fulfillment_tenant_fk foreign key (tenant_id, fulfillment_id)
    references public.fulfillments (tenant_id, id) on delete restrict,
  constraint pos_sales_key_not_blank check (normalized_idempotency_key <> ''),
  constraint pos_sales_tenant_id_unique unique (tenant_id, id),
  constraint pos_sales_tenant_order_unique unique (tenant_id, order_id),
  constraint pos_sales_tenant_payment_unique unique (tenant_id, payment_id),
  constraint pos_sales_tenant_fulfillment_unique unique (tenant_id, fulfillment_id),
  constraint pos_sales_tenant_key_unique unique (tenant_id, normalized_idempotency_key)
);

comment on table public.pos_sales is
  'Atomic composition record joining one canonical POS Order, one captured cash Payment, and one full Fulfillment. It is not a second order aggregate.';

create function pos_sales_private.forbid_pos_sale_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $function$
begin
  raise exception using errcode = '42501', message = 'completed POS sales are immutable';
end;
$function$;

create trigger pos_sales_immutable before update or delete on public.pos_sales
for each row execute function pos_sales_private.forbid_pos_sale_mutation();

create function pos_sales_private.sale_intent_fingerprint(
  p_tenant_id uuid,
  p_register_id uuid,
  p_expected_total_minor bigint,
  p_cash_received_minor bigint,
  p_lines jsonb
)
returns text language sql immutable security invoker set search_path = '' as $function$
  select pg_catalog.md5(
    p_tenant_id::text || E'\n' || coalesce(p_register_id::text, '') || E'\n'
    || coalesce(p_expected_total_minor::text, '') || E'\n'
    || coalesce(p_cash_received_minor::text, '')
    || coalesce((
      select pg_catalog.string_agg(
        E'\n' || (line.value ->> 'variant_id') || ',' || (line.value ->> 'quantity'),
        '' order by line.ord
      )
      from pg_catalog.jsonb_array_elements(p_lines) with ordinality line(value, ord)
    ), '')
  );
$function$;

create function pos_sales_private.resolve_replay_target(
  p_tenant_id uuid,
  p_normalized_key text,
  p_intent jsonb
)
returns table (
  fingerprint_matches boolean,
  sale_id uuid,
  branch_id uuid,
  inventory_location_id uuid
)
language plpgsql security definer set search_path = '' as $function$
declare
  v_key text := lower(btrim(p_normalized_key));
  v_fingerprint text;
  v_sale public.pos_sales%rowtype;
begin
  if p_tenant_id is null or p_normalized_key is null or v_key = '' then return; end if;
  v_fingerprint := pos_sales_private.sale_intent_fingerprint(
    p_tenant_id,
    nullif(p_intent ->> 'register_id', '')::uuid,
    (p_intent ->> 'expected_total_minor')::bigint,
    (p_intent ->> 'cash_received_minor')::bigint,
    coalesce(p_intent -> 'lines', '[]'::jsonb)
  );
  select * into v_sale from public.pos_sales s
  where s.tenant_id = p_tenant_id and s.normalized_idempotency_key = v_key;
  if not found then return; end if;
  if v_sale.payload_fingerprint is distinct from v_fingerprint then
    return query select false, null::uuid, v_sale.branch_id, v_sale.inventory_location_id;
  else
    return query select true, v_sale.id, v_sale.branch_id, v_sale.inventory_location_id;
  end if;
end;
$function$;

create function pos_sales_private.record_sale(
  p_tenant_id uuid,
  p_register_id uuid,
  p_actor_membership_id uuid,
  p_idempotency_key text,
  p_expected_total_minor bigint,
  p_cash_received_minor bigint,
  p_lines jsonb
)
returns uuid
language plpgsql security definer set search_path = '' as $function$
declare
  bigint_max constant numeric := 9223372036854775807;
  v_key text := lower(btrim(p_idempotency_key));
  v_fingerprint text;
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_branch_id uuid;
  v_location_id uuid;
  v_currency text;
  v_status text;
  v_fulfillment_enabled boolean;
  v_element jsonb;
  v_variant_id uuid;
  v_product_id uuid;
  v_brand_id uuid;
  v_first_brand_id uuid;
  v_variant_status text;
  v_price bigint;
  v_quantity bigint;
  v_total numeric := 0;
  v_product_name text;
  v_variant_name text;
  v_sku text;
  v_order_lines jsonb := '[]'::jsonb;
  v_fulfillment_lines jsonb := '[]'::jsonb;
  v_order_id uuid;
  v_payment_id uuid;
  v_fulfillment_id uuid;
  v_inventory_operation_id uuid;
  v_sale_id uuid;
  v_child_suffix text;
  v_seen uuid[] := array[]::uuid[];
  v_order_line record;
begin
  if p_tenant_id is null or p_register_id is null or p_actor_membership_id is null
    or p_idempotency_key is null or v_key = '' or p_expected_total_minor is null
    or p_cash_received_minor is null then
    raise exception using errcode = '22004', message = 'POS sale fields are required';
  end if;
  if p_expected_total_minor < 0 or p_cash_received_minor < 0
    or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = '22023', message = 'invalid POS sale input';
  end if;

  v_fingerprint := pos_sales_private.sale_intent_fingerprint(
    p_tenant_id, p_register_id, p_expected_total_minor, p_cash_received_minor, p_lines
  );
  select s.id, s.payload_fingerprint into v_existing_id, v_existing_fingerprint
  from public.pos_sales s
  where s.tenant_id = p_tenant_id and s.normalized_idempotency_key = v_key;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'POS sale idempotency conflict';
    end if;
    return v_existing_id;
  end if;

  select r.branch_id, r.default_inventory_location_id, r.selling_currency, r.status
  into v_branch_id, v_location_id, v_currency, v_status
  from public.registers r
  where r.tenant_id = p_tenant_id and r.id = p_register_id;
  if not found then raise exception using errcode = 'PS010', message = 'register not found'; end if;
  if v_status is distinct from 'active' then
    raise exception using errcode = 'PS011', message = 'register inactive';
  end if;

  select b.status into v_status from public.branches b
  where b.tenant_id = p_tenant_id and b.id = v_branch_id;
  if v_status is distinct from 'active' then
    raise exception using errcode = 'PS012', message = 'branch inactive';
  end if;

  select l.status, l.is_fulfillment_enabled into v_status, v_fulfillment_enabled
  from public.inventory_locations l
  where l.tenant_id = p_tenant_id and l.id = v_location_id;
  if v_status is distinct from 'active' then
    raise exception using errcode = 'PS013', message = 'location inactive';
  end if;
  if v_fulfillment_enabled is distinct from true then
    raise exception using errcode = 'PS014', message = 'location cannot fulfill';
  end if;

  for v_element in
    select line.value from pg_catalog.jsonb_array_elements(p_lines) with ordinality line(value, ord)
    order by line.ord
  loop
    if v_element ->> 'variant_id' is null or v_element ->> 'quantity' is null then
      raise exception using errcode = '22023', message = 'each line requires variant and quantity';
    end if;
    v_variant_id := (v_element ->> 'variant_id')::uuid;
    v_quantity := (v_element ->> 'quantity')::bigint;
    if v_quantity <= 0 or v_variant_id = any(v_seen) then
      raise exception using errcode = '22023', message = 'invalid or duplicate POS sale line';
    end if;
    v_seen := v_seen || v_variant_id;

    select pv.product_id, pv.status, pv.display_name, pv.sku,
           p.brand_id, p.name, vp.amount_minor
    into v_product_id, v_variant_status, v_variant_name, v_sku,
         v_brand_id, v_product_name, v_price
    from public.product_variants pv
    join public.products p on p.tenant_id = pv.tenant_id and p.id = pv.product_id
    join public.variant_prices vp on vp.tenant_id = pv.tenant_id
      and vp.variant_id = pv.id and vp.currency = v_currency and vp.status = 'active'
    where pv.tenant_id = p_tenant_id and pv.id = v_variant_id;
    if not found then
      if exists (select 1 from public.product_variants pv
        where pv.tenant_id = p_tenant_id and pv.id = v_variant_id) then
        raise exception using errcode = 'PS022', message = 'active price not found';
      end if;
      raise exception using errcode = 'PS020', message = 'variant not found';
    end if;
    if v_variant_status is distinct from 'active' then
      raise exception using errcode = 'PS021', message = 'variant inactive';
    end if;
    if v_first_brand_id is null then v_first_brand_id := v_brand_id;
    elsif v_first_brand_id is distinct from v_brand_id then
      raise exception using errcode = 'PS024', message = 'cross-brand sale';
    end if;
    v_total := v_total + v_quantity::numeric * v_price::numeric;
    if v_total > bigint_max then
      raise exception using errcode = '22003', message = 'sale total outside range';
    end if;
    v_order_lines := v_order_lines || pg_catalog.jsonb_build_object(
      'variant_id', v_variant_id,
      'product_id', v_product_id,
      'quantity', v_quantity,
      'unit_price_minor', v_price,
      'product_name', v_product_name,
      'variant_name', v_variant_name,
      'sku', v_sku,
      'option_summary', v_element ->> 'option_summary'
    );
  end loop;

  if not exists (select 1 from public.branch_brands bb
    where bb.tenant_id = p_tenant_id and bb.branch_id = v_branch_id
      and bb.brand_id = v_first_brand_id) then
    raise exception using errcode = 'PS023', message = 'brand not carried';
  end if;
  if v_total::bigint is distinct from p_expected_total_minor then
    raise exception using errcode = 'PS409', message = 'authoritative price changed',
      detail = v_total::bigint::text;
  end if;
  if p_cash_received_minor < v_total then
    raise exception using errcode = 'PS030', message = 'cash received below total';
  end if;

  -- No mutation occurs above this line. All five caller authorities were already proven by the
  -- application service before this function was invoked.
  v_child_suffix := pg_catalog.md5(p_tenant_id::text || ':' || v_key);
  v_order_id := orders_private.create_order(
    p_tenant_id, 'pos', v_currency, v_first_brand_id, v_branch_id, p_register_id,
    p_actor_membership_id, 'pos-sale-order:' || v_child_suffix, null, null, v_order_lines
  );
  v_payment_id := payments_private.capture_cash_payment(
    p_tenant_id, v_order_id, p_cash_received_minor, p_actor_membership_id,
    'pos-sale-payment:' || v_child_suffix
  );

  for v_order_line in
    select ol.id, ol.quantity from public.order_lines ol
    where ol.tenant_id = p_tenant_id and ol.order_id = v_order_id
    order by ol.line_number
  loop
    v_fulfillment_lines := v_fulfillment_lines || pg_catalog.jsonb_build_object(
      'order_line_id', v_order_line.id, 'quantity', v_order_line.quantity
    );
  end loop;
  select f.fulfillment_id, f.inventory_operation_id
  into v_fulfillment_id, v_inventory_operation_id
  from fulfillments_private.record_fulfillment(
    p_tenant_id, v_order_id, v_location_id, p_actor_membership_id,
    'pos-sale-fulfillment:' || v_child_suffix, null, v_fulfillment_lines
  ) f;

  begin
    insert into public.pos_sales (
      tenant_id, register_id, branch_id, inventory_location_id, order_id, payment_id,
      fulfillment_id, idempotency_key, payload_fingerprint
    ) values (
      p_tenant_id, p_register_id, v_branch_id, v_location_id, v_order_id, v_payment_id,
      v_fulfillment_id, p_idempotency_key, v_fingerprint
    ) returning id into v_sale_id;
  exception when unique_violation then
    select s.id, s.payload_fingerprint into v_existing_id, v_existing_fingerprint
    from public.pos_sales s
    where s.tenant_id = p_tenant_id and s.normalized_idempotency_key = v_key;
    if v_existing_id is null or v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'POS sale idempotency conflict';
    end if;
    return v_existing_id;
  end;
  return v_sale_id;
end;
$function$;

grant select on table public.registers, public.branches, public.inventory_locations,
  public.product_variants, public.products, public.variant_prices, public.branch_brands,
  public.order_lines to pos_sales_writer;

create policy pos_sales_writer_register_read on public.registers for select to pos_sales_writer using (true);
create policy pos_sales_writer_branch_read on public.branches for select to pos_sales_writer using (true);
create policy pos_sales_writer_location_read on public.inventory_locations for select to pos_sales_writer using (true);
create policy pos_sales_writer_variant_read on public.product_variants for select to pos_sales_writer using (true);
create policy pos_sales_writer_product_read on public.products for select to pos_sales_writer using (true);
create policy pos_sales_writer_price_read on public.variant_prices for select to pos_sales_writer using (true);
create policy pos_sales_writer_branch_brand_read on public.branch_brands for select to pos_sales_writer using (true);
create policy pos_sales_writer_order_line_read on public.order_lines for select to pos_sales_writer using (true);

grant execute on function orders_private.create_order(
  uuid, text, text, uuid, uuid, uuid, uuid, text, timestamptz, text, jsonb
) to pos_sales_writer;
grant execute on function payments_private.capture_cash_payment(uuid, uuid, bigint, uuid, text)
  to pos_sales_writer;
grant execute on function fulfillments_private.record_fulfillment(
  uuid, uuid, uuid, uuid, text, timestamptz, jsonb
) to pos_sales_writer;

grant create on schema public, pos_sales_private to pos_sales_writer;
alter table public.pos_sales owner to pos_sales_writer;
alter function pos_sales_private.forbid_pos_sale_mutation() owner to pos_sales_writer;
alter function pos_sales_private.sale_intent_fingerprint(uuid, uuid, bigint, bigint, jsonb)
  owner to pos_sales_writer;
alter function pos_sales_private.resolve_replay_target(uuid, text, jsonb) owner to pos_sales_writer;
alter function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb)
  owner to pos_sales_writer;
revoke create on schema public, pos_sales_private from pos_sales_writer;

revoke all on function pos_sales_private.forbid_pos_sale_mutation() from public;
revoke all on function pos_sales_private.sale_intent_fingerprint(uuid, uuid, bigint, bigint, jsonb)
  from public;
revoke all on function pos_sales_private.resolve_replay_target(uuid, text, jsonb) from public;
revoke all on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb)
  from public;

alter table public.pos_sales enable row level security;
revoke all on table public.pos_sales from public;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.pos_sales from anon';
    execute 'revoke all on schema pos_sales_private from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.pos_sales from authenticated';
    execute 'revoke all on schema pos_sales_private from authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant select on table public.pos_sales to service_role';
    execute 'grant usage on schema pos_sales_private to service_role';
    execute 'grant execute on function pos_sales_private.resolve_replay_target(uuid, text, jsonb) to service_role';
    execute 'grant execute on function pos_sales_private.record_sale(uuid, uuid, uuid, text, bigint, bigint, jsonb) to service_role';
  end if;
end;
$block$;
