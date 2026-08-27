\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(condition boolean, label text)
returns void
language plpgsql
as $function$
begin
  if condition is distinct from true then
    raise exception 'assertion failed: %', label;
  end if;
end;
$function$;

create or replace function pg_temp.assert_raises(statement text, expected_state text, label text)
returns void
language plpgsql
as $function$
declare
  actual_state text;
begin
  begin
    execute statement;
  exception
    when others then
      get stacked diagnostics actual_state = returned_sqlstate;
      if actual_state = expected_state then
        return;
      end if;
      raise exception 'assertion failed: %, expected SQLSTATE %, received %',
        label, expected_state, actual_state;
  end;

  raise exception 'assertion failed: %, expected SQLSTATE %, but statement succeeded',
    label, expected_state;
end;
$function$;

-- Structure: three tables, one private mutation schema, key constraints and indexes.
select pg_temp.assert_true(
  (
    select count(*) = 3
    from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename = any (
        array['inventory_operations', 'inventory_movements', 'inventory_balances']
      )
  ),
  'all three Phase 2B inventory tables exist'
);

-- Orders arrived in Phase 2D; customer and reservation domains remain deferred. Order creation still
-- has no inventory side effect (there is no inventory_reservations table and no stock-affecting link).
select pg_temp.assert_true(
  to_regclass('public.customers') is null
  and to_regclass('public.inventory_reservations') is null,
  'deferred customer and reservation domains remain absent'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'inventory_private'
      and procedure.proname in ('forbid_ledger_mutation', 'guard_balance_write')
      and not procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
  ),
  'the two inventory trigger helpers are SECURITY INVOKER with an empty fixed search_path'
);

-- The sole mutation path is a hardened SECURITY DEFINER function owned by a dedicated writer role.
select pg_temp.assert_true(
  (
    select procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
      and owner.rolname = 'inventory_writer'
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles as owner on owner.oid = procedure.proowner
    where namespace.nspname = 'inventory_private'
      and procedure.proname = 'record_operation'
  ),
  'record_operation is SECURITY DEFINER, empty search_path, owned by inventory_writer'
);

-- The dedicated writer role owns the tables (its RLS-bypass is scoped to exactly these three) and
-- is not a login/bypassrls role, so only the definer function can write inventory.
select pg_temp.assert_true(
  (
    select count(*) = 3
    from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename = any (
        array['inventory_operations', 'inventory_movements', 'inventory_balances']
      )
      and tableowner = 'inventory_writer'
  )
  and (
    select not rolcanlogin and not rolbypassrls
    from pg_catalog.pg_roles
    where rolname = 'inventory_writer'
  ),
  'inventory tables are owned by the non-login, non-bypassrls inventory_writer role'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_attribute
    where attrelid = 'public.inventory_operations'::regclass
      and attname = 'payload_fingerprint'
      and not attisdropped
  ),
  'inventory_operations carries a payload_fingerprint for idempotency misuse detection'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'inventory_balances_variant_location_unique'
  ),
  'inventory_balances enforces the (tenant, variant, location) physical key'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname = 'inventory_operations_tenant_idempotency_key_unique_idx'
  ),
  'a partial unique index protects tenant-scoped idempotency keys'
);

-- Privileged fixtures across two tenants.
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('10000000-0000-4000-8000-000000000001', 'inv-a', 'Inventory A', 'active', 'completed', 'USD'),
  ('10000000-0000-4000-8000-000000000002', 'inv-b', 'Inventory B', 'active', 'completed', 'EUR');

insert into public.user_identities (id, display_name, primary_email)
values ('70000000-0000-4000-8000-000000000001', 'Inv Actor', 'actor@example.test');

insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
values
  ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now()),
  ('71000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'active', now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'B', 'Brand B');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Prod A', 'prod-a', 'active'),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Prod A2', 'prod-a2', 'active'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Prod B', 'prod-b', 'active');

insert into public.product_variants (id, tenant_id, product_id, sku, status)
values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'SKU-A1', 'active'),
  ('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'SKU-A2', 'active'),
  ('6000000b-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'SKU-B1', 'active');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRA', 'Branch A', 'UTC'),
  ('b0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'BRB', 'Branch B', 'UTC');

insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type)
values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A1', 'Floor A1', 'sales_floor'),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A2', 'Stock A2', 'stockroom'),
  ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A3', 'Floor A3', 'sales_floor'),
  ('5000000b-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'LOC-B1', 'Floor B1', 'sales_floor');

-- Opening stock is expressed as a movement, never a directly seeded balance row.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'opening',
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":12}]'::jsonb,
  '71000000-0000-4000-8000-000000000001',
  'open-a1'
);

select pg_temp.assert_true(
  (
    select on_hand_quantity = 12
    from public.inventory_balances
    where tenant_id = '10000000-0000-4000-8000-000000000001'
      and variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'opening movement creates a projected balance of 12'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.inventory_movements
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'opening records exactly one ledger movement'
);

select pg_temp.assert_true(
  (
    select actor_membership_id = '71000000-0000-4000-8000-000000000001'
    from public.inventory_operations
    where normalized_idempotency_key = 'open-a1'
  ),
  'the operation records its actor membership'
);

-- A stock-count correction is a compensating movement, not a balance overwrite.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'adjustment',
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":-5}]'::jsonb
);

select pg_temp.assert_true(
  (
    select on_hand_quantity = 7
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'a negative adjustment reduces on-hand to 7'
);

-- The projection must equal the movement ledger aggregate for every key.
select pg_temp.assert_true(
  not exists (
    select 1
    from (
      select tenant_id, variant_id, inventory_location_id, sum(quantity_delta) as ledger_sum
      from public.inventory_movements
      group by tenant_id, variant_id, inventory_location_id
    ) as ledger
    full join public.inventory_balances as balance
      on balance.tenant_id = ledger.tenant_id
      and balance.variant_id = ledger.variant_id
      and balance.inventory_location_id = ledger.inventory_location_id
    where coalesce(balance.on_hand_quantity, 0) is distinct from coalesce(ledger.ledger_sum, 0)
  ),
  'every balance equals its movement ledger sum'
);

-- One operation may carry several movements (future sale of multiple variants at one location).
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'opening',
  '[
    {"variant_id":"60000000-0000-4000-8000-000000000002","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":4},
    {"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":9}
  ]'::jsonb,
  null,
  'multi-a'
);

select pg_temp.assert_true(
  (
    select count(*) = 2 and count(distinct line_number) = 2 and min(line_number) = 1 and max(line_number) = 2
    from public.inventory_movements as movement
    join public.inventory_operations as operation on operation.id = movement.operation_id
    where operation.normalized_idempotency_key = 'multi-a'
  ),
  'a multi-line operation records deterministically ordered movements'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000001'
  ),
  'one variant holds independent balances at two locations'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.inventory_balances
    where inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'one location holds independent balances for two variants'
);

-- Internal-transfer ledger semantics: a single operation nets to zero across two locations.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'transfer',
  '[
    {"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":-3},
    {"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":3}
  ]'::jsonb,
  null,
  'transfer-a'
);

select pg_temp.assert_true(
  (
    select sum(quantity_delta) = 0
    from public.inventory_movements as movement
    join public.inventory_operations as operation on operation.id = movement.operation_id
    where operation.normalized_idempotency_key = 'transfer-a'
  ),
  'a pure transfer operation is zero-sum across its movements'
);

select pg_temp.assert_true(
  (
    select on_hand_quantity = 4
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  )
  and (
    select on_hand_quantity = 12
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000002'
  ),
  'the transfer moved 3 units between locations without changing the tenant total'
);

-- Idempotency: replaying a used (tenant, key) with the SAME payload/fingerprint returns the same
-- operation and applies nothing. The fingerprint covers tenant, type, actor, and ordered lines, so
-- the replay must reproduce the original opening (+12, actor 71..0001) exactly.
select pg_temp.assert_true(
  inventory_private.record_operation(
    '10000000-0000-4000-8000-000000000001',
    'opening',
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":12}]'::jsonb,
    '71000000-0000-4000-8000-000000000001',
    'open-a1'
  ) = (
    select id from public.inventory_operations where normalized_idempotency_key = 'open-a1'
  ),
  'a repeated idempotency key with the same fingerprint returns the original operation id'
);

select pg_temp.assert_true(
  (
    select on_hand_quantity = 4
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'the idempotent replay did not re-apply its movement'
);

-- Reusing the key with a DIFFERENT payload is a deterministic error, never a silent no-op.
select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'opening',
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":13}]'::jsonb,
      '71000000-0000-4000-8000-000000000001',
      'open-a1'
    )$$,
  'ID409',
  'the same idempotency key with a different payload is rejected'
);

-- Fingerprint is representation-independent: JSON key order does not change identity.
select pg_temp.assert_true(
  inventory_private.record_operation(
    '10000000-0000-4000-8000-000000000001',
    'opening',
    '[{"quantity_delta":12,"inventory_location_id":"50000000-0000-4000-8000-000000000001","variant_id":"60000000-0000-4000-8000-000000000001"}]'::jsonb,
    '71000000-0000-4000-8000-000000000001',
    'open-a1'
  ) = (
    select id from public.inventory_operations where normalized_idempotency_key = 'open-a1'
  ),
  'reordered JSON object keys produce the same fingerprint and replay the original operation'
);

-- N3: occurred_at is deliberately excluded from the idempotency fingerprint (Phase 2B decision, see
-- ADR-019). Reusing a key with the same payload but a different occurred_at replays the original
-- operation and keeps its original business time; it never records a second, re-timestamped event.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'adjustment',
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000003","quantity_delta":4}]'::jsonb,
  '71000000-0000-4000-8000-000000000001',
  'occurred-at-a',
  '2026-01-01T10:00:00Z'
);

select pg_temp.assert_true(
  inventory_private.record_operation(
    '10000000-0000-4000-8000-000000000001',
    'adjustment',
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000003","quantity_delta":4}]'::jsonb,
    '71000000-0000-4000-8000-000000000001',
    'occurred-at-a',
    '2026-06-15T14:00:00Z'
  ) = (select id from public.inventory_operations where normalized_idempotency_key = 'occurred-at-a'),
  'a replay with a different occurred_at returns the original operation id'
);

select pg_temp.assert_true(
  (select count(*) = 1 from public.inventory_operations where normalized_idempotency_key = 'occurred-at-a')
  and (
    select occurred_at = timestamptz '2026-01-01T10:00:00Z'
    from public.inventory_operations
    where normalized_idempotency_key = 'occurred-at-a'
  )
  and (
    select count(*) = 1
    from public.inventory_movements as movement
    join public.inventory_operations as operation on operation.id = movement.operation_id
    where operation.normalized_idempotency_key = 'occurred-at-a'
  )
  and (
    select on_hand_quantity = 4
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000003'
  ),
  'the occurred_at replay adds no operation/movement, keeps the original occurred_at, and does not re-apply stock'
);

-- Cross-tenant reuse of the same idempotency key is allowed and independent.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000002',
  'opening',
  '[{"variant_id":"6000000b-0000-4000-8000-000000000001","inventory_location_id":"5000000b-0000-4000-8000-000000000001","quantity_delta":6}]'::jsonb,
  null,
  'open-a1'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.inventory_operations
    where normalized_idempotency_key = 'open-a1'
  ),
  'the same idempotency key is reusable across different tenants'
);

-- Large valid bigint quantities are supported for discrete piece counts.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000002',
  'opening',
  '[{"variant_id":"6000000b-0000-4000-8000-000000000001","inventory_location_id":"5000000b-0000-4000-8000-000000000001","quantity_delta":1000000000000}]'::jsonb
);

select pg_temp.assert_true(
  (
    select on_hand_quantity = 1000000006
    from public.inventory_balances
    where variant_id = '6000000b-0000-4000-8000-000000000001'
  ) is not true
  and (
    select on_hand_quantity = 1000000000006
    from public.inventory_balances
    where variant_id = '6000000b-0000-4000-8000-000000000001'
  ),
  'a large bigint quantity accumulates without overflow'
);

-- Rejections. Each must roll back the whole operation atomically.
select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'sale',
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":-100}]'::jsonb
    )$$,
  '23514',
  'a movement that would oversell is rejected'
);

select pg_temp.assert_true(
  (
    select on_hand_quantity = 4
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'the rejected oversell left the balance unchanged'
);

select pg_temp.assert_true(
  (select count(*) from public.inventory_operations where operation_type = 'sale') = 0,
  'the rejected oversell recorded no operation row'
);

select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'adjustment',
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":0}]'::jsonb
    )$$,
  '22023',
  'a zero-quantity movement is rejected as meaningless ledger noise'
);

select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'adjustment',
      '[]'::jsonb
    )$$,
  '22023',
  'an operation with no movements is rejected'
);

select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'adjustment',
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":1}]'::jsonb,
      null,
      '   '
    )$$,
  '22023',
  'a blank idempotency key is rejected'
);

select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'not_a_real_type',
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":1}]'::jsonb
    )$$,
  '23514',
  'an unknown operation_type is rejected'
);

-- Cross-tenant references are structurally impossible.
select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'opening',
      '[{"variant_id":"6000000b-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":1}]'::jsonb
    )$$,
  '23503',
  'a movement against another tenant''s variant is rejected'
);

select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'opening',
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"5000000b-0000-4000-8000-000000000001","quantity_delta":1}]'::jsonb
    )$$,
  '23503',
  'a movement against another tenant''s location is rejected'
);

select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'opening',
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":1}]'::jsonb,
      '71000000-0000-4000-8000-000000000002'
    )$$,
  '23503',
  'an actor membership from another tenant is rejected'
);

-- Append-only ledger: committed history cannot be updated or deleted.
select pg_temp.assert_raises(
  $$update public.inventory_movements set quantity_delta = quantity_delta + 1$$,
  '42501',
  'inventory_movements rows cannot be updated'
);

select pg_temp.assert_raises(
  $$delete from public.inventory_movements$$,
  '42501',
  'inventory_movements rows cannot be deleted'
);

select pg_temp.assert_raises(
  $$update public.inventory_operations set operation_type = 'correction'$$,
  '42501',
  'inventory_operations rows cannot be updated'
);

select pg_temp.assert_raises(
  $$delete from public.inventory_operations$$,
  '42501',
  'inventory_operations rows cannot be deleted'
);

-- The projection may not be mutated outside the approved path.
select pg_temp.assert_raises(
  $$insert into public.inventory_balances (tenant_id, variant_id, inventory_location_id, on_hand_quantity)
    values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 5)$$,
  '42501',
  'a direct balance insert outside record_operation is rejected'
);

select pg_temp.assert_raises(
  $$update public.inventory_balances set on_hand_quantity = 9999$$,
  '42501',
  'a direct balance update outside record_operation is rejected'
);

select pg_temp.assert_raises(
  $$delete from public.inventory_balances$$,
  '42501',
  'a direct balance delete is always rejected'
);

-- Direct ledger appends remain possible for the trusted server path, but structural keys hold.
insert into public.inventory_operations (id, tenant_id, operation_type)
values ('0f000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'correction');

select pg_temp.assert_raises(
  $$insert into public.inventory_movements
      (tenant_id, operation_id, variant_id, inventory_location_id, quantity_delta, line_number)
    values
      ('10000000-0000-4000-8000-000000000001', '0f000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 1, 1),
      ('10000000-0000-4000-8000-000000000001', '0f000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 1, 1)$$,
  '23505',
  'movement line numbers are unique within an operation'
);

select pg_temp.assert_raises(
  $$insert into public.inventory_movements
      (tenant_id, operation_id, variant_id, inventory_location_id, quantity_delta, line_number)
    values
      ('10000000-0000-4000-8000-000000000002', '0f000000-0000-4000-8000-000000000001', '6000000b-0000-4000-8000-000000000001', '5000000b-0000-4000-8000-000000000001', 1, 1)$$,
  '23503',
  'a movement cannot reference an operation from another tenant'
);

-- System-origin operations (no actor) are valid.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'receipt',
  '[{"variant_id":"60000000-0000-4000-8000-000000000002","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":2}]'::jsonb
);

select pg_temp.assert_true(
  (
    select actor_membership_id is null
    from public.inventory_operations
    where operation_type = 'receipt'
  ),
  'a system-origin operation records a null actor membership'
);

-- Several movement lines on the same key net correctly and each remains a distinct ledger row.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'correction',
  '[
    {"variant_id":"60000000-0000-4000-8000-000000000002","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":10},
    {"variant_id":"60000000-0000-4000-8000-000000000002","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":-3},
    {"variant_id":"60000000-0000-4000-8000-000000000002","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":-2}
  ]'::jsonb,
  null,
  'multiline-a'
);

select pg_temp.assert_true(
  (
    select on_hand_quantity = 5
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000002'
      and inventory_location_id = '50000000-0000-4000-8000-000000000002'
  )
  and (
    select count(*) = 3
    from public.inventory_movements as movement
    join public.inventory_operations as operation on operation.id = movement.operation_id
    where operation.normalized_idempotency_key = 'multiline-a'
  ),
  'multiple same-key lines net to +5 while preserving three distinct movement rows'
);

-- On-hand may never go negative at any intermediate line, even when the net would be non-negative.
select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'correction',
      '[
        {"variant_id":"60000000-0000-4000-8000-000000000002","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":-9},
        {"variant_id":"60000000-0000-4000-8000-000000000002","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":100}
      ]'::jsonb
    )$$,
  '23514',
  'a line sequence whose intermediate on-hand would be negative is rejected'
);

-- bigint overflow is rejected and rolls the whole operation back.
select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'adjustment',
      '[{"variant_id":"60000000-0000-4000-8000-000000000002","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":9223372036854775807}]'::jsonb
    )$$,
  '22003',
  'a bigint overflow is rejected'
);

-- Privilege boundary (F1): service_role cannot write inventory directly; it may only EXECUTE the
-- hardened function. These run under the real service_role, not the superuser test role.
set local role service_role;

select pg_temp.assert_raises(
  $$insert into public.inventory_operations (tenant_id, operation_type)
    values ('10000000-0000-4000-8000-000000000001', 'sale')$$,
  '42501',
  'service_role cannot directly INSERT inventory_operations'
);

select pg_temp.assert_raises(
  $$insert into public.inventory_movements
      (tenant_id, operation_id, variant_id, inventory_location_id, quantity_delta, line_number)
    values ('10000000-0000-4000-8000-000000000001', '0f000000-0000-4000-8000-000000000001',
            '60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 1, 90)$$,
  '42501',
  'service_role cannot directly INSERT inventory_movements'
);

select pg_temp.assert_raises(
  $$insert into public.inventory_balances (tenant_id, variant_id, inventory_location_id, on_hand_quantity)
    values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 1)$$,
  '42501',
  'service_role cannot directly INSERT inventory_balances'
);

select pg_temp.assert_raises(
  $$update public.inventory_balances set on_hand_quantity = on_hand_quantity + 1$$,
  '42501',
  'service_role cannot directly UPDATE inventory_balances'
);

select pg_temp.assert_true(
  inventory_private.record_operation(
    '10000000-0000-4000-8000-000000000001',
    'adjustment',
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":1}]'::jsonb
  ) is not null,
  'service_role can execute the hardened record_operation mutation path'
);

reset role;

rollback;
