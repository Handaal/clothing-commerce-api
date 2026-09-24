\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(condition boolean, label text)
returns void language plpgsql as $function$
begin
  if condition is distinct from true then raise exception 'assertion failed: %', label; end if;
end;
$function$;

create or replace function pg_temp.assert_raises(statement text, expected_state text, label text)
returns void language plpgsql as $function$
declare actual_state text;
begin
  begin execute statement;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate;
    if actual_state = expected_state then return; end if;
    raise exception 'assertion failed: %, expected SQLSTATE %, received %', label, expected_state, actual_state;
  end;
  raise exception 'assertion failed: %, expected SQLSTATE %, but statement succeeded', label, expected_state;
end;
$function$;

-- Helper: run the non-consuming engine for tenant A brand A online with no code.
create or replace function pg_temp.eval_a(p_lines jsonb, p_code text default null)
returns jsonb language sql as $function$
  select promotions_private.evaluate(
    '10000000-0000-4000-8000-000000000001','online','USD',
    '20000000-0000-4000-8000-000000000001', null, p_lines, p_code);
$function$;

-- ============================ seed ============================
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency) values
  ('10000000-0000-4000-8000-000000000001','promo-a','Promo A','active','completed','USD'),
  ('10000000-0000-4000-8000-000000000002','promo-b','Promo B','active','completed','USD');
insert into public.user_identities (id, display_name, primary_email)
values ('70000000-0000-4000-8000-000000000001','Promo User','promo@example.test');
insert into public.memberships (id, tenant_id, user_identity_id, status, invited_at, activated_at) values
  ('71000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','active',now(),now());
insert into public.brands (id, tenant_id, code, display_name) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A','Brand A'),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','A2','Brand A2'),
  ('20000000-0000-4000-8000-00000000000b','10000000-0000-4000-8000-000000000002','B','Brand B');
insert into public.products (id, tenant_id, brand_id, name, slug, status) values
  ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Tee','tee','active'),
  ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Pants','pants','active');
insert into public.product_variants (id, tenant_id, product_id, sku, status) values
  ('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','TEE-M','active'),
  ('60000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','PANTS-1','active');
insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor) values
  ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','USD',2599),
  ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000002','USD',5000);

-- Reusable single-line (TEE-M x1 = 2599) and two-line (TEE-M x1 + PANTS-1 x1 = 7599) line sets.
create temp view lines1 as select
  '[{"ord":1,"variantId":"60000000-0000-4000-8000-000000000001","productId":"30000000-0000-4000-8000-000000000001","quantity":1,"lineTotalMinor":2599}]'::jsonb as j;
create temp view lines2 as select
  '[{"ord":1,"variantId":"60000000-0000-4000-8000-000000000001","productId":"30000000-0000-4000-8000-000000000001","quantity":1,"lineTotalMinor":2599},
    {"ord":2,"variantId":"60000000-0000-4000-8000-000000000002","productId":"30000000-0000-4000-8000-000000000002","quantity":1,"lineTotalMinor":5000}]'::jsonb as j;

-- ============================ structure ============================
select pg_temp.assert_true(to_regclass('public.promotions') is not null, 'promotions table exists');
select pg_temp.assert_true(to_regclass('public.order_adjustments') is not null, 'order_adjustments exists');
select pg_temp.assert_true(to_regclass('public.order_line_adjustments') is not null, 'order_line_adjustments exists');
select pg_temp.assert_true(to_regclass('public.promotion_redemptions') is not null, 'promotion_redemptions exists');
select pg_temp.assert_true(
  (select pg_get_userbyid(relowner) from pg_class where oid='public.promotions'::regclass)='promotions_writer',
  'promotions owned by promotions_writer');
select pg_temp.assert_true(
  (select relrowsecurity from pg_class where oid='public.promotions'::regclass),'RLS enabled on promotions');
select pg_temp.assert_true(
  exists(select 1 from information_schema.columns
   where table_name='orders' and column_name='gross_subtotal_minor'),
  'orders.gross_subtotal_minor column exists');

-- All promotions inserted inactive; each test activates only what it needs (evaluate sees active only).
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,target_type,activation_type,status) values
  ('a0000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001','Ten Percent','percentage',1000,'order','automatic','inactive');
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_amount_minor,benefit_currency,target_type,activation_type,status) values
  ('a0000000-0000-4000-8000-000000000020','10000000-0000-4000-8000-000000000001','Five Off','fixed_amount',500,'USD','order','automatic','inactive'),
  ('a0000000-0000-4000-8000-000000000021','10000000-0000-4000-8000-000000000001','Huge Off','fixed_amount',999999,'USD','order','automatic','inactive');
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,max_discount_minor,target_type,activation_type,status) values
  ('a0000000-0000-4000-8000-000000000030','10000000-0000-4000-8000-000000000001','Capped','percentage',5000,100,'order','automatic','inactive');
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,min_subtotal_minor,target_type,activation_type,status) values
  ('a0000000-0000-4000-8000-000000000040','10000000-0000-4000-8000-000000000001','Min Basket','percentage',1000,3000,'order','automatic','inactive');
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,target_type,activation_type,channel,status) values
  ('a0000000-0000-4000-8000-000000000050','10000000-0000-4000-8000-000000000001','POS Only','percentage',1000,'order','automatic','pos','inactive');
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,target_type,activation_type,brand_id,status) values
  ('a0000000-0000-4000-8000-000000000060','10000000-0000-4000-8000-000000000001','Brand A2','percentage',1000,'order','automatic','20000000-0000-4000-8000-000000000002','inactive');
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,target_type,activation_type,status) values
  ('a0000000-0000-4000-8000-000000000070','10000000-0000-4000-8000-000000000001','Variant Half','percentage',5000,'variant_scope','automatic','inactive');
insert into public.promotion_targets (tenant_id,promotion_id,variant_id) values
  ('10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000070','60000000-0000-4000-8000-000000000002');
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,target_type,activation_type,global_redemption_limit,status) values
  ('a0000000-0000-4000-8000-000000000080','10000000-0000-4000-8000-000000000001','One Only','percentage',1000,'order','automatic',1,'inactive');
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,target_type,activation_type,status) values
  ('a0000000-0000-4000-8000-000000000090','10000000-0000-4000-8000-000000000001','Coded 20','percentage',2000,'order','code','inactive'),
  ('a0000000-0000-4000-8000-000000000091','10000000-0000-4000-8000-000000000001','Auto 20','percentage',2000,'order','automatic','inactive');
insert into public.promotion_codes (id,tenant_id,promotion_id,code,max_redemptions,status) values
  ('c1000000-0000-4000-8000-000000000090','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000090','SAVE20',null,'active');
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,target_type,activation_type,status) values
  ('a0000000-0000-4000-8000-0000000000a0','10000000-0000-4000-8000-000000000001','Voucher Promo','percentage',1000,'order','code','inactive');
insert into public.promotion_codes (id,tenant_id,promotion_id,code,max_redemptions,status) values
  ('c1000000-0000-4000-8000-0000000000a0','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-0000000000a0','ONCE',1,'active');
-- Two equal-value automatics with distinct creation instants for the created_at tie-break.
insert into public.promotions (id,tenant_id,name,benefit_type,benefit_percent_bp,target_type,activation_type,status,created_at) values
  ('a0000000-0000-4000-8000-0000000000b1','10000000-0000-4000-8000-000000000001','Tie Early','percentage',1000,'order','automatic','inactive','2026-01-01T00:00:00Z'),
  ('a0000000-0000-4000-8000-0000000000b2','10000000-0000-4000-8000-000000000001','Tie Late','percentage',1000,'order','automatic','inactive','2026-06-01T00:00:00Z');

-- ============================ percentage floor + no-op ============================
select pg_temp.assert_true((pg_temp.eval_a((select j from lines1))->>'applied')::boolean = false,
  'no active promotion yields applied=false');

update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000010';
select pg_temp.assert_true(
  (pg_temp.eval_a((select j from lines1))->>'discountTotalMinor')::bigint = 259,
  'percentage 10% of 2599 floors to 259');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000010';

-- ============================ fixed clamp to subtotal ============================
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000021';
select pg_temp.assert_true(
  (pg_temp.eval_a((select j from lines1))->>'discountTotalMinor')::bigint = 2599,
  'fixed discount larger than basket clamps to subtotal 2599');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000021';

-- ============================ max discount cap ============================
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000030';
select pg_temp.assert_true(
  (pg_temp.eval_a((select j from lines1))->>'discountTotalMinor')::bigint = 100,
  'max_discount_minor caps 50% of 2599 at 100');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000030';

-- ============================ minimum basket gate ============================
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000040';
select pg_temp.assert_true((pg_temp.eval_a((select j from lines1))->>'applied')::boolean = false,
  'min_subtotal 3000 excludes a 2599 basket');
select pg_temp.assert_true((pg_temp.eval_a((select j from lines2))->>'applied')::boolean = true,
  'min_subtotal 3000 admits a 7599 basket');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000040';

-- ============================ channel + brand restriction ============================
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000050';
select pg_temp.assert_true((pg_temp.eval_a((select j from lines1))->>'applied')::boolean = false,
  'pos-only promotion excluded from online evaluation');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000050';
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000060';
select pg_temp.assert_true((pg_temp.eval_a((select j from lines1))->>'applied')::boolean = false,
  'brand-A2 promotion excluded from brand-A order');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000060';

-- ============================ window boundaries ============================
update public.promotions set status='active', starts_at='2999-01-01T00:00:00Z' where id='a0000000-0000-4000-8000-000000000010';
select pg_temp.assert_true((pg_temp.eval_a((select j from lines1))->>'applied')::boolean = false,
  'future starts_at excludes promotion');
update public.promotions set starts_at=null, ends_at='2000-01-01T00:00:00Z' where id='a0000000-0000-4000-8000-000000000010';
select pg_temp.assert_true((pg_temp.eval_a((select j from lines1))->>'applied')::boolean = false,
  'past ends_at excludes promotion');
update public.promotions set ends_at=null, status='inactive' where id='a0000000-0000-4000-8000-000000000010';

-- ============================ variant scope basis + allocation ============================
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000070';
select pg_temp.assert_true(
  (pg_temp.eval_a((select j from lines2))->>'eligibleBasisMinor')::bigint = 5000
  and (pg_temp.eval_a((select j from lines2))->>'discountTotalMinor')::bigint = 2500,
  'variant_scope 50% applies only to the PANTS line (basis 5000, discount 2500)');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000070';

-- ============================ largest-remainder allocation across lines ============================
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000010';
select pg_temp.assert_true(
  (select (a->>'discountMinor')::bigint from
     jsonb_array_elements(pg_temp.eval_a((select j from lines2))->'allocations') a where (a->>'ord')::int=1) = 260
  and (select (a->>'discountMinor')::bigint from
     jsonb_array_elements(pg_temp.eval_a((select j from lines2))->'allocations') a where (a->>'ord')::int=2) = 499,
  '10% of 7599 = 759 allocates 260 + 499 by largest remainder');
select pg_temp.assert_true(
  (select sum((a->>'discountMinor')::bigint) from
     jsonb_array_elements(pg_temp.eval_a((select j from lines2))->'allocations') a) = 759,
  'allocation reconciles exactly to the discount total');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000010';

-- ============================ best-eligible-saving selection ============================
update public.promotions set status='active' where id in
  ('a0000000-0000-4000-8000-000000000010','a0000000-0000-4000-8000-000000000020');
select pg_temp.assert_true(
  (pg_temp.eval_a((select j from lines1))->>'promotionId') = 'a0000000-0000-4000-8000-000000000020'
  and (pg_temp.eval_a((select j from lines1))->>'discountTotalMinor')::bigint = 500,
  'fixed 500 beats 10%/259 by greatest saving');
update public.promotions set status='inactive' where id in
  ('a0000000-0000-4000-8000-000000000010','a0000000-0000-4000-8000-000000000020');

-- ============================ tie-break: code beats automatic at equal saving ============================
update public.promotions set status='active' where id in
  ('a0000000-0000-4000-8000-000000000090','a0000000-0000-4000-8000-000000000091');
select pg_temp.assert_true(
  (pg_temp.eval_a((select j from lines1),'SAVE20')->>'promotionId') = 'a0000000-0000-4000-8000-000000000090'
  and (pg_temp.eval_a((select j from lines1),'SAVE20')->>'codeId') is not null,
  'equal 20% saving: entered code wins over automatic');
update public.promotions set status='inactive' where id in
  ('a0000000-0000-4000-8000-000000000090','a0000000-0000-4000-8000-000000000091');

-- ============================ tie-break: earlier created_at ============================
update public.promotions set status='active' where id in
  ('a0000000-0000-4000-8000-0000000000b1','a0000000-0000-4000-8000-0000000000b2');
select pg_temp.assert_true(
  (pg_temp.eval_a((select j from lines1))->>'promotionId') = 'a0000000-0000-4000-8000-0000000000b1',
  'equal automatic saving: earlier created_at wins');
update public.promotions set status='inactive' where id in
  ('a0000000-0000-4000-8000-0000000000b1','a0000000-0000-4000-8000-0000000000b2');

-- ============================ invalid code surfaced while nothing applies ============================
select pg_temp.assert_true(
  (pg_temp.eval_a((select j from lines1),'NOPE')->>'codeStatus') = 'invalid',
  'unknown entered code reported invalid');

-- ============================ redeem: accounting identity + snapshots + capacity ============================
create temp table o1 on commit drop as select orders_private.create_order(
  '10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',
  null,null,null,'redeem-1',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":1,"unit_price_minor":2599,"product_name":"Tee","sku":"TEE-M"},
    {"variant_id":"60000000-0000-4000-8000-000000000002","product_id":"30000000-0000-4000-8000-000000000002","quantity":1,"unit_price_minor":5000,"product_name":"Pants","sku":"PANTS-1"}]'::jsonb
) as id;
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000010';
select promotions_private.redeem('10000000-0000-4000-8000-000000000001',(select id from o1),null);

select pg_temp.assert_true(
  (select gross_subtotal_minor=7599 and discount_total_minor=759 and total_minor=6840
   from public.orders where id=(select id from o1)),
  'redeem sets gross/discount/net identity (7599-759=6840)');
select pg_temp.assert_true(
  (select count(*)=1 and max(discount_total_minor)=759 from public.order_adjustments where order_id=(select id from o1)),
  'redeem writes one order_adjustment');
select pg_temp.assert_true(
  (select sum(discount_minor)=759 from public.order_line_adjustments where order_id=(select id from o1)),
  'line adjustments sum to the discount total');
select pg_temp.assert_true(
  (select count(*)=1 from public.promotion_redemptions where order_id=(select id from o1)),
  'redeem records one immutable redemption');
select pg_temp.assert_true(
  (select redemption_count=1 from public.promotions where id='a0000000-0000-4000-8000-000000000010'),
  'redeem increments promotion redemption_count');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000010';

-- ============================ immutability of adjustments ============================
select pg_temp.assert_raises(
  format('update public.order_adjustments set discount_total_minor=0 where order_id=%L',(select id from o1)),
  '42501','order_adjustments are immutable');
select pg_temp.assert_raises(
  format('delete from public.order_line_adjustments where order_id=%L',(select id from o1)),
  '42501','order_line_adjustments are immutable');

-- ============================ NET refund-basis arithmetic (what Returns consumes) ============================
-- PANTS line: net_line = 5000-499 = 4501 across quantity 1 → whole-line refund is exactly the net 4501.
select pg_temp.assert_true(
  (select (l.line_total_minor - coalesce((select sum(a.discount_minor) from public.order_line_adjustments a
     where a.order_line_id=l.id),0))
   from public.order_lines l where l.order_id=(select id from o1) and l.variant_id='60000000-0000-4000-8000-000000000002') = 4501,
  'net refundable line basis = gross minus allocated discount (5000-499=4501)');

-- ============================ global usage limit exhaustion ============================
create temp table o2 on commit drop as select orders_private.create_order(
  '10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',
  null,null,null,'redeem-cap',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":1,"unit_price_minor":2599,"product_name":"Tee","sku":"TEE-M"}]'::jsonb
) as id;
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000080';
select promotions_private.redeem('10000000-0000-4000-8000-000000000001',(select id from o2),null);
select pg_temp.assert_true(
  (select redemption_count=1 from public.promotions where id='a0000000-0000-4000-8000-000000000080'),
  'capped promotion consumed once');
select pg_temp.assert_true((pg_temp.eval_a((select j from lines1))->>'applied')::boolean = false,
  'exhausted global limit excludes the promotion from further evaluation');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000080';

-- ============================ one-time voucher single use ============================
create temp table o3 on commit drop as select orders_private.create_order(
  '10000000-0000-4000-8000-000000000001','online','USD','20000000-0000-4000-8000-000000000001',
  null,null,null,'redeem-voucher',null,null,
  '[{"variant_id":"60000000-0000-4000-8000-000000000001","product_id":"30000000-0000-4000-8000-000000000001","quantity":1,"unit_price_minor":2599,"product_name":"Tee","sku":"TEE-M"}]'::jsonb
) as id;
update public.promotions set status='active' where id='a0000000-0000-4000-8000-0000000000a0';
select promotions_private.redeem('10000000-0000-4000-8000-000000000001',(select id from o3),'ONCE');
select pg_temp.assert_true(
  (select redemption_count=1 from public.promotion_codes where id='c1000000-0000-4000-8000-0000000000a0'),
  'voucher code consumed once');
select pg_temp.assert_true((pg_temp.eval_a((select j from lines1),'ONCE')->>'applied')::boolean = false,
  'single-use voucher not applicable after its one redemption');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-0000000000a0';

-- ============================ tenant isolation ============================
update public.promotions set status='active' where id='a0000000-0000-4000-8000-000000000091';
select pg_temp.assert_true(
  (promotions_private.evaluate('10000000-0000-4000-8000-000000000002','online','USD',
     '20000000-0000-4000-8000-00000000000b',null,(select j from lines1),'SAVE20')->>'applied')::boolean = false,
  'tenant B cannot evaluate tenant A promotions or codes');
update public.promotions set status='inactive' where id='a0000000-0000-4000-8000-000000000091';

-- ============================ management functions (migration 5) ============================
create temp table created on commit drop as select promotions_private.create_promotion(
  '10000000-0000-4000-8000-000000000001','mgmt-key-1',
  '{"name":"Managed","benefitType":"percentage","benefitPercentBp":1500,"targetType":"order","activationType":"code"}'::jsonb) as d;
select pg_temp.assert_true(
  (select (d->>'economicsLocked')::boolean = false and d->>'name'='Managed' from created),
  'create_promotion returns detail, economics unlocked before redemption');
select pg_temp.assert_true(
  (select promotions_private.create_promotion('10000000-0000-4000-8000-000000000001','mgmt-key-1','{}'::jsonb)->>'id'
    = (select d->>'id' from created)),
  'create_promotion is idempotent on creation key');
select promotions_private.create_code('10000000-0000-4000-8000-000000000001',(select (d->>'id')::uuid from created),
  '{"code":"managed10","maxRedemptions":5}'::jsonb);
select pg_temp.assert_true(
  (select jsonb_array_length(promotions_private.promotion_detail('10000000-0000-4000-8000-000000000001',(d->>'id')::uuid)->'codes')=1 from created),
  'create_code attaches a normalized code to the promotion');
select pg_temp.assert_true(
  (select promotions_private.update_promotion('10000000-0000-4000-8000-000000000001',(d->>'id')::uuid,'{"name":"Renamed"}'::jsonb)->>'name'='Renamed' from created),
  'update_promotion edits safe metadata');
select pg_temp.assert_true(
  (select promotions_private.set_promotion_status('10000000-0000-4000-8000-000000000001',(d->>'id')::uuid,'inactive')->>'status'='inactive' from created),
  'set_promotion_status deactivates');
-- Promotion a0..010 was redeemed earlier (redemption_count = 1); economic edits must be frozen.
select pg_temp.assert_raises(
  $$select promotions_private.update_promotion('10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000010','{"benefitPercentBp":2500}'::jsonb)$$,
  'PR423','economic edit rejected after first redemption');
select pg_temp.assert_true(
  (promotions_private.list_promotions('10000000-0000-4000-8000-000000000001',5,0)->>'total')::int >= 1,
  'list_promotions returns a paginated summary');

rollback;
