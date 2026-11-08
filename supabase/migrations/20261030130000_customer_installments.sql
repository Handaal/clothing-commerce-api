-- Customer installments (accounts receivable).
--
-- A connected POS sale may be settled only partially: the goods leave the store now, the customer pays
-- a deposit (possibly zero), and the unpaid remainder becomes a debt recorded against the customer to
-- be paid down on later visits. This mirrors the supplier_money model (aggregate per-counterparty
-- dues), on the customer side: customer_sale_debts holds the per-sale total + amount paid at sale time,
-- customer_payments are standalone paydowns, and outstanding is derived per customer
-- (sum(total) - sum(initial_paid) - sum(payments)). Deliberately no interest, schedules or COGS.

-- Role that owns the A/R tables and SECURITY DEFINER functions. A table owner is exempt from its own
-- RLS (no FORCE), so the functions can read/write across tenants while callers remain gated by the
-- EXECUTE grants below. nobypassrls keeps the role from bypassing RLS on tables it does not own.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'customers_ar_writer') then
    create role customers_ar_writer nologin noinherit nobypassrls;
  end if;
  execute pg_catalog.format('grant customers_ar_writer to %I with set true', current_user);
end
$$;

create schema if not exists customers_ar_private;
grant usage on schema public, customers_ar_private to customers_ar_writer;
-- The writer role must hold CREATE on the private schema to OWN the functions defined below.
grant create on schema customers_ar_private to customers_ar_writer;

-- Per-sale debt. initial_paid_minor is what the customer paid at the point of sale; the remainder is
-- outstanding until paid down. One row per order (idempotent against a sale replay).
create table public.customer_sale_debts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  order_id uuid not null,
  customer_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check (total_minor >= 0 and total_minor <= 9007199254740991),
  initial_paid_minor bigint not null check (
    initial_paid_minor >= 0 and initial_paid_minor <= total_minor
  ),
  actor_membership_id uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, order_id),
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete restrict,
  foreign key (tenant_id, customer_id) references public.customers(tenant_id, id) on delete restrict,
  foreign key (tenant_id, actor_membership_id)
    references public.memberships(tenant_id, id) on delete restrict
);
create index customer_sale_debts_by_customer
  on public.customer_sale_debts (tenant_id, customer_id);

-- Standalone customer paydown, applied against the customer's aggregate outstanding.
create table public.customer_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  customer_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 9007199254740991),
  paid_at timestamptz not null,
  notes text check (notes is null or length(btrim(notes)) between 1 and 500),
  actor_membership_id uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers(tenant_id, id) on delete restrict,
  foreign key (tenant_id, actor_membership_id)
    references public.memberships(tenant_id, id) on delete restrict
);
create index customer_payments_by_customer
  on public.customer_payments (tenant_id, customer_id);

-- Idempotency journal for A/R commands (payment recording), mirroring supplier_money_commands.
create table public.customer_ar_commands (
  tenant_id uuid not null,
  command_kind text not null,
  normalized_key text not null,
  payload_fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, command_kind, normalized_key)
);

alter table public.customer_sale_debts enable row level security;
alter table public.customer_payments enable row level security;
alter table public.customer_ar_commands enable row level security;

grant create on schema public to customers_ar_writer;
alter table public.customer_sale_debts owner to customers_ar_writer;
alter table public.customer_payments owner to customers_ar_writer;
alter table public.customer_ar_commands owner to customers_ar_writer;
revoke create on schema public from customers_ar_writer;

-- The management customers read repository derives each customer's outstanding balance by reading these
-- A/R tables directly through the service-role client (SupabaseCustomersReadRepository.outstandingFor),
-- so service_role needs SELECT. service_role bypasses RLS, so no policy is required for it.
grant select on public.customer_sale_debts, public.customer_payments to service_role;

-- The dues projection reads customers + tenants; grant select + a permissive policy for the owner role.
grant select on public.customers, public.tenants to customers_ar_writer;
create policy customers_ar_writer_customers_read on public.customers
  for select to customers_ar_writer using (true);
create policy customers_ar_writer_tenants_read on public.tenants
  for select to customers_ar_writer using (true);

-- ---------------------------------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------------------------------

create function customers_ar_private.ar_command_replay(
  p_tenant uuid, p_kind text, p_key text, p_fingerprint text
) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare v_command public.customer_ar_commands;
begin
  select * into v_command from public.customer_ar_commands
  where tenant_id = p_tenant and command_kind = p_kind and normalized_key = p_key;
  if found then
    if v_command.payload_fingerprint is distinct from p_fingerprint then
      raise exception using errcode = 'ID409', message = 'Customer A/R intent conflict';
    end if;
    return v_command.response;
  end if;
  return null;
end
$f$;

-- Record the debt produced by an installment sale. Called from record_sale (pos_sales_writer) with the
-- customer already matched. Idempotent on order_id so a sale replay does not double-count.
create function customers_ar_private.record_sale_debt(
  p_tenant uuid, p_order uuid, p_customer uuid, p_currency text,
  p_total_minor bigint, p_paid_minor bigint, p_actor uuid
) returns void
language plpgsql security definer set search_path = '' as $f$
begin
  if p_total_minor is null or p_paid_minor is null or p_paid_minor < 0
    or p_paid_minor > p_total_minor then
    raise exception using errcode = '22023', message = 'invalid customer debt amounts';
  end if;
  insert into public.customer_sale_debts (
    tenant_id, order_id, customer_id, currency, total_minor, initial_paid_minor, actor_membership_id
  ) values (
    p_tenant, p_order, p_customer, p_currency, p_total_minor, p_paid_minor, p_actor
  ) on conflict (tenant_id, order_id) do nothing;
end
$f$;

-- Aggregate outstanding for one customer (total owed minus paid at sale minus later payments).
create function customers_ar_private.customer_outstanding(p_tenant uuid, p_customer uuid)
returns bigint language sql security definer set search_path = '' as $f$
  select greatest(0,
    coalesce((select sum(total_minor - initial_paid_minor) from public.customer_sale_debts
      where tenant_id = p_tenant and customer_id = p_customer), 0)
    - coalesce((select sum(amount_minor) from public.customer_payments
      where tenant_id = p_tenant and customer_id = p_customer), 0)
  )::bigint
$f$;

-- Record a standalone customer paydown. Validates the amount does not exceed current outstanding.
create function customers_ar_private.record_customer_payment(
  p_tenant uuid, p_customer uuid, p_actor uuid, p_key text, p_input jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare
  v_key text := lower(btrim(p_key));
  v_fingerprint text := md5(p_input::text || E'\n' || p_customer::text || E'\n' || p_actor::text);
  v_replay jsonb;
  v_amount bigint;
  v_outstanding bigint;
  v_currency text;
  v_paid_at timestamptz;
  v_notes text;
  v_row public.customer_payments;
  v_response jsonb;
begin
  if p_tenant is null or p_customer is null or p_actor is null or p_input is null
    or jsonb_typeof(p_input) <> 'object' or v_key is null or length(v_key) not between 1 and 200
    or not (p_input ? 'amountMinor') then
    raise exception using errcode = 'CA422', message = 'Invalid customer payment';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('customer-ar:' || p_tenant::text || ':payment:' || v_key, 0));
  v_replay := customers_ar_private.ar_command_replay(p_tenant, 'payment', v_key, v_fingerprint);
  if v_replay is not null then return v_replay; end if;

  if not exists (select 1 from public.customers where tenant_id = p_tenant and id = p_customer) then
    raise exception using errcode = 'CA404', message = 'Customer not found';
  end if;
  v_amount := (p_input ->> 'amountMinor')::bigint;
  if v_amount is null or v_amount <= 0 or v_amount > 9007199254740991 then
    raise exception using errcode = 'CA422', message = 'payment amount must be positive';
  end if;
  v_outstanding := customers_ar_private.customer_outstanding(p_tenant, p_customer);
  if v_amount > v_outstanding then
    raise exception using errcode = 'CA409', message = 'payment exceeds outstanding balance';
  end if;
  select default_currency into v_currency from public.tenants where id = p_tenant;
  v_paid_at := coalesce((p_input ->> 'paidAt')::timestamptz, now());
  v_notes := case when p_input ? 'notes' and btrim(coalesce(p_input ->> 'notes', '')) <> ''
    then btrim(p_input ->> 'notes') else null end;

  insert into public.customer_payments (
    tenant_id, customer_id, currency, amount_minor, paid_at, notes, actor_membership_id
  ) values (
    p_tenant, p_customer, v_currency, v_amount, v_paid_at, v_notes, p_actor
  ) returning * into v_row;

  v_response := jsonb_build_object(
    'id', v_row.id, 'customerId', v_row.customer_id, 'currency', v_row.currency,
    'amountMinor', v_row.amount_minor, 'paidAt', v_row.paid_at, 'notes', v_row.notes,
    'actorMembershipId', v_row.actor_membership_id, 'createdAt', v_row.created_at,
    'outstandingMinor', customers_ar_private.customer_outstanding(p_tenant, p_customer));
  insert into public.customer_ar_commands (
    tenant_id, command_kind, normalized_key, payload_fingerprint, response
  ) values (p_tenant, 'payment', v_key, v_fingerprint, v_response);
  return v_response;
end
$f$;

-- Dues for every customer that has any A/R activity, newest-name order. Mirrors supplier_dues.
create function customers_ar_private.customer_dues(p_tenant uuid)
returns jsonb language sql security definer set search_path = '' as $f$
  select coalesce(jsonb_agg(jsonb_build_object(
    'customerId', c.id, 'customerName', c.name, 'phone', c.phone,
    'currency', t.default_currency,
    'purchasedMinor', coalesce(d.total, 0),
    'paidMinor', least(coalesce(d.total, 0), coalesce(d.initial_paid, 0) + coalesce(pay.paid, 0)),
    'outstandingMinor', greatest(0,
      coalesce(d.total, 0) - coalesce(d.initial_paid, 0) - coalesce(pay.paid, 0))
  ) order by c.name, c.id), '[]'::jsonb)
  from public.customers c
  join public.tenants t on t.id = c.tenant_id
  join lateral (
    select sum(total_minor)::bigint total, sum(initial_paid_minor)::bigint initial_paid
    from public.customer_sale_debts where tenant_id = p_tenant and customer_id = c.id
  ) d on d.total is not null
  left join lateral (
    select sum(amount_minor)::bigint paid from public.customer_payments
    where tenant_id = p_tenant and customer_id = c.id
  ) pay on true
  where c.tenant_id = p_tenant
$f$;

-- Payment history for one customer, newest first (bounded, cursorless — A/R per customer is small).
create function customers_ar_private.list_customer_payments(
  p_tenant uuid, p_customer uuid, p_limit integer
) returns jsonb language sql security definer set search_path = '' as $f$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', x.id, 'customerId', x.customer_id, 'currency', x.currency,
      'amountMinor', x.amount_minor, 'paidAt', x.paid_at, 'notes', x.notes,
      'actorMembershipId', x.actor_membership_id, 'createdAt', x.created_at
    ) order by x.created_at desc), '[]'::jsonb)
  from (
    select p.id, p.customer_id, p.currency, p.amount_minor, p.paid_at, p.notes,
      p.actor_membership_id, p.created_at
    from public.customer_payments p
    where p.tenant_id = p_tenant and p.customer_id = p_customer
    order by p.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) x
$f$;

alter function customers_ar_private.ar_command_replay(uuid, text, text, text) owner to customers_ar_writer;
alter function customers_ar_private.record_sale_debt(uuid, uuid, uuid, text, bigint, bigint, uuid)
  owner to customers_ar_writer;
alter function customers_ar_private.customer_outstanding(uuid, uuid) owner to customers_ar_writer;
alter function customers_ar_private.record_customer_payment(uuid, uuid, uuid, text, jsonb)
  owner to customers_ar_writer;
alter function customers_ar_private.customer_dues(uuid) owner to customers_ar_writer;
alter function customers_ar_private.list_customer_payments(uuid, uuid, integer)
  owner to customers_ar_writer;

-- Grants: service_role for the management repositories; record_sale_debt also to pos_sales_writer so
-- the connected sale can record the debt inside record_sale.
do $block$
begin
  execute 'revoke all on all functions in schema customers_ar_private from public';
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    -- USAGE on the schema is required in addition to EXECUTE on the functions (mirrors suppliers_private);
    -- without it a service_role call fails with "permission denied for schema customers_ar_private".
    execute 'grant usage on schema customers_ar_private to service_role';
    execute 'grant execute on function customers_ar_private.record_customer_payment(uuid, uuid, uuid, text, jsonb) to service_role';
    execute 'grant execute on function customers_ar_private.customer_dues(uuid) to service_role';
    execute 'grant execute on function customers_ar_private.customer_outstanding(uuid, uuid) to service_role';
    execute 'grant execute on function customers_ar_private.list_customer_payments(uuid, uuid, integer) to service_role';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'pos_sales_writer') then
    execute 'grant usage on schema customers_ar_private to pos_sales_writer';
    execute 'grant execute on function customers_ar_private.record_sale_debt(uuid, uuid, uuid, text, bigint, bigint, uuid) to pos_sales_writer';
  end if;
end;
$block$;
