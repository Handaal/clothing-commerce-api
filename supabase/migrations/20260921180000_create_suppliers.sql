-- Phase 2N: tenant-owned suppliers and optional canonical receipt attribution.
-- Additive migration; no procurement ledger or parallel receiving path.
do $b$ begin
  if not exists(select 1 from pg_roles where rolname='suppliers_writer') then
    create role suppliers_writer nologin noinherit nobypassrls;
  end if;
  execute format('grant suppliers_writer to %I with set true',current_user);
end $b$;
create schema suppliers_private;
revoke all on schema suppliers_private from public, anon, authenticated;
grant usage on schema public, suppliers_private to suppliers_writer;
insert into public.permissions(key,description) values
 ('suppliers.read','Read tenant-owned suppliers; receiving history also requires inventory.read scope.'),
 ('suppliers.manage','Create, edit, activate and deactivate tenant-owned suppliers.')
on conflict(key) do nothing;

create table public.suppliers (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete restrict,
 name text not null check(length(btrim(name)) between 1 and 200),
 code text check(code is null or length(btrim(code)) between 1 and 100),
 status text not null default 'active' check(status in ('active','inactive')),
 contact_person text check(contact_person is null or length(btrim(contact_person)) between 1 and 200),
 phone text check(phone is null or length(btrim(phone)) between 1 and 50),
 email text check(email is null or length(btrim(email)) between 1 and 254),
 address text check(address is null or length(btrim(address)) between 1 and 1000),
 notes text check(notes is null or length(btrim(notes)) between 1 and 2000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,id)
);
create unique index suppliers_tenant_code on public.suppliers(tenant_id,lower(btrim(code))) where code is not null;
create index suppliers_tenant_status_id on public.suppliers(tenant_id,status,id);
create table public.supplier_commands (
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 normalized_key text not null check(length(normalized_key) between 1 and 200),
 intent jsonb not null, response jsonb not null, created_at timestamptz not null default now(),
 primary key(tenant_id,normalized_key)
);
alter table public.suppliers enable row level security;
alter table public.supplier_commands enable row level security;
-- Follow management-domain deny-by-default: clients never query supplier contact data directly.
-- The service-role transport can SELECT; application proofs enforce explicit permissions.
revoke all on public.suppliers, public.supplier_commands from public, anon, authenticated, service_role;
grant select on public.suppliers to service_role;
grant select on public.suppliers to inventory_writer;
create policy inventory_writer_supplier_read on public.suppliers for select to inventory_writer using(true);
grant create on schema public to suppliers_writer;
alter table public.suppliers owner to suppliers_writer;
alter table public.supplier_commands owner to suppliers_writer;
revoke create on schema public from suppliers_writer;

create function suppliers_private.supplier_json(p public.suppliers) returns jsonb
language sql immutable set search_path='' as $f$
 select jsonb_build_object('id',p.id,'tenantId',p.tenant_id,'name',p.name,'code',p.code,'status',p.status,
 'contactPerson',p.contact_person,'phone',p.phone,'email',p.email,'address',p.address,'notes',p.notes,
 'createdAt',p.created_at,'updatedAt',p.updated_at)
$f$;

create function suppliers_private.write_supplier(p_tenant uuid,p_supplier uuid,p_actor uuid,p_key text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_key text:=lower(btrim(p_key)); v_intent jsonb; v_old public.supplier_commands; v_row public.suppliers; v_response jsonb;
begin
 if p_tenant is null or p_actor is null or p_key is null or length(v_key) not between 1 and 200
 or jsonb_typeof(p_input) is distinct from 'object' or p_input='{}'::jsonb
 or (p_input - array['name','code','status','contactPerson','phone','email','address','notes']) <> '{}'::jsonb
 then raise exception using errcode='22023',message='Invalid supplier command'; end if;
 v_intent:=jsonb_build_object('supplierId',p_supplier,'actor',p_actor,'input',p_input);
 perform pg_advisory_xact_lock(hashtextextended('supplier:'||p_tenant::text||':'||v_key,0));
 select * into v_old from public.supplier_commands where tenant_id=p_tenant and normalized_key=v_key;
 if found then
  if v_old.intent is distinct from v_intent then raise exception using errcode='ID409',message='Supplier intent conflict'; end if;
  return v_old.response;
 end if;
 if p_supplier is null then
  if not p_input ? 'name' or p_input ? 'status' then raise exception using errcode='22023',message='Invalid create'; end if;
  insert into public.suppliers(tenant_id,name,code,contact_person,phone,email,address,notes)
  values(p_tenant,p_input->>'name',p_input->>'code',p_input->>'contactPerson',p_input->>'phone',p_input->>'email',p_input->>'address',p_input->>'notes') returning * into v_row;
 else
  select * into v_row from public.suppliers where tenant_id=p_tenant and id=p_supplier for update;
  if not found then raise exception using errcode='SU404',message='Supplier not found'; end if;
  update public.suppliers set
   name=case when p_input ? 'name' then p_input->>'name' else name end,
   code=case when p_input ? 'code' then p_input->>'code' else code end,
   status=case when p_input ? 'status' then p_input->>'status' else status end,
   contact_person=case when p_input ? 'contactPerson' then p_input->>'contactPerson' else contact_person end,
   phone=case when p_input ? 'phone' then p_input->>'phone' else phone end,
   email=case when p_input ? 'email' then p_input->>'email' else email end,
   address=case when p_input ? 'address' then p_input->>'address' else address end,
   notes=case when p_input ? 'notes' then p_input->>'notes' else notes end, updated_at=clock_timestamp()
  where tenant_id=p_tenant and id=p_supplier returning * into v_row;
 end if;
 v_response:=suppliers_private.supplier_json(v_row);
 insert into public.supplier_commands(tenant_id,normalized_key,intent,response) values(p_tenant,v_key,v_intent,v_response);
 return v_response;
end $f$;

create function suppliers_private.list_suppliers(p_tenant uuid,p_search text,p_status text,p_after uuid,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $f$
begin
 if p_limit is null or p_limit not between 1 and 101 or (p_status is not null and p_status not in ('active','inactive'))
 or length(p_search)>200 then raise exception using errcode='22023',message='Invalid supplier query'; end if;
 return (select coalesce(jsonb_agg(suppliers_private.supplier_json(s) order by s.id),'[]'::jsonb) from
  (select * from public.suppliers where tenant_id=p_tenant and (p_status is null or status=p_status)
   and (p_after is null or id>p_after) and (p_search is null or
    position(lower(p_search) in lower(name))>0 or position(lower(p_search) in lower(code))>0)
   order by id limit p_limit) s);
end $f$;

alter table public.inventory_operations
 add column supplier_id uuid,
 add column supplier_reference text,
 add column supplier_name_snapshot text,
 add column supplier_code_snapshot text,
 add constraint inventory_operations_supplier_tenant_fk foreign key(tenant_id,supplier_id) references public.suppliers(tenant_id,id) on delete restrict,
 add constraint inventory_operations_supplier_receipt_only check(
  (supplier_id is null and supplier_reference is null and supplier_name_snapshot is null and supplier_code_snapshot is null) or operation_type='receipt'),
 add constraint inventory_operations_supplier_snapshot check((supplier_id is null)=(supplier_name_snapshot is null)),
 add constraint inventory_operations_supplier_reference_bound check(supplier_reference is null or length(btrim(supplier_reference)) between 1 and 200);
create index inventory_operations_supplier_history on public.inventory_operations(tenant_id,supplier_id,id) where supplier_id is not null;
create function inventory_private.record_operation(
  p_tenant_id uuid,
  p_operation_type text,
  p_movements jsonb,
  p_actor_membership_id uuid,
  p_idempotency_key text,
  p_occurred_at timestamptz,
  p_notes text,
  p_supplier_id uuid,
  p_supplier_reference text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation_id uuid;
  v_supplier public.suppliers;
  v_normalized_key text := lower(btrim(p_idempotency_key));
  v_fingerprint text;
  v_canonical text;
  v_existing_fingerprint text;
  v_element jsonb;
  v_variant_id uuid;
  v_location_id uuid;
  v_delta bigint;
  v_current_quantity bigint;
  v_new_quantity bigint;
  v_line_number integer;
begin
  if p_tenant_id is null then
    raise exception using errcode = '22004', message = 'tenant_id is required';
  end if;

  if pg_catalog.jsonb_typeof(p_movements) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_movements) = 0 then
    raise exception using errcode = '22023', message = 'at least one movement is required';
  end if;

  if p_idempotency_key is not null and v_normalized_key = '' then
    raise exception using errcode = '22023', message = 'idempotency_key must not be blank';
  end if;

  -- Pass 1: validate every movement and build a canonical, representation-independent fingerprint.
  -- Movement order is semantically significant (line order + intermediate-negative rule), so the
  -- canonical form preserves input order. occurred_at, recorded_at, and notes are excluded from the
  -- fingerprint: they are not reliably caller-stable identity inputs.
  v_canonical := p_tenant_id::text || E'\n'
    || p_operation_type || E'\n'
    || coalesce(p_actor_membership_id::text, '');

  for v_element in
    select ordered.value
    from pg_catalog.jsonb_array_elements(p_movements) with ordinality as ordered(value, ord)
    order by ordered.ord
  loop
    if pg_catalog.jsonb_typeof(v_element) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'each movement must be a JSON object';
    end if;

    if (v_element ->> 'variant_id') is null or (v_element ->> 'inventory_location_id') is null then
      raise exception using
        errcode = '22023',
        message = 'variant_id and inventory_location_id are required for each movement';
    end if;

    if (v_element ->> 'quantity_delta') is null then
      raise exception using errcode = '22023', message = 'quantity_delta is required for each movement';
    end if;

    v_variant_id := (v_element ->> 'variant_id')::uuid;
    v_location_id := (v_element ->> 'inventory_location_id')::uuid;
    v_delta := (v_element ->> 'quantity_delta')::bigint;

    if v_delta = 0 then
      raise exception using errcode = '22023', message = 'quantity_delta must be non-zero';
    end if;

    v_canonical := v_canonical || E'\n'
      || v_variant_id::text || ',' || v_location_id::text || ',' || v_delta::text;
  end loop;

  if p_supplier_id is not null or p_supplier_reference is not null then
    if p_operation_type <> 'receipt' or (p_supplier_reference is not null and length(btrim(p_supplier_reference)) not between 1 and 200) then
      raise exception using errcode='22023',message='Invalid supplier receipt metadata';
    end if;
    -- Absent metadata preserves all pre-2N fingerprints byte-for-byte.
    v_canonical := v_canonical || E'\n' || pg_catalog.jsonb_build_object(
      'supplierId',p_supplier_id,'supplierReference',p_supplier_reference)::text;
  end if;
  v_fingerprint := pg_catalog.md5(v_canonical);
  if p_idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('receipt:'||p_tenant_id::text||':'||v_normalized_key,0));
  end if;

  -- Idempotency fast path: a recorded (tenant, key) with the SAME fingerprint replays to the same
  -- operation and applies nothing; a DIFFERENT fingerprint is a deterministic reuse error.
  if p_idempotency_key is not null then
    select operation.id, operation.payload_fingerprint
    into v_operation_id, v_existing_fingerprint
    from public.inventory_operations as operation
    where operation.tenant_id = p_tenant_id
      and operation.normalized_idempotency_key = v_normalized_key;

    if v_operation_id is not null then
      if v_existing_fingerprint is distinct from v_fingerprint then
        raise exception using
          errcode = 'ID409',
          message = 'idempotency key reused with a different payload';
      end if;
      return v_operation_id;
    end if;
  end if;

  -- Replay/conflict is resolved BEFORE lifecycle checks. A deactivated or renamed supplier
  -- cannot invalidate an accepted receipt replay. The row lock serializes deactivation/rename
  -- against new receipt validation and its immutable display snapshot.
  if p_supplier_id is not null then
    v_supplier := suppliers_private.lock_receipt_supplier(p_tenant_id,p_supplier_id);
  end if;

  -- Race path: two concurrent first submissions of the same key. The loser resolves to the winner's
  -- operation when the fingerprint matches, or receives the same deterministic reuse error.
  begin
    insert into public.inventory_operations (
      tenant_id, operation_type, actor_membership_id, idempotency_key, payload_fingerprint,
      occurred_at, recorded_at, notes, supplier_id, supplier_reference, supplier_name_snapshot, supplier_code_snapshot
    )
    values (
      p_tenant_id,
      p_operation_type,
      p_actor_membership_id,
      p_idempotency_key,
      v_fingerprint,
      coalesce(p_occurred_at, pg_catalog.now()),
      pg_catalog.now(),
      p_notes, p_supplier_id, p_supplier_reference, v_supplier.name, v_supplier.code
    )
    returning id into v_operation_id;
  exception
    when unique_violation then
      if p_idempotency_key is null then
        raise;
      end if;
      select operation.id, operation.payload_fingerprint
      into v_operation_id, v_existing_fingerprint
      from public.inventory_operations as operation
      where operation.tenant_id = p_tenant_id
        and operation.normalized_idempotency_key = v_normalized_key;
      if v_existing_fingerprint is distinct from v_fingerprint then
        raise exception using
          errcode = 'ID409',
          message = 'idempotency key reused with a different payload';
      end if;
      return v_operation_id;
  end;

  -- Permit projection writes only for the remainder of this atomic call.
  perform pg_catalog.set_config('inventory_private.allow_balance_write', 'on', true);

  -- Pass 2: lock (or race-safely create) EVERY distinct balance key in a single canonical order,
  -- variant_id then inventory_location_id, before applying any delta. Every concurrent operation
  -- touching the same keys acquires them in this identical order, so no lock cycle can form.
  for v_variant_id, v_location_id in
    select distinct
      (ordered.value ->> 'variant_id')::uuid,
      (ordered.value ->> 'inventory_location_id')::uuid
    from pg_catalog.jsonb_array_elements(p_movements) as ordered(value)
    order by 1, 2
  loop
    loop
      perform 1
      from public.inventory_balances
      where tenant_id = p_tenant_id
        and variant_id = v_variant_id
        and inventory_location_id = v_location_id
      for update;

      exit when found;

      begin
        insert into public.inventory_balances (
          tenant_id, variant_id, inventory_location_id, on_hand_quantity, version
        )
        values (p_tenant_id, v_variant_id, v_location_id, 0, 0);
        exit;
      exception
        when unique_violation then
          null; -- another session created the row first; retry the locking select
      end;
    end loop;
  end loop;

  -- Pass 3: apply each movement line in input order. All required rows are already locked, so this
  -- is race-free. On-hand may never be negative at any intermediate line; the nonnegative CHECK
  -- constraint is the backstop behind the explicit test.
  v_line_number := 0;
  for v_element in
    select ordered.value
    from pg_catalog.jsonb_array_elements(p_movements) with ordinality as ordered(value, ord)
    order by ordered.ord
  loop
    v_line_number := v_line_number + 1;
    v_variant_id := (v_element ->> 'variant_id')::uuid;
    v_location_id := (v_element ->> 'inventory_location_id')::uuid;
    v_delta := (v_element ->> 'quantity_delta')::bigint;

    select balance.on_hand_quantity
    into v_current_quantity
    from public.inventory_balances as balance
    where balance.tenant_id = p_tenant_id
      and balance.variant_id = v_variant_id
      and balance.inventory_location_id = v_location_id;

    v_new_quantity := v_current_quantity + v_delta;

    if v_new_quantity < 0 then
      raise exception using
        errcode = '23514',
        message = pg_catalog.format(
          'insufficient stock for variant %s at location %s: on hand %s, requested delta %s',
          v_variant_id,
          v_location_id,
          v_current_quantity,
          v_delta
        );
    end if;

    update public.inventory_balances
      set on_hand_quantity = v_new_quantity,
          version = version + 1,
          updated_at = pg_catalog.now()
      where tenant_id = p_tenant_id
        and variant_id = v_variant_id
        and inventory_location_id = v_location_id;

    insert into public.inventory_movements (
      tenant_id, operation_id, variant_id, inventory_location_id, quantity_delta, line_number
    )
    values (
      p_tenant_id, v_operation_id, v_variant_id, v_location_id, v_delta, v_line_number
    );
  end loop;

  perform pg_catalog.set_config('inventory_private.allow_balance_write', 'off', true);

  return v_operation_id;
end;
$function$;
-- Preserve the original SQL and PostgREST callers, including receipts without metadata.
create or replace function inventory_private.record_operation(
 p_tenant_id uuid,p_operation_type text,p_movements jsonb,p_actor_membership_id uuid default null,
 p_idempotency_key text default null,p_occurred_at timestamptz default null,p_notes text default null)
returns uuid language sql security definer set search_path='' as $f$
 select inventory_private.record_operation(p_tenant_id,p_operation_type,p_movements,p_actor_membership_id,
 p_idempotency_key,p_occurred_at,p_notes,null::uuid,null::text)
$f$;
grant create on schema inventory_private to inventory_writer;
alter function inventory_private.record_operation(uuid,text,jsonb,uuid,text,timestamptz,text,uuid,text) owner to inventory_writer;
revoke create on schema inventory_private from inventory_writer;
revoke all on function inventory_private.record_operation(uuid,text,jsonb,uuid,text,timestamptz,text,uuid,text) from public,anon,authenticated;
grant execute on function inventory_private.record_operation(uuid,text,jsonb,uuid,text,timestamptz,text,uuid,text) to service_role;

-- Read projection of canonical operations/movements. All lines must be within inventory.read
-- visibility: a future multi-location operation cannot leak hidden lines via supplier history.
create function suppliers_private.supplier_receipts(p_tenant uuid,p_supplier uuid,p_locations uuid[],p_after uuid,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $f$
begin
 if p_limit is null or p_limit not between 1 and 101 then raise exception using errcode='22023',message='Invalid page'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object(
  'operationId',o.id,'receivedAt',o.occurred_at,'supplierId',o.supplier_id,
  'supplierName',o.supplier_name_snapshot,'supplierCode',o.supplier_code_snapshot,'supplierReference',o.supplier_reference,
  'actorMembershipId',o.actor_membership_id,
  'lines',(select jsonb_agg(jsonb_build_object('variantId',m.variant_id,'sku',v.sku,'productName',p.name,
    'quantity',m.quantity_delta,'inventoryLocationId',m.inventory_location_id,'inventoryLocationName',l.display_name,'branchId',l.branch_id) order by m.line_number)
    from public.inventory_movements m
    join public.product_variants v on v.tenant_id=m.tenant_id and v.id=m.variant_id
    join public.products p on p.tenant_id=v.tenant_id and p.id=v.product_id
    join public.inventory_locations l on l.tenant_id=m.tenant_id and l.id=m.inventory_location_id
    where m.tenant_id=p_tenant and m.operation_id=o.id)
 ) order by o.id),'[]'::jsonb) from (
  select * from public.inventory_operations o where o.tenant_id=p_tenant and o.supplier_id=p_supplier and o.operation_type='receipt'
  and (p_after is null or o.id>p_after)
  and (p_locations is null or not exists(select 1 from public.inventory_movements m where m.tenant_id=p_tenant and m.operation_id=o.id and not (m.inventory_location_id=any(p_locations))))
  order by o.id limit p_limit
 ) o);
end $f$;
grant select on public.inventory_operations,public.inventory_movements,public.product_variants,public.products,public.inventory_locations to suppliers_writer;
create policy suppliers_writer_history_read on public.inventory_operations for select to suppliers_writer using(true);
create policy suppliers_writer_history_read on public.inventory_movements for select to suppliers_writer using(true);
create policy suppliers_writer_history_read on public.product_variants for select to suppliers_writer using(true);
create policy suppliers_writer_history_read on public.products for select to suppliers_writer using(true);
create policy suppliers_writer_history_read on public.inventory_locations for select to suppliers_writer using(true);
grant create on schema suppliers_private to suppliers_writer;
alter function suppliers_private.supplier_json(public.suppliers) owner to suppliers_writer;
alter function suppliers_private.write_supplier(uuid,uuid,uuid,text,jsonb) owner to suppliers_writer;
alter function suppliers_private.list_suppliers(uuid,text,text,uuid,integer) owner to suppliers_writer;
alter function suppliers_private.supplier_receipts(uuid,uuid,uuid[],uuid,integer) owner to suppliers_writer;
revoke create on schema suppliers_private from suppliers_writer;
revoke all on all functions in schema suppliers_private from public,anon,authenticated,service_role;
grant usage on schema suppliers_private to service_role;
grant execute on function suppliers_private.write_supplier(uuid,uuid,uuid,text,jsonb),
 suppliers_private.list_suppliers(uuid,text,text,uuid,integer),
 suppliers_private.supplier_receipts(uuid,uuid,uuid[],uuid,integer) to service_role;

-- Supplier ownership supplies the locking privilege, without granting inventory_writer any
-- supplier UPDATE policy. Only the canonical inventory definer can invoke this helper.
create function suppliers_private.lock_receipt_supplier(p_tenant uuid,p_supplier uuid)
returns public.suppliers language plpgsql security definer set search_path='' as $f$
declare s public.suppliers;
begin
 select * into s from public.suppliers where tenant_id=p_tenant and id=p_supplier for share;
 if not found then raise exception using errcode='SU404',message='Supplier not found'; end if;
 if s.status <> 'active' then raise exception using errcode='SU409',message='Supplier inactive'; end if;
 return s;
end $f$;
grant create on schema suppliers_private to suppliers_writer;
alter function suppliers_private.lock_receipt_supplier(uuid,uuid) owner to suppliers_writer;
revoke create on schema suppliers_private from suppliers_writer;
revoke all on function suppliers_private.lock_receipt_supplier(uuid,uuid) from public,anon,authenticated,service_role;
grant usage on schema suppliers_private to inventory_writer;
grant execute on function suppliers_private.lock_receipt_supplier(uuid,uuid) to inventory_writer;
