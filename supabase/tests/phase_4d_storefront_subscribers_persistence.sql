-- Phase 3 (Storefront program): storefront email sign-ups.
-- Runs on a disposable database AFTER phase_2h_pos_sale.setup.sql + phase_2l_online.setup.sql
-- (tenant ...1-...0001 active, brand ...2-...0001).
\set ON_ERROR_STOP on

-- 1. Privileges ----------------------------------------------------------------------------------------
do $b$ begin
  assert not has_table_privilege('anon', 'public.storefront_subscribers', 'select')
     and not has_table_privilege('authenticated', 'public.storefront_subscribers', 'select')
     and not has_table_privilege('service_role', 'public.storefront_subscribers', 'insert')
     and has_table_privilege('service_role', 'public.storefront_subscribers', 'select'),
    'P1 shoppers cannot read the list and the server can only write through the function';
  assert has_function_privilege('service_role', 'online_private.subscribe_storefront_email(uuid,uuid,text,text)', 'execute')
     and not has_function_privilege('anon', 'online_private.subscribe_storefront_email(uuid,uuid,text,text)', 'execute'),
    'P2 only the server signs people up';
end $b$;

-- 2. Sign-up, case-insensitive de-duplication ------------------------------------------------------------
set role service_role;
select online_private.subscribe_storefront_email('2a000001-0000-4000-8000-000000000001',
  '2a000002-0000-4000-8000-000000000001', 'Fan@Example.com', 'home') as first_time;
select online_private.subscribe_storefront_email('2a000001-0000-4000-8000-000000000001',
  null, ' fan@example.COM', 'footer') as second_time;
reset role;
do $b$ begin
  assert (select count(*) = 1 from public.storefront_subscribers
           where tenant_id = '2a000001-0000-4000-8000-000000000001'),
    'S1 one row per address per tenant';
  assert (select source = 'home' and brand_id = '2a000002-0000-4000-8000-000000000001'
            from public.storefront_subscribers where normalized_email = 'fan@example.com'),
    'S2 the first sign-up is kept';
  assert online_private.subscribe_storefront_email('2a000001-0000-4000-8000-000000000001',
    null, 'fan@example.com', 'home') = false, 'S3 repeat reports not-new';
end $b$;

-- 3. Rejections -------------------------------------------------------------------------------------------
do $b$ begin
  begin
    perform online_private.subscribe_storefront_email(gen_random_uuid(), null, 'x@y.co', 'home');
    raise exception 'R1 expected MK001';
  exception when sqlstate 'MK001' then null; end;
  begin
    perform online_private.subscribe_storefront_email('2a000001-0000-4000-8000-000000000001',
      gen_random_uuid(), 'x@y.co', 'home');
    raise exception 'R2 expected MK001';
  exception when sqlstate 'MK001' then null; end;
  begin
    perform online_private.subscribe_storefront_email('2a000001-0000-4000-8000-000000000001',
      null, 'not-an-email', 'home');
    raise exception 'R3 expected check violation';
  exception when check_violation then null; end;
  begin
    perform online_private.subscribe_storefront_email('2a000001-0000-4000-8000-000000000001',
      null, 'ok@example.com', 'Bad Source!');
    raise exception 'R4 expected check violation';
  exception when check_violation then null; end;
end $b$;

select 'ALL_STOREFRONT_SUBSCRIBER_ASSERTIONS_PASSED' as result;
