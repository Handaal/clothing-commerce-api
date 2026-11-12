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

-- Privileged fixtures: one tenant with an active variant and two locations, created only through the
-- sanctioned mutation path.
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values ('10000000-0000-4000-8000-000000000001', 'ops-a', 'Ops A', 'active', 'completed', 'USD');

insert into public.user_identities (id, display_name, primary_email)
values ('70000000-0000-4000-8000-000000000001', 'Ops User', 'ops@example.test');

insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
values ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'P', 'p', 'active');

insert into public.product_variants (id, tenant_id, product_id, sku, status)
values ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'SKU-A', 'active');

insert into public.branches (id, tenant_id, code, display_name, timezone)
values ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRA', 'Branch A', 'UTC');

insert into public.inventory_locations (id, tenant_id, branch_id, code, display_name, location_type, is_receiving_enabled, is_transfer_origin_enabled, is_transfer_destination_enabled)
values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-A', 'Floor A', 'sales_floor', true, true, true),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'LOC-B', 'Floor B', 'sales_floor', true, true, true);

-- The 'issue' operation type is now accepted by the operation_type CHECK.
select pg_temp.assert_true(
  (
    select pg_catalog.pg_get_constraintdef(oid) like '%''issue''%'
    from pg_catalog.pg_constraint
    where conname = 'inventory_operations_type_valid'
  ),
  'operation_type CHECK now allows issue'
);

-- record_opening establishes initial stock and returns authoritative previous/on-hand/version.
create temp table r_open on commit drop as
  select * from inventory_private.record_opening(
    '10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    10,
    '71000000-0000-4000-8000-000000000001',
    'open-1'
  );

select pg_temp.assert_true((select on_hand = 10 from r_open), 'opening sets on-hand to the opening quantity');
select pg_temp.assert_true((select version = 1 from r_open), 'opening advances the balance version to 1');
select pg_temp.assert_true((select previous_on_hand = 0 from r_open), 'opening reports a previous on-hand of zero');

-- Idempotent replay of the same key returns the original operation and applies nothing.
create temp table r_open_replay on commit drop as
  select * from inventory_private.record_opening(
    '10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    10,
    '71000000-0000-4000-8000-000000000001',
    'open-1'
  );

select pg_temp.assert_true(
  (select r_open_replay.operation_id = r_open.operation_id from r_open_replay, r_open),
  'opening replay returns the original operation id'
);
select pg_temp.assert_true(
  (select on_hand = 10 from r_open_replay),
  'opening replay applies nothing'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.inventory_movements
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'opening plus its replay produced exactly one movement'
);

-- A second opening under a different key is rejected: prior history exists.
select pg_temp.assert_raises(
  $$select inventory_private.record_opening(
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      5, null, 'open-2')$$,
  'IN001',
  'a second opening of an existing key is rejected with IN001'
);

-- Non-positive opening quantity is rejected.
select pg_temp.assert_raises(
  $$select inventory_private.record_opening(
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      0, null, 'open-zero')$$,
  '22023',
  'a zero opening quantity is rejected'
);

-- Absolute count adjustment from 10 to 12 with the correct expected version.
create temp table r_adj on commit drop as
  select * from inventory_private.record_count_adjustment(
    '10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    12, 1,
    '71000000-0000-4000-8000-000000000001',
    'adj-1'
  );

select pg_temp.assert_true((select on_hand = 12 from r_adj), 'count adjustment sets on-hand to the counted quantity');
select pg_temp.assert_true((select previous_on_hand = 10 from r_adj), 'count adjustment reports the prior on-hand');
select pg_temp.assert_true((select version = 2 from r_adj), 'count adjustment advances the version');
select pg_temp.assert_true((select changed = true from r_adj), 'a non-zero count adjustment reports changed = true');
select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.inventory_movements
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'count adjustment appended exactly one compensating movement'
);
select pg_temp.assert_true(
  (
    select quantity_delta = 2
    from public.inventory_movements as movement
    join public.inventory_operations as operation on operation.id = movement.operation_id
    where operation.operation_type = 'adjustment'
      and movement.variant_id = '60000000-0000-4000-8000-000000000001'
  ),
  'the adjustment movement carries the derived delta of +2 (10 -> 12)'
);

-- A count equal to current on-hand is a DURABLE no-op: it persists one operation envelope but writes
-- no movement and leaves the balance and version unchanged, so its idempotency key is consumed exactly
-- like a changed count.
create temp table r_noop on commit drop as
  select * from inventory_private.record_count_adjustment(
    '10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    12, 2,
    '71000000-0000-4000-8000-000000000001',
    'adj-noop'
  );

select pg_temp.assert_true((select operation_id is not null from r_noop), 'a no-op count adjustment persists an operation envelope');
select pg_temp.assert_true((select changed = false from r_noop), 'a no-op count adjustment reports changed = false');
select pg_temp.assert_true((select on_hand = 12 from r_noop), 'a no-op leaves on-hand unchanged');
select pg_temp.assert_true((select previous_on_hand = 12 from r_noop), 'a no-op reports the unchanged prior on-hand');
select pg_temp.assert_true((select version = 2 from r_noop), 'a no-op leaves the version unchanged');
select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.inventory_movements
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'a no-op count adjustment creates no movement'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.inventory_operations
    where tenant_id = '10000000-0000-4000-8000-000000000001'
      and normalized_idempotency_key = 'adj-noop'
  ),
  'a no-op count adjustment records exactly one operation for its key'
);

-- Replaying the same no-op key returns the original operation and still writes nothing.
create temp table r_noop_replay on commit drop as
  select * from inventory_private.record_count_adjustment(
    '10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    12, 2,
    '71000000-0000-4000-8000-000000000001',
    'adj-noop'
  );

select pg_temp.assert_true(
  (select r_noop_replay.operation_id = r_noop.operation_id from r_noop_replay, r_noop),
  'a replayed no-op returns the original operation id'
);
select pg_temp.assert_true((select changed = false from r_noop_replay), 'a replayed no-op reports changed = false');
select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.inventory_movements
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'a replayed no-op adds no movement'
);

-- The same no-op key with a different payload is a deterministic conflict, not a fresh adjustment.
select pg_temp.assert_raises(
  $$select inventory_private.record_count_adjustment(
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      11, 2, null, 'adj-noop')$$,
  'ID409',
  'reusing a no-op key with a different payload raises ID409'
);

-- A stale expected version is rejected without mutating.
select pg_temp.assert_raises(
  $$select inventory_private.record_count_adjustment(
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      3, 0, null, 'adj-stale')$$,
  'IN002',
  'a stale expected version is rejected with IN002'
);

-- A negative counted quantity is rejected.
select pg_temp.assert_raises(
  $$select inventory_private.record_count_adjustment(
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      -1, 2, null, 'adj-neg')$$,
  '22023',
  'a negative counted quantity is rejected'
);

-- Idempotent replay of a count adjustment (same key, same payload) applies nothing.
select inventory_private.record_count_adjustment(
  '10000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  12, 1,
  '71000000-0000-4000-8000-000000000001',
  'adj-1'
);
select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.inventory_movements
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'a replayed count adjustment applies no additional movement'
);

-- The same key with a different payload is a deterministic conflict.
select pg_temp.assert_raises(
  $$select inventory_private.record_count_adjustment(
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      13, 1, null, 'adj-1')$$,
  'ID409',
  'reusing an adjustment key with a different payload raises ID409'
);

-- A generic issue leaves the location; the new operation type is honoured end to end.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'issue',
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":-4}]'::jsonb,
  '71000000-0000-4000-8000-000000000001',
  'issue-1'
);
select pg_temp.assert_true(
  (
    select on_hand_quantity = 8
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000001'
  ),
  'an issue reduces on-hand by the issued quantity'
);

-- The issue above advanced LOC-A to version 3. Replaying the durable no-op key (taken against version
-- 2) must still replay the original operation, never CONCURRENT_MODIFICATION: the idempotency lookup
-- precedes the version comparison. This locks in the durable no-op contract after a later movement.
create temp table r_noop_after on commit drop as
  select * from inventory_private.record_count_adjustment(
    '10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    12, 2,
    '71000000-0000-4000-8000-000000000001',
    'adj-noop'
  );
select pg_temp.assert_true(
  (select r_noop_after.operation_id = r_noop.operation_id from r_noop_after, r_noop),
  'a durable no-op still replays after a later movement advanced the version'
);
select pg_temp.assert_true((select changed = false from r_noop_after), 'the post-mutation no-op replay reports changed = false');

-- An issue that would drive on-hand negative rolls back atomically.
select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'issue',
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":-100}]'::jsonb,
      null, 'issue-oversell')$$,
  '23514',
  'an issue that would oversell is rejected'
);

-- An unknown operation type is still rejected by the CHECK.
select pg_temp.assert_raises(
  $$select inventory_private.record_operation(
      '10000000-0000-4000-8000-000000000001',
      'not_a_real_type',
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000001","quantity_delta":1}]'::jsonb)$$,
  '23514',
  'an unknown operation type is rejected'
);

-- A count adjustment on a fresh key creates the first history; a later opening is then rejected.
select inventory_private.record_count_adjustment(
  '10000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002',
  5, 0,
  '71000000-0000-4000-8000-000000000001',
  'adj-fresh'
);
select pg_temp.assert_raises(
  $$select inventory_private.record_opening(
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002',
      9, null, 'open-after-count')$$,
  'IN001',
  'opening is rejected once any prior movement history exists, even from a count'
);

-- ABA: two offsetting movements restore on-hand to the value the operator saw but advance the version,
-- so a count taken against the old version still fails closed with IN002. LOC-B is at on-hand 5,
-- version 1 (from adj-fresh above); +5 then -5 returns it to 5 at version 3.
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'receipt',
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":5}]'::jsonb,
  null, 'aba-receipt'
);
select inventory_private.record_operation(
  '10000000-0000-4000-8000-000000000001',
  'issue',
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","inventory_location_id":"50000000-0000-4000-8000-000000000002","quantity_delta":-5}]'::jsonb,
  null, 'aba-issue'
);
select pg_temp.assert_true(
  (
    select on_hand_quantity = 5 and version = 3
    from public.inventory_balances
    where variant_id = '60000000-0000-4000-8000-000000000001'
      and inventory_location_id = '50000000-0000-4000-8000-000000000002'
  ),
  'ABA restores on-hand to 5 but advances the version to 3'
);
select pg_temp.assert_raises(
  $$select inventory_private.record_count_adjustment(
      '10000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002',
      5, 1, null, 'aba-count')$$,
  'IN002',
  'a count against a pre-ABA version fails with IN002 even though on-hand is unchanged'
);

-- Hardening metadata for the two new functions.
select pg_temp.assert_true(
  (
    select count(*) = 2
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles as owner on owner.oid = procedure.proowner
    where namespace.nspname = 'inventory_private'
      and procedure.proname in ('record_opening', 'record_count_adjustment')
      and procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
      and owner.rolname = 'inventory_writer'
  ),
  'both new functions are SECURITY DEFINER, empty search_path, owned by inventory_writer'
);

select pg_temp.assert_true(
  (
    select bool_and(has_function_privilege('service_role', procedure.oid, 'EXECUTE'))
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'inventory_private'
      and procedure.proname in ('record_opening', 'record_count_adjustment')
  ),
  'service_role may execute both new functions'
);

select pg_temp.assert_true(
  (
    select count(*) = 0
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'inventory_private'
      and procedure.proname in ('record_opening', 'record_count_adjustment')
      and (
        has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        or has_function_privilege('anon', procedure.oid, 'EXECUTE')
      )
  ),
  'neither authenticated nor anon may execute the new functions'
);

-- service_role still holds no direct table DML on the inventory tables.
select pg_temp.assert_true(
  (
    select count(*) = 3
    from unnest(array['inventory_operations', 'inventory_movements', 'inventory_balances']) as table_name
    where has_table_privilege('service_role', format('public.%I', table_name), 'SELECT')
      and not has_table_privilege('service_role', format('public.%I', table_name), 'INSERT')
      and not has_table_privilege('service_role', format('public.%I', table_name), 'UPDATE')
      and not has_table_privilege('service_role', format('public.%I', table_name), 'DELETE')
  ),
  'service_role retains SELECT-only inventory grants after Phase 2C'
);

rollback;
