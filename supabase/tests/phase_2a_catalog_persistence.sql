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

create or replace function pg_temp.assert_deferred_raises(
  statement text,
  expected_state text,
  label text
)
returns void
language plpgsql
as $function$
declare
  actual_state text;
begin
  begin
    execute statement;
    execute 'set constraints all immediate';
  exception
    when others then
      get stacked diagnostics actual_state = returned_sqlstate;
  end;

  execute 'set constraints all deferred';

  if actual_state = expected_state then
    return;
  end if;

  if actual_state is null then
    raise exception 'assertion failed: %, expected SQLSTATE %, but deferred check succeeded',
      label, expected_state;
  end if;

  raise exception 'assertion failed: %, expected SQLSTATE %, received %',
    label, expected_state, actual_state;
end;
$function$;

select pg_temp.assert_true(
  (
    select count(*) = 11
    from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename = any (
        array[
          'products', 'product_variants', 'variant_barcodes', 'product_options',
          'product_option_values', 'variant_option_values', 'categories',
          'product_categories', 'collections', 'product_collections', 'variant_prices'
        ]
      )
  ),
  'all 11 Phase 2A catalog tables exist'
);

-- Orders arrived in Phase 2D and Payment in Phase 2H; promotion, publication, and media remain deferred.
select pg_temp.assert_true(
  to_regclass('public.payments') is not null
  and to_regclass('public.promotions') is null
  and to_regclass('public.product_publications') is null
  and to_regclass('public.media_assets') is null,
  'Payment exists while deferred promotion, publication, and media tables remain absent'
);

insert into public.tenants (id, slug, display_name, status, onboarding_state, default_currency)
values
  ('10000000-0000-4000-8000-000000000001', 'catalog-one', 'Catalog One', 'active', 'completed', 'USD'),
  ('10000000-0000-4000-8000-000000000002', 'catalog-two', 'Catalog Two', 'active', 'completed', 'EUR');

insert into public.brands (id, tenant_id, code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'MAIN', 'Main One'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'MAIN', 'Main Two');

insert into public.products (id, tenant_id, brand_id, name, slug, style_code, status)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'Classic Tee',
    'classic-tee',
    'TEE-001',
    'active'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'Gift Card',
    'gift-card',
    null,
    'draft'
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'Classic Tee',
    'classic-tee',
    'TEE-001',
    'active'
  );

select pg_temp.assert_true(
  (select normalized_style_code = 'tee-001' from public.products where id = '30000000-0000-4000-8000-000000000001'),
  'product style code normalization is deterministic'
);

select pg_temp.assert_raises(
  $test$insert into public.products (tenant_id, brand_id, name, slug)
    values ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'Wrong Brand', 'wrong-brand')$test$,
  '23503',
  'cross-tenant product brand is rejected'
);

select pg_temp.assert_raises(
  $test$insert into public.products (tenant_id, brand_id, name, slug)
    values ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Duplicate', ' CLASSIC-TEE ')$test$,
  '23505',
  'normalized product slug is unique for the tenant'
);

select pg_temp.assert_raises(
  $test$insert into public.products (tenant_id, brand_id, name, slug, style_code)
    values ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Duplicate Style', 'duplicate-style', ' tee-001 ')$test$,
  '23505',
  'normalized style code is lifecycle-wide and non-reusable within a tenant'
);

select pg_temp.assert_raises(
  $test$insert into public.products (tenant_id, brand_id, name, slug, status)
    values ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Bad Archive', 'bad-archive', 'archived')$test$,
  '23514',
  'archived product requires archive metadata'
);

insert into public.product_options (id, tenant_id, product_id, name, position)
values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Size', 0),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Color', 1),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 'Denomination', 0);

insert into public.product_option_values (id, tenant_id, product_id, option_id, display_value, position)
values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Small', 0),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Medium', 1),
  ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'Red', 0),
  ('50000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003', '25 USD', 0);

select pg_temp.assert_raises(
  $test$insert into public.product_options (tenant_id, product_id, name)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', ' size ')$test$,
  '23505',
  'duplicate normalized option name is rejected per product'
);

select pg_temp.assert_raises(
  $test$insert into public.product_option_values (tenant_id, product_id, option_id, display_value)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', ' SMALL ')$test$,
  '23505',
  'duplicate normalized option value is rejected per option'
);

insert into public.product_variants (
  id, tenant_id, product_id, sku, display_name, option_signature, status
)
values
  (
    '60000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'TEE-S-RED',
    'Small / Red',
    '50000000-0000-4000-8000-000000000001,50000000-0000-4000-8000-000000000003',
    'active'
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002',
    'GIFT-DEFAULT',
    'Default',
    'default',
    'draft'
  ),
  (
    '60000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000003',
    'TEE-S-RED',
    'Small / Red',
    'default',
    'active'
  );

insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003');

set constraints all immediate;
set constraints all deferred;

select pg_temp.assert_true(
  (select normalized_sku = 'tee-s-red' from public.product_variants where id = '60000000-0000-4000-8000-000000000001'),
  'SKU normalization is deterministic'
);

select pg_temp.assert_true(
  (select count(*) = 2 from public.product_variants where normalized_sku = 'tee-s-red'),
  'the same normalized SKU is allowed in different tenants'
);

select pg_temp.assert_raises(
  $test$insert into public.product_variants (tenant_id, product_id, sku, option_signature)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', ' tee-s-red ', '50000000-0000-4000-8000-000000000004')$test$,
  '23505',
  'normalized SKU is unique tenant-wide and across lifecycle states'
);

select pg_temp.assert_raises(
  $test$insert into public.product_variants (tenant_id, product_id, sku)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'CROSS-TENANT')$test$,
  '23503',
  'cross-tenant product variant is rejected'
);

select pg_temp.assert_raises(
  $test$insert into public.product_variants (tenant_id, product_id, sku, option_signature)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'TEE-S-RED-COPY', '50000000-0000-4000-8000-000000000001,50000000-0000-4000-8000-000000000003')$test$,
  '23505',
  'duplicate logical variant option combination is rejected'
);

select pg_temp.assert_deferred_raises(
  $test$update public.product_variants set option_signature = 'default'
    where id = '60000000-0000-4000-8000-000000000001'$test$,
  '23514',
  'variant option signature must match its relational selections'
);

insert into public.product_variants (id, tenant_id, product_id, sku, option_signature)
values
  ('60000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'MOVE-SOURCE', '50000000-0000-4000-8000-000000000002'),
  ('60000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'MOVE-TARGET', '50000000-0000-4000-8000-000000000003');

insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003');

set constraints all immediate;
set constraints all deferred;

select pg_temp.assert_deferred_raises(
  $test$do $move$
    begin
      update public.product_variants
      set option_signature = '50000000-0000-4000-8000-000000000002,50000000-0000-4000-8000-000000000003'
      where id = '60000000-0000-4000-8000-000000000005';

      update public.variant_option_values
      set variant_id = '60000000-0000-4000-8000-000000000005'
      where variant_id = '60000000-0000-4000-8000-000000000004';
    end;
  $move$$test$,
  '23514',
  'moving a selection also validates the source variant signature'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002')$test$,
  '23505',
  'variant cannot select two values for one option'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000004')$test$,
  '23503',
  'cross-product option selection is rejected'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
    values ('10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001')$test$,
  '23503',
  'cross-tenant variant option relationship is rejected'
);

-- Optionless product: exactly one canonical 'default' variant is allowed.
insert into public.products (id, tenant_id, brand_id, name, slug, status)
values ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Solo Product', 'solo-product', 'draft');

insert into public.product_variants (id, tenant_id, product_id, sku, option_signature)
values ('62000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000004', 'SOLO-1', 'default');

set constraints all immediate;
set constraints all deferred;

select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.product_variants
    where product_id = '30000000-0000-4000-8000-000000000004' and option_signature = 'default'
  ),
  'a product without options supports exactly one default variant'
);

select pg_temp.assert_raises(
  $test$insert into public.product_variants (tenant_id, product_id, sku, option_signature)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000004', 'SOLO-2', 'default')$test$,
  '23505',
  'a second default variant for the same product is rejected by canonical signature uniqueness'
);

-- Lifecycle-wide reservation: an archived combination stays bound to its original variant identity.
insert into public.products (id, tenant_id, brand_id, name, slug, status)
values ('30000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Combo Product', 'combo-product', 'draft');

insert into public.product_options (id, tenant_id, product_id, name)
values ('41000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000005', 'Size');

insert into public.product_option_values (id, tenant_id, product_id, option_id, display_value)
values ('51000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000005', '41000000-0000-4000-8000-000000000001', 'Small');

insert into public.product_variants (id, tenant_id, product_id, sku, option_signature, status)
values ('62000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000005', 'COMBO-S', '51000000-0000-4000-8000-000000000001', 'active');

insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000005', '62000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001');

set constraints all immediate;
set constraints all deferred;

update public.product_variants
set status = 'archived', archived_at = now(), archive_reason = 'Combination retention test'
where id = '62000000-0000-4000-8000-000000000002';

-- Reintroducing Small must reuse the original variant identity later; a new duplicate is rejected now.
select pg_temp.assert_raises(
  $test$insert into public.product_variants (tenant_id, product_id, sku, option_signature)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000005', 'COMBO-S-REDO', '51000000-0000-4000-8000-000000000001')$test$,
  '23505',
  'an archived option combination stays reserved to its original variant identity across the whole lifecycle'
);

-- Partial option coverage: a draft variant may select some but not all options.
insert into public.products (id, tenant_id, brand_id, name, slug, status)
values ('30000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Partial Product', 'partial-product', 'draft');

insert into public.product_options (id, tenant_id, product_id, name, position)
values
  ('41000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000006', 'Size', 0),
  ('41000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000006', 'Color', 1);

insert into public.product_option_values (id, tenant_id, product_id, option_id, display_value)
values
  ('51000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000006', '41000000-0000-4000-8000-000000000002', 'Small'),
  ('51000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000006', '41000000-0000-4000-8000-000000000003', 'Red');

insert into public.product_variants (id, tenant_id, product_id, sku, option_signature, status)
values ('62000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000006', 'PARTIAL-S', '51000000-0000-4000-8000-000000000002', 'draft');

insert into public.variant_option_values (tenant_id, product_id, variant_id, option_id, option_value_id)
values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000006', '62000000-0000-4000-8000-000000000003', '41000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002');

set constraints all immediate;
set constraints all deferred;

select pg_temp.assert_true(
  (
    select option_signature = '51000000-0000-4000-8000-000000000002'
    from public.product_variants
    where id = '62000000-0000-4000-8000-000000000003'
  ),
  'a draft variant may cover only some options; the database enforces selection consistency, not option completeness'
);

update public.product_variants
set status = 'archived', archived_at = now(), archive_reason = 'Identity retention test'
where id = '60000000-0000-4000-8000-000000000002';

select pg_temp.assert_raises(
  $test$insert into public.product_variants (tenant_id, product_id, sku, option_signature)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', ' gift-default ', '50000000-0000-4000-8000-000000000002')$test$,
  '23505',
  'archived SKU cannot be reused within the tenant'
);

insert into public.variant_barcodes (id, tenant_id, variant_id, value, barcode_type, is_primary)
values
  ('70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', '0123456789012', 'ean13', true),
  ('70000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'TEE-S-RED-ALT', 'code128', false),
  ('70000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000003', '0123456789012', 'ean13', true);

select pg_temp.assert_true(
  (select count(*) = 2 from public.variant_barcodes where variant_id = '60000000-0000-4000-8000-000000000001'),
  'a variant may own multiple barcodes'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_barcodes (tenant_id, variant_id, value)
    values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002', ' 0123456789012 ')$test$,
  '23505',
  'normalized barcode is tenant-wide and lifecycle-non-reusable'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_barcodes (tenant_id, variant_id, value, is_primary)
    values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'ANOTHER-PRIMARY', true)$test$,
  '23505',
  'variant has at most one active primary barcode'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_barcodes (tenant_id, variant_id, value)
    values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000003', 'CROSS-BARCODE')$test$,
  '23503',
  'cross-tenant barcode association is rejected'
);

select pg_temp.assert_raises(
  $test$update public.variant_barcodes set is_primary = true
    where id = '70000000-0000-4000-8000-000000000002'$test$,
  '23505',
  'promoting a second active barcode to primary through UPDATE is rejected'
);

insert into public.categories (id, tenant_id, name, slug, position)
values
  ('80000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Clothing', 'clothing', 0),
  ('80000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Tops', 'tops', 0),
  ('80000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'Clothing', 'clothing', 0);

update public.categories
set parent_category_id = '80000000-0000-4000-8000-000000000001'
where id = '80000000-0000-4000-8000-000000000002';

select pg_temp.assert_true(
  (select parent_category_id = '80000000-0000-4000-8000-000000000001' from public.categories where id = '80000000-0000-4000-8000-000000000002'),
  'same-tenant category hierarchy is accepted'
);

select pg_temp.assert_raises(
  $test$update public.categories set parent_category_id = '80000000-0000-4000-8000-000000000002'
    where id = '80000000-0000-4000-8000-000000000001'$test$,
  '23514',
  'multi-node category cycle is rejected'
);

select pg_temp.assert_raises(
  $test$update public.categories set parent_category_id = '80000000-0000-4000-8000-000000000001'
    where id = '80000000-0000-4000-8000-000000000001'$test$,
  '23514',
  'category cannot parent itself'
);

select pg_temp.assert_raises(
  $test$update public.categories set parent_category_id = '80000000-0000-4000-8000-000000000003'
    where id = '80000000-0000-4000-8000-000000000002'$test$,
  '23503',
  'cross-tenant category parent is rejected'
);

insert into public.product_categories (tenant_id, product_id, category_id)
values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002');

select pg_temp.assert_true(
  (select count(*) = 2 from public.product_categories where product_id = '30000000-0000-4000-8000-000000000001'),
  'product may belong to multiple categories'
);

select pg_temp.assert_raises(
  $test$insert into public.product_categories (tenant_id, product_id, category_id)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001')$test$,
  '23505',
  'duplicate product-category membership is rejected'
);

select pg_temp.assert_raises(
  $test$insert into public.product_categories (tenant_id, product_id, category_id)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000003')$test$,
  '23503',
  'cross-tenant product-category association is rejected'
);

insert into public.collections (id, tenant_id, name, slug, status)
values
  ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Summer', 'summer', 'active'),
  ('90000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Summer', 'summer', 'active');

insert into public.product_collections (tenant_id, product_id, collection_id, position)
values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 10);

select pg_temp.assert_true(
  (select position = 10 from public.product_collections where product_id = '30000000-0000-4000-8000-000000000001'),
  'manual collection membership preserves explicit ordering'
);

select pg_temp.assert_raises(
  $test$insert into public.product_collections (tenant_id, product_id, collection_id)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001')$test$,
  '23505',
  'duplicate product-collection membership is rejected'
);

select pg_temp.assert_raises(
  $test$insert into public.product_collections (tenant_id, product_id, collection_id)
    values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002')$test$,
  '23503',
  'cross-tenant product-collection association is rejected'
);

insert into public.variant_prices (id, tenant_id, variant_id, currency, amount_minor)
values
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'USD', 2599),
  ('a0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000003', 'EUR', 2399);

select pg_temp.assert_true(
  (select amount_minor = 2599 from public.variant_prices where id = 'a0000000-0000-4000-8000-000000000001'),
  'variant base price persists integer minor units and explicit currency'
);

insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor)
values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'GBP', 0);

select pg_temp.assert_true(
  (select amount_minor = 0 from public.variant_prices where variant_id = '60000000-0000-4000-8000-000000000001' and currency = 'GBP'),
  'zero is an accepted nonnegative base price'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor)
    values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'usd', 100)$test$,
  '23514',
  'price currency must be uppercase ISO-shaped text'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor)
    values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'EUR', -1)$test$,
  '23514',
  'negative variant price is rejected'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor)
    values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'USD', 2699)$test$,
  '23505',
  'only one active base price exists per variant and currency'
);

update public.variant_prices
set status = 'archived', archived_at = now(), archive_reason = 'Superseded'
where id = 'a0000000-0000-4000-8000-000000000001';

insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor)
values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'USD', 2699);

select pg_temp.assert_true(
  (
    select count(*) = 2 and count(*) filter (where status = 'active') = 1
    from public.variant_prices
    where variant_id = '60000000-0000-4000-8000-000000000001' and currency = 'USD'
  ),
  'price replacement retains history and exactly one active base price'
);

select pg_temp.assert_raises(
  $test$insert into public.variant_prices (tenant_id, variant_id, currency, amount_minor)
    values ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000003', 'USD', 1)$test$,
  '23503',
  'cross-tenant variant price is rejected'
);

select pg_temp.assert_raises(
  $test$delete from public.products where id = '30000000-0000-4000-8000-000000000001'$test$,
  '23503',
  'product hard delete is restricted while catalog history depends on it'
);

rollback;

\echo 'Phase 2A catalog persistence invariants passed.'
