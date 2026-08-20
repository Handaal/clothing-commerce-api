begin;

create extension if not exists pgtap with schema extensions;

select plan(43);

create or replace function pg_temp.statement_raises(statement text, expected_state text)
returns boolean
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
      return actual_state = expected_state;
  end;

  return false;
end;
$function$;

create or replace function pg_temp.statement_affects_zero(statement text)
returns boolean
language plpgsql
as $function$
declare
  affected_rows bigint;
begin
  execute statement;
  get diagnostics affected_rows = row_count;
  return affected_rows = 0;
exception
  when others then
    return false;
end;
$function$;

-- Policy, helper, and grant structure.
select is(
  (
    select count(*)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relrowsecurity
      and relation.relname = any (
        array[
          'products', 'product_variants', 'variant_barcodes', 'product_options',
          'product_option_values', 'variant_option_values', 'categories',
          'product_categories', 'collections', 'product_collections', 'variant_prices'
        ]
      )
  ),
  11::bigint,
  'RLS is enabled on all 11 catalog tables'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relforcerowsecurity
      and relation.relname = any (
        array[
          'products', 'product_variants', 'variant_barcodes', 'product_options',
          'product_option_values', 'variant_option_values', 'categories',
          'product_categories', 'collections', 'product_collections', 'variant_prices'
        ]
      )
  ),
  0::bigint,
  'catalog RLS is intentionally not forced for owners and bypass roles'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and tablename = any (
        array[
          'products', 'product_variants', 'variant_barcodes', 'product_options',
          'product_option_values', 'variant_option_values', 'categories',
          'product_categories', 'collections', 'product_collections', 'variant_prices'
        ]
      )
  ),
  11::bigint,
  'all catalog tables have one authenticated SELECT policy'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and cmd <> 'SELECT'
      and tablename = any (
        array[
          'products', 'product_variants', 'variant_barcodes', 'product_options',
          'product_option_values', 'variant_option_values', 'categories',
          'product_categories', 'collections', 'product_collections', 'variant_prices'
        ]
      )
  ),
  0::bigint,
  'catalog exposes no authenticated mutation policy'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'catalog_private'
      and not procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
  ),
  3::bigint,
  'all catalog integrity helpers are SECURITY INVOKER with an empty fixed search_path'
);

select ok(
  not has_schema_privilege('public', 'catalog_private', 'USAGE'),
  'PUBLIC cannot use the private catalog schema'
);

select ok(
  not has_schema_privilege('anon', 'catalog_private', 'USAGE'),
  'anon cannot use the private catalog schema'
);

select ok(
  not has_schema_privilege('authenticated', 'catalog_private', 'USAGE'),
  'authenticated cannot use the private catalog schema'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'catalog_private'
      and has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
  ),
  0::bigint,
  'authenticated cannot execute catalog integrity helpers directly'
);

select is(
  (
    select count(*)
    from unnest(
      array[
        'products', 'product_variants', 'variant_barcodes', 'product_options',
        'product_option_values', 'variant_option_values', 'categories',
        'product_categories', 'collections', 'product_collections', 'variant_prices'
      ]
    ) as table_name
    where has_table_privilege('anon', format('public.%I', table_name), 'SELECT')
       or has_table_privilege('anon', format('public.%I', table_name), 'INSERT')
       or has_table_privilege('anon', format('public.%I', table_name), 'UPDATE')
       or has_table_privilege('anon', format('public.%I', table_name), 'DELETE')
  ),
  0::bigint,
  'anon has no catalog table privileges'
);

select is(
  (
    select count(*)
    from unnest(
      array[
        'products', 'product_variants', 'variant_barcodes', 'product_options',
        'product_option_values', 'variant_option_values', 'categories',
        'product_categories', 'collections', 'product_collections', 'variant_prices'
      ]
    ) as table_name
    where has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT')
      and not has_table_privilege('authenticated', format('public.%I', table_name), 'INSERT')
      and not has_table_privilege('authenticated', format('public.%I', table_name), 'UPDATE')
      and not has_table_privilege('authenticated', format('public.%I', table_name), 'DELETE')
  ),
  11::bigint,
  'authenticated has read-only grants on all catalog tables'
);

select is(
  (
    select count(*)
    from unnest(
      array[
        'products', 'product_variants', 'variant_barcodes', 'product_options',
        'product_option_values', 'variant_option_values', 'categories',
        'product_categories', 'collections', 'product_collections', 'variant_prices'
      ]
    ) as table_name
    where has_table_privilege('service_role', format('public.%I', table_name), 'SELECT')
      and has_table_privilege('service_role', format('public.%I', table_name), 'INSERT')
      and has_table_privilege('service_role', format('public.%I', table_name), 'UPDATE')
      and has_table_privilege('service_role', format('public.%I', table_name), 'DELETE')
  ),
  11::bigint,
  'service_role has intentional DML grants on all catalog tables'
);

-- Privileged fixtures: one complete catalog graph per tenant.
insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('10000000-0000-4000-8000-000000000001', 'catalog-rls-a', 'Catalog RLS A', 'active', 'completed', 'USD'),
  ('10000000-0000-4000-8000-000000000002', 'catalog-rls-b', 'Catalog RLS B', 'active', 'completed', 'EUR');

insert into public.user_identities (id, display_name, primary_email)
values
  ('70000000-0000-4000-8000-000000000001', 'Active Catalog User', 'active-catalog@example.test'),
  ('70000000-0000-4000-8000-000000000002', 'Suspended Catalog User', 'suspended-catalog@example.test');

insert into public.memberships (
  id, tenant_id, user_identity_id, status, invited_at, activated_at, suspended_at
)
values
  ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'active', now(), now(), null),
  ('71000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'active', now(), now(), null),
  ('71000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002', 'suspended', now(), now(), now());

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'Brand A'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'B', 'Brand B');

insert into public.products (id, tenant_id, brand_id, name, slug, status)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Product A', 'product-a', 'active'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Product B', 'product-b', 'active');

insert into public.product_options (id, tenant_id, product_id, name)
values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Size'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'Size');

insert into public.product_option_values (id, tenant_id, product_id, option_id, display_value)
values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Small'),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 'Small');

insert into public.product_variants (id, tenant_id, product_id, sku, option_signature, status)
values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'SKU-A', '50000000-0000-4000-8000-000000000001', 'active'),
  ('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'SKU-B', '50000000-0000-4000-8000-000000000002', 'active');

insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002');

set constraints all immediate;
set constraints all deferred;

insert into public.variant_barcodes (id, tenant_id, variant_id, value, is_primary)
values
  ('61000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'BARCODE-A', true),
  ('61000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', 'BARCODE-B', true);

insert into public.categories (id, tenant_id, name, slug)
values
  ('80000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Category A', 'category-a'),
  ('80000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Category B', 'category-b');

insert into public.product_categories (tenant_id, product_id, category_id)
values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000002');

insert into public.collections (id, tenant_id, name, slug, status)
values
  ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Collection A', 'collection-a', 'active'),
  ('90000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Collection B', 'collection-b', 'active');

insert into public.product_collections (tenant_id, product_id, collection_id)
values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000002');

insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor)
values
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'USD', 1000),
  ('a0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', 'EUR', 900);

-- Transaction-local grants let the tests prove that RLS itself denies every client mutation.
grant insert, update, delete on
  public.products,
  public.product_variants,
  public.variant_barcodes,
  public.product_options,
  public.product_option_values,
  public.variant_option_values,
  public.categories,
  public.product_categories,
  public.collections,
  public.product_collections,
  public.variant_prices
to authenticated;

set local role authenticated;
set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000001"}';

-- Each query has two physical fixture rows, so count=1 proves same-tenant visibility and foreign-row hiding.
select is((select count(*) from public.products), 1::bigint, 'active member reads only own products');
select is((select count(*) from public.product_variants), 1::bigint, 'active member reads only own variants');
select is((select count(*) from public.variant_barcodes), 1::bigint, 'active member reads only own barcodes');
select is((select count(*) from public.product_options), 1::bigint, 'active member reads only own product options');
select is((select count(*) from public.product_option_values), 1::bigint, 'active member reads only own option values');
select is((select count(*) from public.variant_option_values), 1::bigint, 'active member reads only own variant selections');
select is((select count(*) from public.categories), 1::bigint, 'active member reads only own categories');
select is((select count(*) from public.product_categories), 1::bigint, 'active member reads only own product-category links');
select is((select count(*) from public.collections), 1::bigint, 'active member reads only own collections');
select is((select count(*) from public.product_collections), 1::bigint, 'active member reads only own product-collection links');
select is((select count(*) from public.variant_prices), 1::bigint, 'active member reads only own variant prices');

select is(
  (select count(*) from public.products where id = '30000000-0000-4000-8000-000000000002'),
  0::bigint,
  'known foreign product UUID does not bypass RLS'
);

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000002"}';
select is((select count(*) from public.products), 1::bigint, 'same user can select the explicitly claimed second tenant');
select is(
  (select count(*) from public.products where id = '30000000-0000-4000-8000-000000000001'),
  0::bigint,
  'switching tenant hides the previously visible product'
);

set local "request.jwt.claims" = '';
select is((select count(*) from public.products), 0::bigint, 'missing claims fail closed for catalog reads');

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000002","tenant_id":"10000000-0000-4000-8000-000000000001"}';
select is((select count(*) from public.products), 0::bigint, 'suspended membership fails closed for catalog reads');

set local "request.jwt.claims" = '{"user_identity_id":"70000000-0000-4000-8000-000000000001","tenant_id":"10000000-0000-4000-8000-000000000001"}';
select ok(
  (
    select count(*) = 11
    from unnest(
      array[
        'products', 'product_variants', 'variant_barcodes', 'product_options',
        'product_option_values', 'variant_option_values', 'categories',
        'product_categories', 'collections', 'product_collections', 'variant_prices'
      ]
    ) as table_name
    where pg_temp.statement_raises(
      format(
        'insert into public.%I (tenant_id) values (%L)',
        table_name,
        '10000000-0000-4000-8000-000000000001'
      ),
      '42501'
    )
  ),
  'authenticated INSERT is denied by RLS on every catalog table'
);
select ok(
  (
    select count(*) = 11
    from unnest(
      array[
        'products', 'product_variants', 'variant_barcodes', 'product_options',
        'product_option_values', 'variant_option_values', 'categories',
        'product_categories', 'collections', 'product_collections', 'variant_prices'
      ]
    ) as table_name
    where pg_temp.statement_affects_zero(
      format('update public.%I set tenant_id = tenant_id', table_name)
    )
  ),
  'authenticated UPDATE affects no rows on every catalog table'
);
select ok(
  (
    select count(*) = 11
    from unnest(
      array[
        'products', 'product_variants', 'variant_barcodes', 'product_options',
        'product_option_values', 'variant_option_values', 'categories',
        'product_categories', 'collections', 'product_collections', 'variant_prices'
      ]
    ) as table_name
    where pg_temp.statement_affects_zero(format('delete from public.%I', table_name))
  ),
  'authenticated DELETE affects no rows on every catalog table'
);

reset role;
set local role service_role;
select is((select count(*) from public.products), 2::bigint, 'service_role reads all products');
select is((select count(*) from public.product_variants), 2::bigint, 'service_role reads all variants');
select is((select count(*) from public.variant_barcodes), 2::bigint, 'service_role reads all barcodes');
select is((select count(*) from public.product_options), 2::bigint, 'service_role reads all product options');
select is((select count(*) from public.product_option_values), 2::bigint, 'service_role reads all option values');
select is((select count(*) from public.variant_option_values), 2::bigint, 'service_role reads all variant selections');
select is((select count(*) from public.categories), 2::bigint, 'service_role reads all categories');
select is((select count(*) from public.product_categories), 2::bigint, 'service_role reads all product-category links');
select is((select count(*) from public.collections), 2::bigint, 'service_role reads all collections');
select is((select count(*) from public.product_collections), 2::bigint, 'service_role reads all product-collection links');
select is((select count(*) from public.variant_prices), 2::bigint, 'service_role reads all variant prices');

reset role;
set local role anon;
select ok(
  pg_temp.statement_raises('select count(*) from public.products', '42501'),
  'anon cannot turn claim-shaped text into catalog table access'
);

reset role;
select * from finish();
rollback;
