-- Generic durable Payment entity. Connected POS V1 exposes only captured cash, while the entity and
-- Order relationship remain stable extension points for later methods.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'payments_writer') then
    create role payments_writer nologin noinherit nobypassrls;
  end if;
  execute pg_catalog.format('grant payments_writer to %I with set true', current_user);
end;
$block$;

create schema if not exists payments_private;
revoke all on schema payments_private from public;
grant usage on schema public, payments_private to payments_writer;

insert into public.permissions (key, description)
values ('payments.capture', 'Capture a payment for an order in the authorized commercial scope.')
on conflict (key) do nothing;

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  method text not null,
  status text not null,
  currency text not null,
  amount_minor bigint not null,
  cash_received_minor bigint not null,
  change_minor bigint not null,
  captured_by_membership_id uuid not null,
  idempotency_key text not null,
  normalized_idempotency_key text generated always as (lower(btrim(idempotency_key))) stored,
  payload_fingerprint text not null,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_tenant_fk foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint payments_order_tenant_fk foreign key (tenant_id, order_id)
    references public.orders (tenant_id, id) on delete restrict,
  constraint payments_actor_tenant_fk foreign key (tenant_id, captured_by_membership_id)
    references public.memberships (tenant_id, id) on delete restrict,
  constraint payments_method_v1_valid check (method = 'cash'),
  constraint payments_status_v1_valid check (status = 'captured'),
  constraint payments_currency_valid check (currency ~ '^[A-Z]{3}$'),
  constraint payments_amount_nonnegative check (amount_minor >= 0),
  constraint payments_cash_received_covers_amount check (cash_received_minor >= amount_minor),
  constraint payments_change_identity check (change_minor = cash_received_minor - amount_minor),
  constraint payments_idempotency_not_blank check (normalized_idempotency_key <> ''),
  constraint payments_updated_after_created check (updated_at >= created_at),
  constraint payments_tenant_id_unique unique (tenant_id, id),
  constraint payments_one_v1_payment_per_order unique (tenant_id, order_id),
  constraint payments_tenant_idempotency_unique unique (tenant_id, normalized_idempotency_key)
);

comment on table public.payments is
  'Durable Order payment entity. V1 permits exactly one captured cash payment; future methods extend this entity rather than replace it.';
comment on column public.payments.amount_minor is
  'Settled amount; capture_cash_payment enforces equality with the authoritative Order total.';

create index payments_tenant_captured_idx on public.payments (tenant_id, captured_at desc);

create function payments_private.forbid_payment_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $function$
begin
  raise exception using errcode = '42501', message = 'captured payments are immutable';
end;
$function$;

create trigger payments_immutable before update or delete on public.payments
for each row execute function payments_private.forbid_payment_mutation();

create function payments_private.capture_cash_payment(
  p_tenant_id uuid,
  p_order_id uuid,
  p_cash_received_minor bigint,
  p_captured_by_membership_id uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql security definer set search_path = '' as $function$
declare
  v_key text := lower(btrim(p_idempotency_key));
  v_order_total bigint;
  v_currency text;
  v_fingerprint text;
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_payment_id uuid;
begin
  if p_tenant_id is null or p_order_id is null or p_captured_by_membership_id is null
    or p_idempotency_key is null or v_key = '' or p_cash_received_minor is null then
    raise exception using errcode = '22004', message = 'cash capture fields are required';
  end if;

  select o.total_minor, o.currency into v_order_total, v_currency
  from public.orders o where o.tenant_id = p_tenant_id and o.id = p_order_id;
  if not found then
    raise exception using errcode = 'FF010', message = 'order not found';
  end if;
  if p_cash_received_minor < v_order_total then
    raise exception using errcode = 'PS030', message = 'cash received is below order total';
  end if;

  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || p_order_id::text || E'\n' || p_cash_received_minor::text
  );
  select p.id, p.payload_fingerprint into v_existing_id, v_existing_fingerprint
  from public.payments p
  where p.tenant_id = p_tenant_id and p.normalized_idempotency_key = v_key;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'payment idempotency conflict';
    end if;
    return v_existing_id;
  end if;

  insert into public.payments (
    tenant_id, order_id, method, status, currency, amount_minor, cash_received_minor,
    change_minor, captured_by_membership_id, idempotency_key, payload_fingerprint
  ) values (
    p_tenant_id, p_order_id, 'cash', 'captured', v_currency, v_order_total,
    p_cash_received_minor, p_cash_received_minor - v_order_total,
    p_captured_by_membership_id, p_idempotency_key, v_fingerprint
  ) returning id into v_payment_id;
  return v_payment_id;
exception
  when unique_violation then
    select p.id, p.payload_fingerprint into v_existing_id, v_existing_fingerprint
    from public.payments p
    where p.tenant_id = p_tenant_id and p.normalized_idempotency_key = v_key;
    if v_existing_id is null or v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'payment idempotency conflict';
    end if;
    return v_existing_id;
end;
$function$;

grant create on schema public, payments_private to payments_writer;
alter table public.payments owner to payments_writer;
alter function payments_private.forbid_payment_mutation() owner to payments_writer;
alter function payments_private.capture_cash_payment(uuid, uuid, bigint, uuid, text) owner to payments_writer;
revoke create on schema public, payments_private from payments_writer;
revoke all on function payments_private.forbid_payment_mutation() from public;
revoke all on function payments_private.capture_cash_payment(uuid, uuid, bigint, uuid, text) from public;

alter table public.payments enable row level security;
revoke all on table public.payments from public;

-- The payment function resolves the immutable Order total through a narrow read-only policy.
grant select on table public.orders to payments_writer;
create policy payments_writer_order_read on public.orders for select to payments_writer using (true);

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.payments from anon';
    execute 'revoke all on schema payments_private from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.payments from authenticated';
    execute 'revoke all on schema payments_private from authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant select on table public.payments to service_role';
  end if;
end;
$block$;
