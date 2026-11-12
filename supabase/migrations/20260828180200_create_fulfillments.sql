-- Phase 2E (3/7): canonical Fulfillment persistence, the dedicated fulfillments_writer role, and the
-- two SHARED transaction-scoped advisory-lock helpers.
--
-- A Fulfillment is the immutable physical execution of some or all OrderLine quantities from EXACTLY
-- ONE InventoryLocation. It is NOT an Order, Payment, Reservation, Allocation, Shipping, or Return.
-- There is deliberately NO status column: a fulfillments row existing means the physical execution
-- already occurred (the inventory issue committed in the same transaction). There is no draft, pending,
-- cancellation, or mutation. Each Fulfillment references exactly one Order, exactly one
-- InventoryLocation, one or more FulfillmentLines, and exactly one InventoryOperation.
--
-- The enforcement boundary mirrors Phase 2B/2C/2D exactly: a dedicated, non-login fulfillments_writer
-- role owns the two tables and (migration 5) the SECURITY DEFINER functions, so it bypasses (never
-- forced) RLS on exactly these tables. service_role holds no direct table DML; it may only SELECT and
-- EXECUTE the sanctioned functions (migration 6). Append-only triggers are internal defense-in-depth,
-- never the security boundary.

-- Dedicated, non-login mutation role. It owns fulfillments/fulfillment_lines and the fulfillment
-- functions, so (RLS is never forced) it bypasses RLS on exactly those tables and nothing else. It has
-- no LOGIN, no BYPASSRLS, and is granted to no client or application role. It is NOT an inventory or
-- orders writer: it can never issue stock directly or write an order.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'fulfillments_writer') then
    create role fulfillments_writer nologin noinherit nobypassrls;
  end if;

  -- Transferring ownership to fulfillments_writer (below) requires the migration role to be able to SET
  -- ROLE to it. PostgreSQL 16+ grants the creating role ADMIN but not SET by default, and Supabase
  -- applies migrations as a non-superuser role; without this a fresh `supabase db reset` fails with
  -- "must be able to SET ROLE fulfillments_writer". Idempotent, never granted to any client or the
  -- service role, so service_role can never become fulfillments_writer. Superuser test runners can
  -- already SET ROLE, so this is a no-op there.
  execute pg_catalog.format('grant fulfillments_writer to %I with set true', current_user);
end;
$block$;

comment on role fulfillments_writer is
  'Owns the fulfillment tables and the SECURITY DEFINER fulfillment functions; the sole path able to write fulfillments. Never a login or client role, never an inventory or orders writer.';

grant usage on schema public to fulfillments_writer;

create schema if not exists fulfillments_private;
revoke all on schema fulfillments_private from public;

comment on schema fulfillments_private is
  'Private fulfillment integrity/mutation functions and the idempotency-replay preflight; never a client API surface.';

-- record_fulfillment (migration 5) runs as fulfillments_writer and delegates to the qualified
-- fulfillments_private.fulfillment_intent_fingerprint, so the writer role needs USAGE here to resolve
-- that call. It already owns the functions (hence may execute them); this grant only lets it reference
-- the schema.
grant usage on schema fulfillments_private to fulfillments_writer;

-- ---------------------------------------------------------------------------------------------------
-- Shared transaction-scoped advisory-lock helpers.
--
-- These live in a neutral, non-client schema so the SINGLE canonical key construction is shared across
-- domains and cannot drift. Two distinct lock classes (distinct seeds) exist:
--
--   1. order_execution   -- serializes cancel_order (orders_writer) and record_fulfillment
--                           (fulfillments_writer) for one (tenant, order). Makes the forbidden state
--                           "Order cancelled AND a concurrent Fulfillment exists" impossible.
--   2. inventory_location_lifecycle -- serializes a Fulfillment's Location capability read against any
--                           FUTURE sanctioned Location lifecycle mutation for one (tenant, location).
--
-- Advisory xact locks are released at transaction end and are NOT rolled back by savepoints, which is
-- exactly what the fulfillment savepoint path relies on.
create schema if not exists commerce_locks;
revoke all on schema commerce_locks from public;

comment on schema commerce_locks is
  'Neutral holder for the canonical cross-domain transaction-scoped advisory-lock key construction; never a client API surface.';

create function commerce_locks.acquire_order_execution_lock(p_tenant_id uuid, p_order_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $function$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('order_execution:' || p_tenant_id::text || ':' || p_order_id::text, 0)
  );
$function$;

comment on function commerce_locks.acquire_order_execution_lock(uuid, uuid) is
  'Canonical order-execution transaction advisory lock (seed 0). The SINGLE definition shared by cancel_order and record_fulfillment so the key can never drift between domains.';

create function commerce_locks.acquire_inventory_location_lifecycle_lock(
  p_tenant_id uuid,
  p_inventory_location_id uuid
)
returns void
language sql
security invoker
set search_path = ''
as $function$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'inventory_location_lifecycle:' || p_tenant_id::text || ':' || p_inventory_location_id::text,
      1
    )
  );
$function$;

comment on function commerce_locks.acquire_inventory_location_lifecycle_lock(uuid, uuid) is
  'Canonical inventory-location-lifecycle transaction advisory lock (seed 1, a distinct lock class). Acquired by record_fulfillment_issue before reading Location status/capability; any future sanctioned Location lifecycle mutation MUST acquire this same lock before changing lifecycle/capability state.';

-- The order-execution lock is used by both writer roles; the location-lifecycle lock only by the
-- inventory writer (inside record_fulfillment_issue). PUBLIC is denied.
revoke all on function commerce_locks.acquire_order_execution_lock(uuid, uuid) from public;
revoke all on function commerce_locks.acquire_inventory_location_lifecycle_lock(uuid, uuid) from public;
grant usage on schema commerce_locks to orders_writer, fulfillments_writer, inventory_writer;
grant execute on function commerce_locks.acquire_order_execution_lock(uuid, uuid)
  to orders_writer, fulfillments_writer;
grant execute on function commerce_locks.acquire_inventory_location_lifecycle_lock(uuid, uuid)
  to inventory_writer;

-- ---------------------------------------------------------------------------------------------------
-- The canonical Fulfillment aggregate root. No status column by design.
create table public.fulfillments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  inventory_location_id uuid not null,
  inventory_operation_id uuid not null,
  actor_membership_id uuid,
  idempotency_key text not null,
  normalized_idempotency_key text generated always as (lower(btrim(idempotency_key))) stored,
  payload_fingerprint text not null,
  fulfilled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint fulfillments_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  -- Belongs to exactly one Order in the same tenant.
  constraint fulfillments_order_tenant_fk
    foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete restrict,
  -- Executed from exactly one InventoryLocation in the same tenant.
  constraint fulfillments_location_tenant_fk
    foreign key (tenant_id, inventory_location_id)
    references public.inventory_locations (tenant_id, id) on delete restrict,
  -- Corresponds to exactly one InventoryOperation in the same tenant (audit link). RESTRICT preserves
  -- history: the operation can never be deleted out from under its Fulfillment.
  constraint fulfillments_operation_tenant_fk
    foreign key (tenant_id, inventory_operation_id)
    references public.inventory_operations (tenant_id, id) on delete restrict,
  constraint fulfillments_actor_tenant_fk
    foreign key (tenant_id, actor_membership_id)
    references public.memberships (tenant_id, id) on delete restrict,
  constraint fulfillments_idempotency_key_not_blank check (normalized_idempotency_key <> ''),
  constraint fulfillments_fingerprint_not_empty check (btrim(payload_fingerprint) <> ''),
  constraint fulfillments_tenant_id_unique unique (tenant_id, id),
  -- Lets fulfillment_lines bind (tenant_id, fulfillment_id, order_id) so a line's Order always equals
  -- its Fulfillment's Order.
  constraint fulfillments_tenant_id_order_unique unique (tenant_id, id, order_id),
  -- One Fulfillment corresponds to exactly one InventoryOperation, and no operation is shared.
  constraint fulfillments_operation_unique unique (tenant_id, inventory_operation_id),
  -- Authoritative tenant-scoped idempotency (the key is always present for a fulfillment).
  constraint fulfillments_tenant_idempotency_key_unique unique (tenant_id, normalized_idempotency_key)
);

comment on table public.fulfillments is
  'Canonical immutable physical-execution record. A row existing means the inventory issue committed. No status column: no draft/pending/cancellation/mutation. Exactly one Order, one InventoryLocation, one InventoryOperation.';
comment on column public.fulfillments.inventory_location_id is
  'The single physical InventoryLocation the stock was issued from. Distinct from an Order''s commercial branch.';
comment on column public.fulfillments.payload_fingerprint is
  'Deterministic md5 of the CLIENT-INTENT canonical payload (tenant, order, location, ordered (order_line_id, quantity) lines). Shared with the replay preflight; excludes actor/timestamps/derived variant.';
comment on column public.fulfillments.actor_membership_id is
  'Verified acting Membership; null means system origin. Never caller-supplied.';

create index fulfillments_tenant_order_idx on public.fulfillments (tenant_id, order_id);
create index fulfillments_tenant_location_idx on public.fulfillments (tenant_id, inventory_location_id);
create index fulfillments_actor_idx
  on public.fulfillments (tenant_id, actor_membership_id)
  where actor_membership_id is not null;

-- Immutable per-line physical execution. variant_id is carried so the variant-matches-OrderLine and
-- same-Order invariants are enforced by composite FKs, no trigger.
create table public.fulfillment_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  fulfillment_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  variant_id uuid not null,
  line_number integer not null,
  quantity bigint not null,
  created_at timestamptz not null default now(),
  constraint fulfillment_lines_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  -- Binds the line to its Fulfillment AND forces line.order_id = fulfillment.order_id.
  constraint fulfillment_lines_fulfillment_order_tenant_fk
    foreign key (tenant_id, fulfillment_id, order_id)
    references public.fulfillments (tenant_id, id, order_id) on delete restrict,
  -- The referenced OrderLine belongs to the same Order (composite key added in migration 1).
  constraint fulfillment_lines_order_line_tenant_fk
    foreign key (tenant_id, order_id, order_line_id)
    references public.order_lines (tenant_id, order_id, id) on delete restrict,
  -- The line's variant_id equals the referenced OrderLine's variant_id (composite key added in
  -- migration 1). A caller can never spoof a variant; the server derives it from the OrderLine.
  constraint fulfillment_lines_variant_order_line_tenant_fk
    foreign key (tenant_id, order_line_id, variant_id)
    references public.order_lines (tenant_id, id, variant_id) on delete restrict,
  constraint fulfillment_lines_line_number_positive check (line_number >= 1),
  constraint fulfillment_lines_quantity_positive check (quantity > 0),
  constraint fulfillment_lines_tenant_id_unique unique (tenant_id, id),
  -- Duplicate OrderLine within one Fulfillment is forbidden.
  constraint fulfillment_lines_fulfillment_order_line_unique
    unique (tenant_id, fulfillment_id, order_line_id),
  constraint fulfillment_lines_fulfillment_line_number_unique
    unique (tenant_id, fulfillment_id, line_number)
);

comment on table public.fulfillment_lines is
  'Immutable per-OrderLine physical execution rows for one Fulfillment. quantity is the pieces issued. Duplicate OrderLine within a Fulfillment is forbidden; the same OrderLine may appear across DIFFERENT Fulfillments (partial/multi-location), bounded by the OrderLine quantity.';

create index fulfillment_lines_order_line_idx on public.fulfillment_lines (tenant_id, order_line_id);

-- Append-only defense-in-depth. Fulfillments and their lines are FULLY immutable: no update, no delete,
-- no appended lines after creation. There is no sanctioned update path (unlike orders' cancellation),
-- so this guard is unconditional and needs no GUC flag. The real boundary is the privilege model
-- (service_role has no DML); this trigger additionally catches an accidental write by the writer role.
create function fulfillments_private.forbid_fulfillment_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '42501',
    message = pg_catalog.format(
      '%I.%I is immutable; a Fulfillment records a physical execution that already happened and is never edited, cancelled, or deleted',
      tg_table_schema,
      tg_table_name
    );
end;
$function$;

create trigger fulfillments_append_only
before update or delete on public.fulfillments
for each row execute function fulfillments_private.forbid_fulfillment_mutation();

create trigger fulfillment_lines_append_only
before update or delete on public.fulfillment_lines
for each row execute function fulfillments_private.forbid_fulfillment_mutation();

-- Transfer ownership so the (migration-5) definer functions write as a role that is not any
-- client/application role, and so that role bypasses (never-forced) RLS on exactly these two tables.
-- ALTER ... OWNER TO additionally requires the new owner to hold CREATE on the object's schema; grant
-- it only for the duration of the transfer and revoke immediately after, so fulfillments_writer keeps
-- just USAGE on public and no standing CREATE anywhere.
grant create on schema public, fulfillments_private to fulfillments_writer;
alter table public.fulfillments owner to fulfillments_writer;
alter table public.fulfillment_lines owner to fulfillments_writer;
alter function fulfillments_private.forbid_fulfillment_mutation() owner to fulfillments_writer;
revoke create on schema public, fulfillments_private from fulfillments_writer;

-- Deny PUBLIC (and therefore anon/authenticated) execute on the trigger helper.
revoke all on function fulfillments_private.forbid_fulfillment_mutation() from public;
