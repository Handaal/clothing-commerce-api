-- Phase 2L: canonical customer, order snapshots, stock commitments and provider-neutral payments.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'online_writer') then
    create role online_writer nologin noinherit nobypassrls;
  end if;
  execute pg_catalog.format('grant online_writer to %I with set true', current_user);
end;
$block$;
create schema online_private;
revoke all on schema online_private from public;
grant usage on schema public, online_private, orders_private, inventory_private, commerce_locks to online_writer;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 200),
  email text,
  phone text not null,
  normalized_email text generated always as (lower(btrim(email))) stored,
  normalized_phone text generated always as (regexp_replace(phone, '[^+0-9]', '', 'g')) stored,
  -- Linking requires a future verified account flow, never public email/phone matching.
  user_identity_id uuid references public.user_identities(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now() check (updated_at >= created_at),
  unique (tenant_id, id),
  check (normalized_phone ~ '^\+[1-9][0-9]{6,14}$')
);
create index customers_email_lookup on public.customers(tenant_id, normalized_email);
create index customers_phone_lookup on public.customers(tenant_id, normalized_phone);
create unique index customers_verified_identity on public.customers(tenant_id, user_identity_id) where user_identity_id is not null;
create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid not null,
  address jsonb not null check (jsonb_typeof(address) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now() check (updated_at >= created_at),
  foreign key (tenant_id, customer_id) references public.customers(tenant_id, id) on delete restrict
);
create index customer_addresses_customer on public.customer_addresses(tenant_id, customer_id);

-- Deployment-owned routing, not a public settings API. No default COD enablement or guessed location.
create table public.storefront_checkout_settings (
  tenant_id uuid not null,
  brand_id uuid not null,
  inventory_location_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  cod_enabled boolean not null default false,
  primary key (tenant_id, brand_id),
  foreign key (tenant_id, brand_id) references public.brands(tenant_id,id) on delete restrict,
  foreign key (tenant_id, inventory_location_id) references public.inventory_locations(tenant_id,id) on delete restrict
);

alter table public.orders add column customer_id uuid,
  add column customer_snapshot jsonb,
  add column delivery_snapshot jsonb,
  add constraint orders_customer_tenant_fk foreign key (tenant_id, customer_id) references public.customers(tenant_id,id) on delete restrict,
  add constraint orders_checkout_snapshots_consistent check (
    (customer_id is null and customer_snapshot is null and delivery_snapshot is null) or
    (channel = 'online' and customer_id is not null and customer_snapshot is not null and delivery_snapshot is not null and jsonb_typeof(customer_snapshot) = 'object' and jsonb_typeof(delivery_snapshot) = 'object')
  );

create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  variant_id uuid not null,
  inventory_location_id uuid not null,
  quantity bigint not null check (quantity > 0),
  consumed_quantity bigint not null default 0 check (consumed_quantity >= 0 and consumed_quantity <= quantity),
  status text not null default 'active' check (status in ('active','consumed','released','expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (tenant_id, order_line_id),
  foreign key (tenant_id, order_id, order_line_id) references public.order_lines(tenant_id, order_id, id) on delete restrict,
  foreign key (tenant_id, variant_id) references public.product_variants(tenant_id,id) on delete restrict,
  foreign key (tenant_id, order_line_id, variant_id) references public.order_lines(tenant_id,id,variant_id) on delete restrict,
  foreign key (tenant_id, inventory_location_id) references public.inventory_locations(tenant_id,id) on delete restrict,
  check (expires_at is null or expires_at > created_at),
  check ((status = 'consumed') = (consumed_quantity = quantity)),
  check (status not in ('released','expired') or consumed_quantity = 0)
);
create index reservations_ats on public.stock_reservations(tenant_id,variant_id,inventory_location_id) where status = 'active';
create index reservations_order on public.stock_reservations(tenant_id,order_id);
create index reservations_expiry on public.stock_reservations(expires_at) where status = 'active' and expires_at is not null;

create table public.checkout_operations (
  tenant_id uuid not null,
  normalized_key text not null check (length(normalized_key) between 1 and 200),
  intent jsonb not null,
  order_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, normalized_key),
  foreign key (tenant_id,order_id) references public.orders(tenant_id,id) on delete restrict
);

-- Preserve POS captured cash while allowing pending COD and future electronic transitions.
alter table public.payments drop constraint payments_method_v1_valid,
  drop constraint payments_status_v1_valid,
  alter column cash_received_minor drop not null,
  alter column change_minor drop not null,
  alter column captured_by_membership_id drop not null,
  alter column captured_at drop not null,
  alter column captured_at drop default,
  add column provider text,
  add column provider_reference text,
  add constraint payments_method_valid check (method in ('cash','cash_on_delivery','electronic')),
  add constraint payments_status_valid check (status in ('pending','authorized','captured','failed','cancelled','refunded')),
  add constraint payments_provider_valid check ((method = 'electronic') = (provider is not null)),
  add constraint payments_cash_valid check (method <> 'cash' or (status = 'captured' and cash_received_minor is not null and change_minor is not null and captured_by_membership_id is not null)),
  add constraint payments_capture_time_valid check ((status in ('captured','refunded')) = (captured_at is not null));

create or replace function payments_private.forbid_payment_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $function$
begin
  if tg_op = 'INSERT' then
    if new.status = 'captured' and new.captured_at is null then new.captured_at := now(); end if;
    return new;
  end if;
  if tg_op = 'DELETE' or old.method = 'cash' or current_user <> 'payments_writer'
    or current_setting('payments_private.allow_transition',true) is distinct from 'on' then
    raise exception using errcode = '42501', message = 'payments require sanctioned transitions';
  end if;
  return new;
end;
$function$;
create trigger payments_capture_time before insert on public.payments for each row execute function payments_private.forbid_payment_mutation();

-- Narrow trusted lifecycle operation. Gateway callers must verify webhook signatures and amounts first;
-- no public route is enabled until a provider and durable event ingestion are implemented.
create function payments_private.transition_payment(p_tenant uuid,p_order uuid,p_status text)
returns void language plpgsql security definer set search_path = '' as $function$
declare v public.payments;
begin
  select * into v from public.payments where tenant_id=p_tenant and order_id=p_order for update;
  if not found then raise exception using errcode='22023', message='payment missing'; end if;
  if v.status = p_status then return; end if;
  if v.method='cash' or not (
    (v.status='pending' and p_status in ('authorized','captured','failed','cancelled')) or
    (v.status='authorized' and p_status in ('captured','failed','cancelled'))
  ) then raise exception using errcode='22023', message='invalid payment transition'; end if;
  perform set_config('payments_private.allow_transition','on',true);
  update public.payments set status=p_status, captured_at=case when p_status='captured' then now() else null end, updated_at=now()
    where tenant_id=p_tenant and id=v.id;
  perform set_config('payments_private.allow_transition','off',true);
end;
$function$;
create function payments_private.create_cod_payment(p_tenant uuid,p_order uuid)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  insert into public.payments(tenant_id,order_id,method,status,currency,amount_minor,idempotency_key,payload_fingerprint)
    select tenant_id,id,'cash_on_delivery','pending',currency,total_minor,'checkout:'||id::text,id::text
    from public.orders where tenant_id=p_tenant and id=p_order and channel='online';
  if not found then raise exception using errcode='22023',message='online order missing'; end if;
end;
$function$;
grant create on schema payments_private to payments_writer;
alter function payments_private.transition_payment(uuid,uuid,text) owner to payments_writer;
alter function payments_private.create_cod_payment(uuid,uuid) owner to payments_writer;
revoke create on schema payments_private from payments_writer;
revoke all on function payments_private.transition_payment(uuid,uuid,text), payments_private.create_cod_payment(uuid,uuid) from public;
grant usage on schema payments_private to online_writer;
grant execute on function payments_private.transition_payment(uuid,uuid,text), payments_private.create_cod_payment(uuid,uuid) to online_writer;

-- No customer/reservation/checkout table is readable by public or authenticated database clients.
do $block$
declare t text;
begin
  foreach t in array array['customers','customer_addresses','storefront_checkout_settings','stock_reservations','checkout_operations'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public',t);
    execute format('grant create on schema public to online_writer');
    execute format('alter table public.%I owner to online_writer',t);
      if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on public.%I from anon',t); end if;
      if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on public.%I from authenticated',t); end if;
      if exists(select 1 from pg_roles where rolname='service_role') then
        execute format('revoke all on public.%I from service_role',t);
        execute format('grant select on public.%I to service_role',t);
      end if;
  end loop;
end;
$block$;
revoke create on schema public from online_writer;

-- Read capabilities for dedicated non-login writers; tenant predicates remain mandatory in functions.
do $block$
declare t text;
begin
  foreach t in array array['tenants','brands','inventory_locations','products','product_variants','variant_prices','orders','order_lines','payments','inventory_balances'] loop
    execute format('grant select on public.%I to online_writer',t);
    execute format('create policy online_writer_read on public.%I for select to online_writer using (true)',t);
  end loop;
end;
$block$;
grant execute on function orders_private.create_order(uuid,text,text,uuid,uuid,uuid,uuid,text,timestamptz,text,jsonb),
  orders_private.cancel_order(uuid,uuid,uuid,text) to online_writer;
grant execute on function commerce_locks.acquire_order_execution_lock(uuid,uuid), commerce_locks.acquire_inventory_location_lifecycle_lock(uuid,uuid) to online_writer;

-- A narrow lock helper avoids giving checkout writers UPDATE access to the inventory truth.
create function inventory_private.lock_checkout_balance(p_tenant uuid,p_variant uuid,p_location uuid)
returns bigint language plpgsql security definer set search_path = '' as $function$
declare q bigint;
begin
  select on_hand_quantity into q from public.inventory_balances
    where tenant_id=p_tenant and variant_id=p_variant and inventory_location_id=p_location for update;
  return coalesce(q,0);
end;
$function$;
grant create on schema inventory_private to inventory_writer;
alter function inventory_private.lock_checkout_balance(uuid,uuid,uuid) owner to inventory_writer;
revoke create on schema inventory_private from inventory_writer;
revoke all on function inventory_private.lock_checkout_balance(uuid,uuid,uuid) from public;
grant execute on function inventory_private.lock_checkout_balance(uuid,uuid,uuid) to online_writer;

-- Snapshot is attached exactly once, inside placement, and never changed by ordinary order updates.
create function orders_private.attach_checkout_customer(p_tenant uuid,p_order uuid,p_customer uuid,p_contact jsonb,p_delivery jsonb)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  perform set_config('orders_private.allow_order_write','on',true);
  update public.orders set customer_id=p_customer,customer_snapshot=p_contact,delivery_snapshot=p_delivery
    where tenant_id=p_tenant and id=p_order and channel='online' and customer_id is null;
  if not found then raise exception using errcode='22023',message='checkout snapshot already attached'; end if;
  perform set_config('orders_private.allow_order_write','off',true);
end;
$function$;
grant create on schema orders_private to orders_writer;
alter function orders_private.attach_checkout_customer(uuid,uuid,uuid,jsonb,jsonb) owner to orders_writer;
revoke create on schema orders_private from orders_writer;
revoke all on function orders_private.attach_checkout_customer(uuid,uuid,uuid,jsonb,jsonb) from public;
grant execute on function orders_private.attach_checkout_customer(uuid,uuid,uuid,jsonb,jsonb) to online_writer;
