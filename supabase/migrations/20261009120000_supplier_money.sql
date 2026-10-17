-- Supplier money: atomic purchase receipts, standalone due payments and payment reminders.
-- Costs are immutable AP/history facts only; this migration deliberately does not introduce
-- inventory valuation, FIFO/weighted costing, COGS or a purchase-order domain.

create table public.supplier_purchases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  supplier_id uuid not null,
  inventory_operation_id uuid not null,
  inventory_location_id uuid not null,
  supplier_name_snapshot text not null,
  supplier_code_snapshot text,
  supplier_reference text,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check (total_minor >= 0 and total_minor <= 9007199254740991),
  initial_paid_minor bigint not null check (
    initial_paid_minor >= 0 and initial_paid_minor <= total_minor
  ),
  occurred_at timestamptz not null,
  notes text check (notes is null or length(btrim(notes)) between 1 and 500),
  actor_membership_id uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, inventory_operation_id),
  foreign key (tenant_id, supplier_id) references public.suppliers(tenant_id, id) on delete restrict,
  foreign key (tenant_id, inventory_operation_id)
    references public.inventory_operations(tenant_id, id) on delete restrict,
  foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations(tenant_id, id) on delete restrict,
  foreign key (tenant_id, actor_membership_id)
    references public.memberships(tenant_id, id) on delete restrict
);

create table public.supplier_purchase_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_id uuid not null,
  line_number integer not null check (line_number > 0),
  variant_id uuid not null,
  sku_snapshot text not null,
  product_name_snapshot text not null,
  quantity bigint not null check (quantity > 0 and quantity <= 9007199254740991),
  unit_cost_minor bigint not null check (
    unit_cost_minor >= 0 and unit_cost_minor <= 9007199254740991
  ),
  line_total_minor bigint not null check (
    line_total_minor >= 0 and line_total_minor <= 9007199254740991
  ),
  unique (tenant_id, id),
  unique (tenant_id, purchase_id, line_number),
  foreign key (tenant_id, purchase_id)
    references public.supplier_purchases(tenant_id, id) on delete restrict,
  foreign key (tenant_id, variant_id)
    references public.product_variants(tenant_id, id) on delete restrict
);

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  supplier_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 9007199254740991),
  paid_at timestamptz not null,
  notes text check (notes is null or length(btrim(notes)) between 1 and 500),
  actor_membership_id uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references public.suppliers(tenant_id, id) on delete restrict,
  foreign key (tenant_id, actor_membership_id)
    references public.memberships(tenant_id, id) on delete restrict
);

create table public.supplier_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  supplier_id uuid not null,
  due_date date not null,
  amount_minor bigint check (amount_minor is null or (amount_minor > 0 and amount_minor <= 9007199254740991)),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  note text check (note is null or length(btrim(note)) between 1 and 500),
  lead_days integer not null default 3 check (lead_days between 0 and 365),
  notify boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'done')),
  actor_membership_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references public.suppliers(tenant_id, id) on delete restrict,
  foreign key (tenant_id, actor_membership_id)
    references public.memberships(tenant_id, id) on delete restrict
);

create table public.supplier_money_commands (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  command_kind text not null check (
    command_kind in ('purchase', 'payment', 'reminder_create', 'reminder_update', 'reminder_delete')
  ),
  normalized_key text not null check (length(normalized_key) between 1 and 200),
  payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{32}$'),
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, command_kind, normalized_key)
);

create index supplier_purchases_supplier_id_desc
  on public.supplier_purchases(tenant_id, supplier_id, id desc);
create index supplier_purchase_items_purchase_line
  on public.supplier_purchase_items(tenant_id, purchase_id, line_number);
create index supplier_payments_supplier_id_desc
  on public.supplier_payments(tenant_id, supplier_id, id desc);
create index supplier_reminders_tenant_due
  on public.supplier_reminders(tenant_id, status, due_date, id);

alter table public.supplier_purchases enable row level security;
alter table public.supplier_purchase_items enable row level security;
alter table public.supplier_payments enable row level security;
alter table public.supplier_reminders enable row level security;
alter table public.supplier_money_commands enable row level security;
revoke all on public.supplier_purchases, public.supplier_purchase_items, public.supplier_payments,
  public.supplier_reminders, public.supplier_money_commands from public, anon, authenticated, service_role;
grant create on schema public to suppliers_writer;
alter table public.supplier_purchases owner to suppliers_writer;
alter table public.supplier_purchase_items owner to suppliers_writer;
alter table public.supplier_payments owner to suppliers_writer;
alter table public.supplier_reminders owner to suppliers_writer;
alter table public.supplier_money_commands owner to suppliers_writer;
revoke create on schema public from suppliers_writer;

create policy suppliers_writer_money_read on public.supplier_purchases
  for select to suppliers_writer using (true);
create policy suppliers_writer_money_read on public.supplier_purchase_items
  for select to suppliers_writer using (true);
create policy suppliers_writer_money_read on public.supplier_payments
  for select to suppliers_writer using (true);
create policy suppliers_writer_money_read on public.supplier_reminders
  for select to suppliers_writer using (true);
create policy suppliers_writer_money_read on public.supplier_money_commands
  for select to suppliers_writer using (true);
create policy suppliers_writer_money_tenant_read on public.tenants
  for select to suppliers_writer using (true);

create function suppliers_private.money_command_replay(
  p_tenant uuid, p_kind text, p_key text, p_fingerprint text
) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare v_command public.supplier_money_commands;
begin
  select * into v_command from public.supplier_money_commands
  where tenant_id = p_tenant and command_kind = p_kind and normalized_key = p_key;
  if found then
    if v_command.payload_fingerprint is distinct from p_fingerprint then
      raise exception using errcode = 'ID409', message = 'Supplier money intent conflict';
    end if;
    return v_command.response;
  end if;
  return null;
end
$f$;

create function suppliers_private.record_supplier_purchase(
  p_tenant uuid, p_actor uuid, p_key text, p_input jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare
  v_key text := lower(btrim(p_key));
  v_fingerprint text := md5(p_input::text || E'\n' || p_actor::text);
  v_replay jsonb;
  v_supplier public.suppliers;
  v_currency text;
  v_location_name text;
  v_total numeric;
  v_paid bigint;
  v_operation uuid;
  v_purchase public.supplier_purchases;
  v_response jsonb;
  v_movements jsonb;
begin
  if p_tenant is null or p_actor is null or p_input is null or jsonb_typeof(p_input) <> 'object'
    or v_key is null or length(v_key) not between 1 and 200
    or not (p_input ? 'supplierId') or not (p_input ? 'inventoryLocationId')
    or not (p_input ? 'lines') or jsonb_typeof(p_input -> 'lines') <> 'array'
    or jsonb_array_length(p_input -> 'lines') not between 1 and 100 then
    raise exception using errcode = 'SP422', message = 'Invalid supplier purchase';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-money:' || p_tenant::text || ':purchase:' || v_key, 0));
  v_replay := suppliers_private.money_command_replay(p_tenant, 'purchase', v_key, v_fingerprint);
  if v_replay is not null then return v_replay; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'supplier-balance:' || p_tenant::text || ':' || (p_input ->> 'supplierId'), 0));
  v_supplier := suppliers_private.lock_receipt_supplier(p_tenant, (p_input ->> 'supplierId')::uuid);
  select t.default_currency into v_currency from public.tenants t where t.id = p_tenant;
  select l.display_name into v_location_name from public.inventory_locations l
  where l.tenant_id = p_tenant and l.id = (p_input ->> 'inventoryLocationId')::uuid
    and l.status = 'active' and l.is_receiving_enabled for share;
  if not found then raise exception using errcode = 'IL409', message = 'Inventory location cannot receive'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_input -> 'lines') line
    left join public.product_variants v
      on v.tenant_id = p_tenant and v.id = (line ->> 'variantId')::uuid and v.status = 'active'
    where v.id is null or (line ->> 'quantity')::bigint <= 0
      or (line ->> 'unitCostMinor')::bigint < 0
  ) or (
    select count(*) <> count(distinct line ->> 'variantId')
    from jsonb_array_elements(p_input -> 'lines') line
  ) then raise exception using errcode = 'SP422', message = 'Invalid supplier purchase line'; end if;

  select sum((line ->> 'quantity')::numeric * (line ->> 'unitCostMinor')::numeric)
    into v_total from jsonb_array_elements(p_input -> 'lines') line;
  if v_total < 0 or v_total > 9007199254740991 then
    raise exception using errcode = 'SP422', message = 'Supplier purchase total is invalid';
  end if;
  v_paid := coalesce((p_input ->> 'paidMinor')::bigint, v_total::bigint);
  if v_paid < 0 or v_paid > v_total then
    raise exception using errcode = 'SP422', message = 'Supplier purchase paid amount is invalid';
  end if;
  select jsonb_agg(jsonb_build_object(
    'variant_id', line ->> 'variantId',
    'inventory_location_id', p_input ->> 'inventoryLocationId',
    'quantity_delta', (line ->> 'quantity')::bigint
  ) order by ord) into v_movements
  from jsonb_array_elements(p_input -> 'lines') with ordinality lines(line, ord);

  v_operation := inventory_private.record_operation(
    p_tenant, 'receipt', v_movements, p_actor, p_key,
    case when p_input ? 'occurredAt' then (p_input ->> 'occurredAt')::timestamptz else now() end,
    p_input ->> 'notes', v_supplier.id, p_input ->> 'supplierReference'
  );
  insert into public.supplier_purchases(
    tenant_id, supplier_id, inventory_operation_id, inventory_location_id,
    supplier_name_snapshot, supplier_code_snapshot, supplier_reference, currency,
    total_minor, initial_paid_minor, occurred_at, notes, actor_membership_id
  ) values (
    p_tenant, v_supplier.id, v_operation, (p_input ->> 'inventoryLocationId')::uuid,
    v_supplier.name, v_supplier.code, p_input ->> 'supplierReference', v_currency,
    v_total::bigint, v_paid,
    case when p_input ? 'occurredAt' then (p_input ->> 'occurredAt')::timestamptz else now() end,
    p_input ->> 'notes', p_actor
  ) returning * into v_purchase;

  insert into public.supplier_purchase_items(
    tenant_id, purchase_id, line_number, variant_id, sku_snapshot,
    product_name_snapshot, quantity, unit_cost_minor, line_total_minor
  )
  select p_tenant, v_purchase.id, lines.ord::integer, v.id, v.sku, p.name,
    (lines.line ->> 'quantity')::bigint, (lines.line ->> 'unitCostMinor')::bigint,
    ((lines.line ->> 'quantity')::bigint * (lines.line ->> 'unitCostMinor')::bigint)
  from jsonb_array_elements(p_input -> 'lines') with ordinality lines(line, ord)
  join public.product_variants v on v.tenant_id = p_tenant and v.id = (lines.line ->> 'variantId')::uuid
  join public.products p on p.tenant_id = v.tenant_id and p.id = v.product_id;

  v_response := jsonb_build_object(
    'id', v_purchase.id, 'supplierId', v_purchase.supplier_id,
    'supplierName', v_purchase.supplier_name_snapshot, 'supplierCode', v_purchase.supplier_code_snapshot,
    'inventoryOperationId', v_purchase.inventory_operation_id,
    'inventoryLocationId', v_purchase.inventory_location_id, 'inventoryLocationName', v_location_name,
    'supplierReference', v_purchase.supplier_reference, 'currency', v_purchase.currency,
    'totalMinor', v_purchase.total_minor, 'initialPaidMinor', v_purchase.initial_paid_minor,
    'effectivePaidMinor', v_purchase.initial_paid_minor,
    'outstandingMinor', v_purchase.total_minor - v_purchase.initial_paid_minor,
    'occurredAt', v_purchase.occurred_at, 'notes', v_purchase.notes,
    'actorMembershipId', v_purchase.actor_membership_id, 'createdAt', v_purchase.created_at
  );
  insert into public.supplier_money_commands(tenant_id, command_kind, normalized_key, payload_fingerprint, response)
  values (p_tenant, 'purchase', v_key, v_fingerprint, v_response);
  return v_response;
end
$f$;

create function suppliers_private.list_supplier_purchases(
  p_tenant uuid, p_supplier uuid, p_after uuid, p_limit integer
) returns jsonb
language plpgsql security definer set search_path = '' as $f$
begin
  if p_limit is null or p_limit not between 1 and 101 then
    raise exception using errcode = 'SP422', message = 'Invalid supplier purchase page';
  end if;
  return (
    with payment_totals as (
      select supplier_id, sum(amount_minor)::bigint paid
      from public.supplier_payments where tenant_id = p_tenant group by supplier_id
    ), purchase_effective as (
      select p.*,
        least(
          p.total_minor - p.initial_paid_minor,
          greatest(0::bigint, coalesce(pt.paid, 0) - coalesce((
            select sum(older.total_minor - older.initial_paid_minor)::bigint
            from public.supplier_purchases older
            where older.tenant_id = p.tenant_id and older.supplier_id = p.supplier_id
              and (older.occurred_at, older.id) < (p.occurred_at, p.id)
          ), 0))
        )::bigint applied_payment
      from public.supplier_purchases p
      left join payment_totals pt on pt.supplier_id = p.supplier_id
      where p.tenant_id = p_tenant and (p_supplier is null or p.supplier_id = p_supplier)
        and (p_after is null or p.id < p_after)
      order by p.id desc limit p_limit
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'supplierId', p.supplier_id,
      'supplierName', p.supplier_name_snapshot, 'supplierCode', p.supplier_code_snapshot,
      'inventoryOperationId', p.inventory_operation_id,
      'inventoryLocationId', p.inventory_location_id, 'inventoryLocationName', l.display_name,
      'supplierReference', p.supplier_reference, 'currency', p.currency,
      'totalMinor', p.total_minor, 'initialPaidMinor', p.initial_paid_minor,
      'effectivePaidMinor', p.initial_paid_minor + p.applied_payment,
      'outstandingMinor', p.total_minor - p.initial_paid_minor - p.applied_payment,
      'occurredAt', p.occurred_at, 'notes', p.notes,
      'actorMembershipId', p.actor_membership_id, 'createdAt', p.created_at
    ) order by p.id desc), '[]'::jsonb)
    from purchase_effective p
    join public.inventory_locations l on l.tenant_id = p.tenant_id and l.id = p.inventory_location_id
  );
end
$f$;

create function suppliers_private.supplier_purchase_items(p_tenant uuid, p_purchase uuid)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_items jsonb;
begin
  perform 1 from public.supplier_purchases where tenant_id = p_tenant and id = p_purchase;
  if not found then raise exception using errcode = 'SP404', message = 'Supplier purchase not found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'lineNumber', i.line_number, 'variantId', i.variant_id,
    'sku', i.sku_snapshot, 'productName', i.product_name_snapshot,
    'quantity', i.quantity, 'unitCostMinor', i.unit_cost_minor,
    'lineTotalMinor', i.line_total_minor
  ) order by i.line_number), '[]'::jsonb) into v_items
  from public.supplier_purchase_items i
  where i.tenant_id = p_tenant and i.purchase_id = p_purchase;
  return v_items;
end
$f$;

create function suppliers_private.record_supplier_payment(
  p_tenant uuid, p_supplier uuid, p_actor uuid, p_key text, p_input jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare
  v_key text := lower(btrim(p_key));
  v_fingerprint text := md5(jsonb_build_object('supplierId', p_supplier, 'input', p_input)::text || E'\n' || p_actor::text);
  v_replay jsonb; v_currency text; v_outstanding bigint; v_amount bigint;
  v_payment public.supplier_payments; v_response jsonb;
begin
  if p_tenant is null or p_supplier is null or p_actor is null or p_input is null
    or v_key is null or length(v_key) not between 1 and 200 then
    raise exception using errcode = 'SP422', message = 'Invalid supplier payment';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-money:' || p_tenant::text || ':payment:' || v_key, 0));
  v_replay := suppliers_private.money_command_replay(p_tenant, 'payment', v_key, v_fingerprint);
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-balance:' || p_tenant::text || ':' || p_supplier::text, 0));
  perform 1 from public.suppliers where tenant_id = p_tenant and id = p_supplier for share;
  if not found then raise exception using errcode = 'SU404', message = 'Supplier not found'; end if;
  select default_currency into v_currency from public.tenants where id = p_tenant;
  select coalesce((select sum(total_minor - initial_paid_minor) from public.supplier_purchases
      where tenant_id = p_tenant and supplier_id = p_supplier), 0)
    - coalesce((select sum(amount_minor) from public.supplier_payments
      where tenant_id = p_tenant and supplier_id = p_supplier), 0)
    into v_outstanding;
  v_amount := (p_input ->> 'amountMinor')::bigint;
  if v_amount is null or v_amount <= 0 then
    raise exception using errcode = 'SP422', message = 'Invalid supplier payment amount';
  end if;
  if v_outstanding <= 0 then
    raise exception using errcode = 'DU000', message = 'No outstanding supplier dues';
  end if;
  if v_amount > v_outstanding then
    raise exception using errcode = 'DU409', message = 'Supplier payment exceeds outstanding dues';
  end if;
  insert into public.supplier_payments(
    tenant_id, supplier_id, currency, amount_minor, paid_at, notes, actor_membership_id
  ) values (
    p_tenant, p_supplier, v_currency, v_amount,
    case when p_input ? 'paidAt' then (p_input ->> 'paidAt')::timestamptz else now() end,
    p_input ->> 'notes', p_actor
  ) returning * into v_payment;
  v_response := jsonb_build_object(
    'id', v_payment.id, 'supplierId', v_payment.supplier_id, 'currency', v_payment.currency,
    'amountMinor', v_payment.amount_minor, 'paidAt', v_payment.paid_at, 'notes', v_payment.notes,
    'actorMembershipId', v_payment.actor_membership_id, 'createdAt', v_payment.created_at
  );
  insert into public.supplier_money_commands(tenant_id, command_kind, normalized_key, payload_fingerprint, response)
  values (p_tenant, 'payment', v_key, v_fingerprint, v_response);
  return v_response;
end
$f$;

create function suppliers_private.list_supplier_payments(
  p_tenant uuid, p_supplier uuid, p_after uuid, p_limit integer
) returns jsonb language plpgsql security definer set search_path = '' as $f$
begin
  if p_limit is null or p_limit not between 1 and 101 then
    raise exception using errcode = 'SP422', message = 'Invalid supplier payment page';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'supplierId', p.supplier_id, 'currency', p.currency,
    'amountMinor', p.amount_minor, 'paidAt', p.paid_at, 'notes', p.notes,
    'actorMembershipId', p.actor_membership_id, 'createdAt', p.created_at
  ) order by p.id desc), '[]'::jsonb) from (
    select * from public.supplier_payments where tenant_id = p_tenant and supplier_id = p_supplier
      and (p_after is null or id < p_after) order by id desc limit p_limit
  ) p);
end
$f$;

create function suppliers_private.supplier_dues(p_tenant uuid)
returns jsonb language sql security definer set search_path = '' as $f$
  select coalesce(jsonb_agg(jsonb_build_object(
    'supplierId', s.id, 'supplierName', s.name, 'supplierCode', s.code,
    'supplierStatus', s.status, 'currency', t.default_currency,
    'purchasedMinor', coalesce(p.purchased, 0),
    'paidMinor', least(coalesce(p.purchased, 0), coalesce(p.initial_paid, 0) + coalesce(pay.paid, 0)),
    'outstandingMinor', greatest(0, coalesce(p.purchased, 0) - coalesce(p.initial_paid, 0) - coalesce(pay.paid, 0))
  ) order by s.name, s.id), '[]'::jsonb)
  from public.suppliers s
  join public.tenants t on t.id = s.tenant_id
  left join lateral (
    select sum(total_minor)::bigint purchased, sum(initial_paid_minor)::bigint initial_paid
    from public.supplier_purchases where tenant_id = p_tenant and supplier_id = s.id
  ) p on true
  left join lateral (
    select sum(amount_minor)::bigint paid from public.supplier_payments
    where tenant_id = p_tenant and supplier_id = s.id
  ) pay on true
  where s.tenant_id = p_tenant
$f$;

create function suppliers_private.reminder_json(p_reminder public.supplier_reminders)
returns jsonb language sql stable set search_path = '' as $f$
  select jsonb_build_object(
    'id', p_reminder.id, 'supplierId', p_reminder.supplier_id, 'supplierName', s.name,
    'dueDate', p_reminder.due_date, 'amountMinor', p_reminder.amount_minor,
    'currency', p_reminder.currency, 'note', p_reminder.note, 'leadDays', p_reminder.lead_days,
    'notify', p_reminder.notify, 'status', p_reminder.status,
    'isDue', p_reminder.status = 'pending' and
      (now() at time zone t.default_timezone)::date >= p_reminder.due_date - p_reminder.lead_days,
    'isOverdue', p_reminder.status = 'pending' and
      (now() at time zone t.default_timezone)::date > p_reminder.due_date,
    'actorMembershipId', p_reminder.actor_membership_id,
    'createdAt', p_reminder.created_at, 'updatedAt', p_reminder.updated_at
  ) from public.suppliers s join public.tenants t on t.id = s.tenant_id
  where s.tenant_id = p_reminder.tenant_id and s.id = p_reminder.supplier_id
$f$;

create function suppliers_private.write_supplier_reminder(
  p_tenant uuid, p_reminder uuid, p_actor uuid, p_key text, p_input jsonb, p_delete boolean
) returns jsonb language plpgsql security definer set search_path = '' as $f$
declare
  v_kind text := case when p_delete then 'reminder_delete' when p_reminder is null then 'reminder_create' else 'reminder_update' end;
  v_key text := lower(btrim(p_key));
  v_fingerprint text := md5(jsonb_build_object('reminderId', p_reminder, 'input', p_input, 'delete', p_delete)::text || E'\n' || p_actor::text);
  v_replay jsonb; v_row public.supplier_reminders; v_currency text; v_response jsonb;
begin
  if p_tenant is null or p_actor is null or p_input is null or jsonb_typeof(p_input) <> 'object'
    or v_key is null or length(v_key) not between 1 and 200 then
    raise exception using errcode = 'SP422', message = 'Invalid supplier reminder';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-money:' || p_tenant::text || ':' || v_kind || ':' || v_key, 0));
  v_replay := suppliers_private.money_command_replay(p_tenant, v_kind, v_key, v_fingerprint);
  if v_replay is not null then return v_replay; end if;
  if p_delete then
    select * into v_row from public.supplier_reminders
      where tenant_id = p_tenant and id = p_reminder for update;
    if not found then raise exception using errcode = 'SR404', message = 'Supplier reminder not found'; end if;
    delete from public.supplier_reminders where tenant_id = p_tenant and id = p_reminder;
    v_response := jsonb_build_object('id', p_reminder);
  elsif p_reminder is null then
    perform 1 from public.suppliers where tenant_id = p_tenant and id = (p_input ->> 'supplierId')::uuid;
    if not found then raise exception using errcode = 'SU404', message = 'Supplier not found'; end if;
    select default_currency into v_currency from public.tenants where id = p_tenant;
    insert into public.supplier_reminders(
      tenant_id, supplier_id, due_date, amount_minor, currency, note, lead_days, notify, actor_membership_id
    ) values (
      p_tenant, (p_input ->> 'supplierId')::uuid, (p_input ->> 'dueDate')::date,
      (p_input ->> 'amountMinor')::bigint, v_currency, p_input ->> 'note',
      coalesce((p_input ->> 'leadDays')::integer, 3), coalesce((p_input ->> 'notify')::boolean, true), p_actor
    ) returning * into v_row;
    v_response := suppliers_private.reminder_json(v_row);
  else
    select * into v_row from public.supplier_reminders
      where tenant_id = p_tenant and id = p_reminder for update;
    if not found then raise exception using errcode = 'SR404', message = 'Supplier reminder not found'; end if;
    if p_input ? 'supplierId' then
      perform 1 from public.suppliers where tenant_id = p_tenant and id = (p_input ->> 'supplierId')::uuid;
      if not found then raise exception using errcode = 'SU404', message = 'Supplier not found'; end if;
    end if;
    update public.supplier_reminders set
      supplier_id = case when p_input ? 'supplierId' then (p_input ->> 'supplierId')::uuid else supplier_id end,
      due_date = case when p_input ? 'dueDate' then (p_input ->> 'dueDate')::date else due_date end,
      amount_minor = case when p_input ? 'amountMinor' then (p_input ->> 'amountMinor')::bigint else amount_minor end,
      note = case when p_input ? 'note' then p_input ->> 'note' else note end,
      lead_days = case when p_input ? 'leadDays' then (p_input ->> 'leadDays')::integer else lead_days end,
      notify = case when p_input ? 'notify' then (p_input ->> 'notify')::boolean else notify end,
      status = case when p_input ? 'status' then p_input ->> 'status' else status end,
      updated_at = clock_timestamp()
    where tenant_id = p_tenant and id = p_reminder returning * into v_row;
    v_response := suppliers_private.reminder_json(v_row);
  end if;
  insert into public.supplier_money_commands(tenant_id, command_kind, normalized_key, payload_fingerprint, response)
  values (p_tenant, v_kind, v_key, v_fingerprint, v_response);
  return v_response;
end
$f$;

create function suppliers_private.list_supplier_reminders(
  p_tenant uuid, p_supplier uuid, p_status text, p_due_only boolean
) returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_today date;
begin
  if p_status is not null and p_status not in ('pending', 'done') then
    raise exception using errcode = 'SP422', message = 'Invalid reminder status';
  end if;
  select (now() at time zone default_timezone)::date into v_today
    from public.tenants where id = p_tenant;
  return (select coalesce(jsonb_agg(suppliers_private.reminder_json(r)
    order by r.status asc, r.due_date asc, r.id), '[]'::jsonb)
    from public.supplier_reminders r where r.tenant_id = p_tenant
      and (p_supplier is null or r.supplier_id = p_supplier)
      and (p_status is null or r.status = p_status)
      and (not coalesce(p_due_only, false) or
        (r.status = 'pending' and v_today >= r.due_date - r.lead_days)));
end
$f$;

-- Supplier purchases freeze the tenant currency as the one AP currency for this model. Operational
-- settings may change it only before any purchase exists, matching the existing commercial-history
-- currency lock while avoiding mixed-currency dues.
create function suppliers_private.prevent_supplier_currency_change()
returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  if new.default_currency is distinct from old.default_currency and exists (
    select 1 from public.supplier_purchases where tenant_id = old.id
  ) then
    raise exception using errcode = 'SC409', message = 'default_currency is locked once supplier purchases exist';
  end if;
  return new;
end
$f$;
create trigger tenants_supplier_currency_lock
before update of default_currency on public.tenants
for each row execute function suppliers_private.prevent_supplier_currency_change();

grant select on public.tenants, public.memberships, public.inventory_locations,
  public.inventory_operations, public.product_variants, public.products to suppliers_writer;
grant execute on function inventory_private.record_operation(
  uuid, text, jsonb, uuid, text, timestamptz, text, uuid, text
) to suppliers_writer;

grant create on schema suppliers_private to suppliers_writer;
alter function suppliers_private.money_command_replay(uuid, text, text, text) owner to suppliers_writer;
alter function suppliers_private.record_supplier_purchase(uuid, uuid, text, jsonb) owner to suppliers_writer;
alter function suppliers_private.list_supplier_purchases(uuid, uuid, uuid, integer) owner to suppliers_writer;
alter function suppliers_private.supplier_purchase_items(uuid, uuid) owner to suppliers_writer;
alter function suppliers_private.record_supplier_payment(uuid, uuid, uuid, text, jsonb) owner to suppliers_writer;
alter function suppliers_private.list_supplier_payments(uuid, uuid, uuid, integer) owner to suppliers_writer;
alter function suppliers_private.supplier_dues(uuid) owner to suppliers_writer;
alter function suppliers_private.reminder_json(public.supplier_reminders) owner to suppliers_writer;
alter function suppliers_private.write_supplier_reminder(uuid, uuid, uuid, text, jsonb, boolean) owner to suppliers_writer;
alter function suppliers_private.list_supplier_reminders(uuid, uuid, text, boolean) owner to suppliers_writer;
alter function suppliers_private.prevent_supplier_currency_change() owner to suppliers_writer;
revoke create on schema suppliers_private from suppliers_writer;
revoke all on function suppliers_private.money_command_replay(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function suppliers_private.reminder_json(public.supplier_reminders) from public, anon, authenticated, service_role;
revoke all on function suppliers_private.prevent_supplier_currency_change() from public, anon, authenticated, service_role;
revoke all on function suppliers_private.record_supplier_purchase(uuid, uuid, text, jsonb),
  suppliers_private.list_supplier_purchases(uuid, uuid, uuid, integer),
  suppliers_private.supplier_purchase_items(uuid, uuid),
  suppliers_private.record_supplier_payment(uuid, uuid, uuid, text, jsonb),
  suppliers_private.list_supplier_payments(uuid, uuid, uuid, integer),
  suppliers_private.supplier_dues(uuid),
  suppliers_private.write_supplier_reminder(uuid, uuid, uuid, text, jsonb, boolean),
  suppliers_private.list_supplier_reminders(uuid, uuid, text, boolean)
from public, anon, authenticated;
grant execute on function suppliers_private.record_supplier_purchase(uuid, uuid, text, jsonb),
  suppliers_private.list_supplier_purchases(uuid, uuid, uuid, integer),
  suppliers_private.supplier_purchase_items(uuid, uuid),
  suppliers_private.record_supplier_payment(uuid, uuid, uuid, text, jsonb),
  suppliers_private.list_supplier_payments(uuid, uuid, uuid, integer),
  suppliers_private.supplier_dues(uuid),
  suppliers_private.write_supplier_reminder(uuid, uuid, uuid, text, jsonb, boolean),
  suppliers_private.list_supplier_reminders(uuid, uuid, text, boolean)
to service_role;
