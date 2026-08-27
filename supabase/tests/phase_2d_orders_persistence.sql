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

-- Two tenants; brands, products, variants, prices, branches, and registers wired so the single-brand
-- and register-belongs-to-branch invariants can be exercised.
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('10000000-0000-4000-8000-000000000001', 'ord-a', 'Orders A', 'active', 'completed', 'USD'),
  ('10000000-0000-4000-8000-000000000002', 'ord-b', 'Orders B', 'active', 'completed', 'USD');

insert into public.user_identities (id, display_name, primary_email)
values ('70000000-0000-4000-8000-000000000001', 'Ord User', 'ord@example.test');

insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at)
values
  ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now()),
  ('71000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'active', now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'A2', 'Brand A2'),
  ('20000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000002', 'B', 'Brand B');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Tee', 'tee', 'active'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'Hoodie', 'hoodie', 'active'),
  ('30000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-00000000000b', 'ProdB', 'prodb', 'active');

insert into public.product_variants (id, tenant_id, product_id, sku, status)
values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'TEE-M', 'active'),
  ('60000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 'HOOD-1', 'active'),
  ('60000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-00000000000b', 'B-1', 'active');

insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor)
values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'USD', 2599);

insert into public.branches (id, tenant_id, code, display_name, timezone)
values
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BRA', 'Branch A', 'UTC'),
  ('b0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'BRA2', 'Branch A2', 'UTC'),
  ('b0000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000002', 'BRB', 'Branch B', 'UTC');

insert into public.registers (id, tenant_id, branch_id, code, display_name, status)
values
  ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'REG1', 'Register 1', 'inactive'),
  ('c0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 'REG2', 'Register 2', 'inactive');

-- ============================ structure ============================

select pg_temp.assert_true(to_regclass('public.orders') is not null, 'orders table exists');
select pg_temp.assert_true(to_regclass('public.order_lines') is not null, 'order_lines table exists');
select pg_temp.assert_true(
  to_regclass('public.order_number_sequences') is not null, 'order_number_sequences table exists'
);
select pg_temp.assert_true(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.orders'::regclass),
  'RLS enabled on orders'
);
select pg_temp.assert_true(
  (select pg_catalog.pg_get_userbyid(relowner) from pg_catalog.pg_class where oid = 'public.orders'::regclass) = 'orders_writer',
  'orders owned by orders_writer'
);

-- ============================ create_order happy path ============================

create temp table pos_order on commit drop as
  select orders_private.create_order(
    '10000000-0000-4000-8000-000000000001', 'pos', 'USD',
    '20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
    'pos-key-1', null, null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":2,"unit_price_minor":2599,"product_name":"Tee","variant_name":"Tee M","sku":"TEE-M","option_summary":"Size: M"}]'::jsonb
  ) as order_id;

select pg_temp.assert_true(
  (select count(*) = 1 from public.orders o join pos_order p on o.id = p.order_id
   where o.status = 'placed' and o.total_minor = 5198 and o.channel = 'pos'
     and o.branch_id = 'b0000000-0000-4000-8000-000000000001'
     and o.register_id = 'c0000000-0000-4000-8000-000000000001'),
  'create_order persists a placed pos order with computed total'
);

select pg_temp.assert_true(
  (select order_number = '1' from public.orders o join pos_order p on o.id = p.order_id),
  'first order gets order_number 1'
);

select pg_temp.assert_true(
  (select count(*) = 1 from public.order_lines l join pos_order p on l.order_id = p.order_id
   where l.line_number = 1 and l.quantity = 2 and l.unit_price_minor = 2599
     and l.line_total_minor = 5198 and l.sku_snapshot = 'TEE-M'
     and l.option_summary_snapshot = 'Size: M' and l.brand_id = '20000000-0000-4000-8000-000000000001'),
  'order line persists the immutable commercial snapshot'
);

-- second, distinct order advances the per-tenant counter
create temp table pos_order_2 on commit drop as
  select orders_private.create_order(
    '10000000-0000-4000-8000-000000000001', 'pos', 'USD',
    '20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
    'pos-key-2', null, null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":1,"unit_price_minor":3599,"product_name":"Tee","variant_name":"Tee L","sku":"TEE-L","option_summary":"Size: L"}]'::jsonb
  ) as order_id;

select pg_temp.assert_true(
  (select order_number = '2' from public.orders o join pos_order_2 p on o.id = p.order_id),
  'second order gets order_number 2'
);

-- ============================ idempotency ============================

select pg_temp.assert_true(
  orders_private.create_order(
    '10000000-0000-4000-8000-000000000001', 'pos', 'USD',
    '20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
    'pos-key-1', null, null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":2,"unit_price_minor":2599,"product_name":"Tee","variant_name":"Tee M","sku":"TEE-M","option_summary":"Size: M"}]'::jsonb
  ) = (select order_id from pos_order),
  'same key + same intent replays the original order id'
);

select pg_temp.assert_true(
  (select count(*) = 1 from public.orders where tenant_id = '10000000-0000-4000-8000-000000000001'
   and normalized_idempotency_key = 'pos-key-1'),
  'replay does not create a second order for the key'
);

select pg_temp.assert_raises(
  $$select orders_private.create_order(
      '10000000-0000-4000-8000-000000000001', 'pos', 'USD',
      '20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
      'pos-key-1', null, null,
      '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":9,"unit_price_minor":2599,"product_name":"Tee","variant_name":"Tee M","sku":"TEE-M","option_summary":"Size: M"}]'::jsonb
    )$$,
  'ID409',
  'same key + different intent is a conflict'
);

-- resolve_idempotent_replay_target routing preflight
select pg_temp.assert_true(
  (select fingerprint_matches from orders_private.resolve_idempotent_replay_target(
    '10000000-0000-4000-8000-000000000001', 'pos-key-1',
    '{"channel":"pos","currency":"USD","register_id":"c0000000-0000-4000-8000-000000000001","lines":[{"variant_id":"60000000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb
  )),
  'preflight matches the original intent'
);

select pg_temp.assert_true(
  (select order_id is null and brand_id is null from orders_private.resolve_idempotent_replay_target(
    '10000000-0000-4000-8000-000000000001', 'pos-key-1',
    '{"channel":"pos","currency":"USD","register_id":"c0000000-0000-4000-8000-000000000001","lines":[{"variant_id":"60000000-0000-4000-8000-000000000001","quantity":9}]}'::jsonb
  )),
  'preflight conflict discloses no routing identifiers'
);

select pg_temp.assert_true(
  (select count(*) = 0 from orders_private.resolve_idempotent_replay_target(
    '10000000-0000-4000-8000-000000000001', 'no-such-key',
    '{"channel":"pos","currency":"USD","register_id":null,"lines":[]}'::jsonb
  )),
  'preflight returns no rows for an unknown key'
);

-- ============================ validation ============================

select pg_temp.assert_raises(
  $$select orders_private.create_order('10000000-0000-4000-8000-000000000001','pos','USD',
    '20000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','empty-key',null,null,'[]'::jsonb)$$,
  '22023',
  'empty line list is rejected'
);

select pg_temp.assert_raises(
  $$select orders_private.create_order('10000000-0000-4000-8000-000000000001','pos','USD',
    '20000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','ovf-key',null,null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":9223372036854775807,"unit_price_minor":2599,"product_name":"Tee","sku":"TEE-M"}]'::jsonb)$$,
  '22003',
  'line total overflow is rejected'
);

select pg_temp.assert_raises(
  $$select orders_private.create_order('10000000-0000-4000-8000-000000000001','pos','USD',
    '20000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','qty-key',null,null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":0,"unit_price_minor":2599,"product_name":"Tee","sku":"TEE-M"}]'::jsonb)$$,
  '22023',
  'non-positive quantity is rejected'
);

-- register belongs to a DIFFERENT branch than supplied -> composite FK violation
select pg_temp.assert_raises(
  $$select orders_private.create_order('10000000-0000-4000-8000-000000000001','pos','USD',
    '20000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','mismatch-key',null,null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":1,"unit_price_minor":2599,"product_name":"Tee","sku":"TEE-M"}]'::jsonb)$$,
  '23503',
  'register that does not belong to the supplied branch is rejected'
);

-- online with a branch supplied -> function validation
select pg_temp.assert_raises(
  $$select orders_private.create_order('10000000-0000-4000-8000-000000000001','online','USD',
    '20000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
    null,null,'online-bad-key',null,null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":1,"unit_price_minor":2599,"product_name":"Tee","sku":"TEE-M"}]'::jsonb)$$,
  '22023',
  'online order carrying a branch is rejected'
);

-- online happy path
create temp table online_order on commit drop as
  select orders_private.create_order(
    '10000000-0000-4000-8000-000000000001', 'online', 'USD',
    '20000000-0000-4000-8000-000000000001', null, null, null,
    'online-key-1', null, null,
    '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":1,"unit_price_minor":2599,"product_name":"Tee","sku":"TEE-M"}]'::jsonb
  ) as order_id;

select pg_temp.assert_true(
  (select channel = 'online' and branch_id is null and register_id is null and actor_membership_id is null
   from public.orders o join online_order p on o.id = p.order_id),
  'online order carries no branch/register/actor'
);

-- ============================ declarative brand/tenant integrity (direct DML) ============================

-- cross-brand line: product belongs to a different brand than the order
select pg_temp.assert_raises(
  $$insert into public.order_lines (tenant_id, order_id, brand_id, product_id, variant_id, line_number, quantity, unit_price_minor, line_total_minor, product_name_snapshot, sku_snapshot)
    select '10000000-0000-4000-8000-000000000001', order_id, '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000003', 9, 1, 100, 100, 'X', 'X'
    from pos_order$$,
  '23503',
  'a line whose product belongs to another brand is rejected'
);

-- cross-tenant line
select pg_temp.assert_raises(
  $$insert into public.order_lines (tenant_id, order_id, brand_id, product_id, variant_id, line_number, quantity, unit_price_minor, line_total_minor, product_name_snapshot, sku_snapshot)
    select '10000000-0000-4000-8000-000000000002', order_id, '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 9, 1, 100, 100, 'X', 'X'
    from pos_order$$,
  '23503',
  'a line under a different tenant than its order is rejected'
);

-- channel provenance CHECK (direct insert bypassing the function)
select pg_temp.assert_raises(
  $$insert into public.orders (tenant_id, brand_id, order_number, channel, currency, total_minor)
    values ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','900','pos','USD',0)$$,
  '23514',
  'pos order without a branch/register violates the provenance CHECK'
);

select pg_temp.assert_raises(
  $$insert into public.orders (tenant_id, brand_id, branch_id, order_number, channel, currency, total_minor)
    values ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','901','online','USD',0)$$,
  '23514',
  'online order carrying a branch violates the provenance CHECK'
);

-- order number uniqueness within a tenant; reuse across tenants is allowed
select pg_temp.assert_raises(
  $$insert into public.orders (tenant_id, brand_id, order_number, channel, currency, total_minor)
    values ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','1','online','USD',0)$$,
  '23505',
  'duplicate order number within a tenant is rejected'
);

-- ============================ append-only immutability ============================

select pg_temp.assert_raises(
  $$update public.order_lines set quantity = 99 where order_id = (select order_id from pos_order)$$,
  '42501',
  'order lines cannot be updated'
);

select pg_temp.assert_raises(
  $$delete from public.order_lines where order_id = (select order_id from pos_order)$$,
  '42501',
  'order lines cannot be deleted'
);

select pg_temp.assert_raises(
  $$delete from public.orders where id = (select order_id from pos_order)$$,
  '42501',
  'orders cannot be deleted'
);

select pg_temp.assert_raises(
  $$update public.orders set notes = 'x' where id = (select order_id from pos_order)$$,
  '42501',
  'orders cannot be updated outside the sanctioned functions'
);

-- ============================ cancellation ============================

select pg_temp.assert_true(
  (select already_cancelled = false and status = 'cancelled'
   from orders_private.cancel_order(
     '10000000-0000-4000-8000-000000000001', (select order_id from pos_order),
     '71000000-0000-4000-8000-000000000001', 'first reason')),
  'cancel transitions a placed order and reports not-already-cancelled'
);

select pg_temp.assert_true(
  (select status = 'cancelled' and cancelled_at is not null and cancellation_reason = 'first reason'
   from public.orders where id = (select order_id from pos_order)),
  'cancelled order persists its metadata'
);

select pg_temp.assert_true(
  (select already_cancelled = true and cancellation_reason = 'first reason'
   from orders_private.cancel_order(
     '10000000-0000-4000-8000-000000000001', (select order_id from pos_order),
     '71000000-0000-4000-8000-00000000000b', 'second reason')),
  'a repeated cancel preserves the original reason and reports already-cancelled'
);

select pg_temp.assert_true(
  (select count(*) = 0 from orders_private.cancel_order(
     '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-0000000000ff',
     '71000000-0000-4000-8000-000000000001', null)),
  'cancelling a nonexistent order returns no rows'
);

-- ============================ privilege boundary ============================

select pg_temp.assert_true(
  has_table_privilege('service_role', 'public.orders', 'SELECT'),
  'service_role may SELECT orders'
);
select pg_temp.assert_true(
  not has_table_privilege('service_role', 'public.orders', 'INSERT'),
  'service_role has no direct INSERT on orders'
);
select pg_temp.assert_true(
  not has_table_privilege('service_role', 'public.order_lines', 'UPDATE'),
  'service_role has no direct UPDATE on order_lines'
);
select pg_temp.assert_true(
  not has_table_privilege('service_role', 'public.order_number_sequences', 'SELECT'),
  'service_role cannot read the order-number counter'
);

-- ============================ permission catalog seed ============================

select pg_temp.assert_true(
  (select count(*) = 8 from public.permissions
   where key in ('inventory.read','inventory.adjust','inventory.receive','inventory.issue','inventory.transfer',
                 'orders.read','orders.create','orders.cancel')),
  'the platform permission catalog seed created all eight keys'
);

select pg_temp.assert_true(
  (select count(*) = 0 from public.role_permissions),
  'the permission seed granted no permissions to any role'
);

rollback;
