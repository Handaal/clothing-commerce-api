-- Phase 2B: inventory foundation.
-- Authoritative history is an append-only operation/movement ledger; inventory_balances is a
-- transactionally maintained current-state projection keyed by (tenant, variant, location).
-- The real enforcement boundary is a privilege one: only the SECURITY DEFINER
-- inventory_private.record_operation can create ledger or balance rows. service_role holds no direct
-- inventory table DML; it may only SELECT and EXECUTE the hardened function. The function runs as the
-- dedicated, non-login inventory_writer role that owns the inventory tables.

-- Dedicated, non-login mutation role. It owns the inventory tables (so, because RLS is never forced,
-- it bypasses RLS on exactly those tables and nothing else) and owns record_operation. It has no
-- LOGIN, no BYPASSRLS, and no membership granted to any client or application role, so the only way
-- to write inventory is through the hardened function. It is not a generic application role.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'inventory_writer') then
    create role inventory_writer nologin noinherit nobypassrls;
  end if;

  -- Transferring table/function ownership to inventory_writer (below) requires the migration role to
  -- be able to SET ROLE to it. PostgreSQL 16+ grants the creating role ADMIN but not SET by default,
  -- and Supabase applies migrations as a non-superuser role; without this a fresh `supabase start`
  -- fails with "must be able to SET ROLE inventory_writer". The creator holds ADMIN and can grant
  -- itself the SET option; this is idempotent and is never granted to any client or the service role,
  -- so the privilege boundary (service_role cannot become inventory_writer) is preserved. A superuser
  -- migrator (the disposable direct-Postgres test runners) can already SET ROLE, so this is a no-op
  -- there.
  execute pg_catalog.format('grant inventory_writer to %I with set true', current_user);
end;
$block$;

comment on role inventory_writer is
  'Owns the inventory tables and the SECURITY DEFINER record_operation; the sole path able to write inventory. Never a login or client role.';

-- The writer role must be able to reference the public schema to reach the tables it owns. It gets
-- no CREATE and no privileges on any other object; table access is via ownership of exactly the
-- three inventory tables.
grant usage on schema public to inventory_writer;

create schema if not exists inventory_private;
revoke all on schema inventory_private from public;

comment on schema inventory_private is
  'Private inventory integrity functions and the sole balance-mutation path; never a client API surface.';

-- Logical audit/idempotency envelope for one stock mutation (one operation may span many movements,
-- e.g. a future transfer with a -N and +N pair, or a sale deducting several variants at once).
create table public.inventory_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  operation_type text not null,
  actor_membership_id uuid,
  idempotency_key text,
  normalized_idempotency_key text generated always as (lower(btrim(idempotency_key))) stored,
  payload_fingerprint text,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  constraint inventory_operations_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint inventory_operations_actor_tenant_fk
    foreign key (tenant_id, actor_membership_id)
    references public.memberships (tenant_id, id)
    on delete restrict,
  constraint inventory_operations_type_valid check (
    operation_type in (
      'opening', 'adjustment', 'correction', 'receipt', 'sale', 'return', 'transfer'
    )
  ),
  constraint inventory_operations_idempotency_key_not_blank check (
    idempotency_key is null or normalized_idempotency_key <> ''
  ),
  constraint inventory_operations_keyed_has_fingerprint check (
    idempotency_key is null or payload_fingerprint is not null
  ),
  constraint inventory_operations_notes_not_empty check (notes is null or btrim(notes) <> ''),
  constraint inventory_operations_tenant_id_unique unique (tenant_id, id)
);

comment on table public.inventory_operations is
  'Append-only logical envelope for a stock mutation. actor_membership_id null means system origin.';
comment on column public.inventory_operations.operation_type is
  'Reserved audit classification only. Phase 2B producers use opening/adjustment/correction; receipt/sale/return/transfer are reserved labels with no enforced sale/receiving/transfer/return workflow yet.';
comment on column public.inventory_operations.payload_fingerprint is
  'Deterministic md5 of the canonical logical payload (tenant, operation_type, actor, ordered movement lines). Used to reject reuse of an idempotency key with a different payload.';
comment on column public.inventory_operations.occurred_at is
  'Business event time (authoritative business timestamp for the whole operation and its movements).';
comment on column public.inventory_operations.recorded_at is
  'System record time. Offline backdating policy is deferred; online operations record at now().';

-- One tenant may reuse an idempotency key only once; cross-tenant reuse of the same key is allowed.
create unique index inventory_operations_tenant_idempotency_key_unique_idx
  on public.inventory_operations (tenant_id, normalized_idempotency_key)
  where normalized_idempotency_key is not null;

create index inventory_operations_tenant_type_time_idx
  on public.inventory_operations (tenant_id, operation_type, occurred_at);

create index inventory_operations_actor_idx
  on public.inventory_operations (tenant_id, actor_membership_id)
  where actor_membership_id is not null;

-- Append-only physical quantity delta. Positive enters the location; negative leaves it.
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  operation_id uuid not null,
  variant_id uuid not null,
  inventory_location_id uuid not null,
  quantity_delta bigint not null,
  line_number integer not null,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint inventory_movements_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint inventory_movements_operation_tenant_fk
    foreign key (tenant_id, operation_id)
    references public.inventory_operations (tenant_id, id)
    on delete restrict,
  constraint inventory_movements_variant_tenant_fk
    foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id)
    on delete restrict,
  constraint inventory_movements_location_tenant_fk
    foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations (tenant_id, id)
    on delete restrict,
  constraint inventory_movements_quantity_delta_nonzero check (quantity_delta <> 0),
  constraint inventory_movements_line_number_positive check (line_number >= 1),
  constraint inventory_movements_tenant_id_unique unique (tenant_id, id),
  constraint inventory_movements_operation_line_unique unique (tenant_id, operation_id, line_number)
);

comment on table public.inventory_movements is
  'Append-only signed physical stock deltas; the authoritative source of truth reconciling to inventory_balances.';
comment on column public.inventory_movements.line_number is
  'Deterministic 1-based ordering of movements within one operation; UUIDs are not chronological.';

create index inventory_movements_variant_history_idx
  on public.inventory_movements (tenant_id, variant_id, inventory_location_id, recorded_at);

create index inventory_movements_location_idx
  on public.inventory_movements (tenant_id, inventory_location_id, recorded_at);

create index inventory_movements_operation_idx
  on public.inventory_movements (tenant_id, operation_id);

-- Current-state projection. Exactly one row per physical stock key.
create table public.inventory_balances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  variant_id uuid not null,
  inventory_location_id uuid not null,
  on_hand_quantity bigint not null default 0,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_balances_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint inventory_balances_variant_tenant_fk
    foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id)
    on delete restrict,
  constraint inventory_balances_location_tenant_fk
    foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations (tenant_id, id)
    on delete restrict,
  constraint inventory_balances_on_hand_nonnegative check (on_hand_quantity >= 0),
  constraint inventory_balances_version_nonnegative check (version >= 0),
  constraint inventory_balances_updated_after_created check (updated_at >= created_at),
  constraint inventory_balances_variant_location_unique
    unique (tenant_id, variant_id, inventory_location_id)
);

comment on table public.inventory_balances is
  'Maintained on-hand projection keyed by (tenant, variant, location). Not a source of truth; changes only via inventory_private.record_operation.';
comment on column public.inventory_balances.on_hand_quantity is
  'Physical pieces on hand, never negative. available_to_sell = on_hand - active reservations is deferred to the future reservation domain.';
comment on column public.inventory_balances.version is
  'Monotonic write counter for change detection and diagnostics; row locking, not this column, provides concurrency safety.';

create index inventory_balances_variant_idx
  on public.inventory_balances (tenant_id, variant_id);

create index inventory_balances_location_idx
  on public.inventory_balances (tenant_id, inventory_location_id);

-- Structurally forbid casual UPDATE/DELETE of committed ledger rows. Corrections are new
-- compensating movements, never edits to history. A superuser can still disable triggers for
-- governed maintenance; that is trusted infrastructure, documented in inventory-persistence.md.
create function inventory_private.forbid_ledger_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '42501',
    message = pg_catalog.format(
      '%I.%I is append-only; record a compensating movement instead of updating or deleting history',
      tg_table_schema,
      tg_table_name
    );
end;
$function$;

create trigger inventory_operations_append_only
before update or delete on public.inventory_operations
for each row execute function inventory_private.forbid_ledger_mutation();

create trigger inventory_movements_append_only
before update or delete on public.inventory_movements
for each row execute function inventory_private.forbid_ledger_mutation();

-- Internal defense-in-depth only. The real projection boundary is the privilege model (service_role
-- has no balance DML; only inventory_writer, through record_operation, can write). This trigger
-- additionally catches an accidental balance write by the writer role outside the function, and
-- always rejects DELETE. It is NOT an unforgeable capability: any role that could already write the
-- table could also set the flag, so it is not the security boundary.
create function inventory_private.guard_balance_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '42501',
      message = 'inventory_balances rows cannot be deleted; the projection is reconciled from the ledger';
  end if;

  if pg_catalog.current_setting('inventory_private.allow_balance_write', true) is distinct from 'on' then
    raise exception using
      errcode = '42501',
      message = 'inventory_balances may only be modified through inventory_private.record_operation';
  end if;

  return new;
end;
$function$;

create trigger inventory_balances_guard
before insert or update or delete on public.inventory_balances
for each row execute function inventory_private.guard_balance_write();

-- Sole atomic mutation API. SECURITY DEFINER, owned by inventory_writer, so it can write the
-- inventory tables while service_role (its only caller) holds no direct table DML. It:
--   1. validates and canonicalizes the whole payload (deterministic md5 fingerprint) up front;
--   2. honours tenant-scoped idempotency, rejecting a reused key that carries a different payload;
--   3. locks (or race-safely creates) every distinct balance key in a CANONICAL order
--      (variant_id, inventory_location_id) before applying any delta, so opposing multi-key
--      operations serialize instead of deadlocking;
--   4. applies each movement line in input order; on-hand may never go negative at any intermediate
--      line; appends one immutable movement per input line.
-- The ledger insert and projection update always commit together or not at all.
create function inventory_private.record_operation(
  p_tenant_id uuid,
  p_operation_type text,
  p_movements jsonb,
  p_actor_membership_id uuid default null,
  p_idempotency_key text default null,
  p_occurred_at timestamptz default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation_id uuid;
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

  v_fingerprint := pg_catalog.md5(v_canonical);

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

  -- Race path: two concurrent first submissions of the same key. The loser resolves to the winner's
  -- operation when the fingerprint matches, or receives the same deterministic reuse error.
  begin
    insert into public.inventory_operations (
      tenant_id, operation_type, actor_membership_id, idempotency_key, payload_fingerprint,
      occurred_at, recorded_at, notes
    )
    values (
      p_tenant_id,
      p_operation_type,
      p_actor_membership_id,
      p_idempotency_key,
      v_fingerprint,
      coalesce(p_occurred_at, pg_catalog.now()),
      pg_catalog.now(),
      p_notes
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

comment on function inventory_private.record_operation(uuid, text, jsonb, uuid, text, timestamptz, text) is
  'Sole atomic inventory mutation path (SECURITY DEFINER, owned by inventory_writer). Appends operation + movements and maintains balances in one transaction, with canonical multi-key lock ordering, nonnegative enforcement, and fingerprinted tenant-scoped idempotency.';

-- Transfer ownership so the definer function writes as a role that is not any client/application
-- role, and so that role bypasses (never-forced) RLS on exactly these three tables.
-- ALTER ... OWNER TO a role additionally requires the new owner to hold CREATE on the object's
-- schema. Grant it only for the duration of the transfer and revoke immediately after, so
-- inventory_writer keeps just USAGE on public (needed by the definer function at runtime) and no
-- standing CREATE anywhere. A superuser migrator would not need this, but Supabase applies migrations
-- as a non-superuser role.
grant create on schema public, inventory_private to inventory_writer;
alter table public.inventory_operations owner to inventory_writer;
alter table public.inventory_movements owner to inventory_writer;
alter table public.inventory_balances owner to inventory_writer;
alter function inventory_private.record_operation(uuid, text, jsonb, uuid, text, timestamptz, text)
  owner to inventory_writer;
revoke create on schema public, inventory_private from inventory_writer;

-- Deny PUBLIC (and therefore anon/authenticated) execute on every private function. Grants to the
-- server role are established in the RLS/grants migration.
revoke all on function inventory_private.forbid_ledger_mutation() from public;
revoke all on function inventory_private.guard_balance_write() from public;
revoke all on function inventory_private.record_operation(uuid, text, jsonb, uuid, text, timestamptz, text) from public;
