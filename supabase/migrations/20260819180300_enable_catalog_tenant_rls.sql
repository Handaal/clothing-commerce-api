-- Phase 2A: deny-by-default tenant RLS and grants for catalog persistence.
-- Permission-level catalog writes remain server-side application responsibilities.

alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.variant_barcodes enable row level security;
alter table public.product_options enable row level security;
alter table public.product_option_values enable row level security;
alter table public.variant_option_values enable row level security;
alter table public.categories enable row level security;
alter table public.product_categories enable row level security;
alter table public.collections enable row level security;
alter table public.product_collections enable row level security;
alter table public.variant_prices enable row level security;

create policy authenticated_tenant_read on public.products
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.product_variants
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.variant_barcodes
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.product_options
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.product_option_values
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.variant_option_values
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.categories
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.product_categories
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.collections
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.product_collections
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

create policy authenticated_tenant_read on public.variant_prices
for select to authenticated
using (
  tenant_id = (select commerce_context.current_tenant_id())
  and (select commerce_context.has_active_membership())
);

do $block$
declare
  table_name text;
  catalog_tables constant text[] := array[
    'products',
    'product_variants',
    'variant_barcodes',
    'product_options',
    'product_option_values',
    'variant_option_values',
    'categories',
    'product_categories',
    'collections',
    'product_collections',
    'variant_prices'
  ];
begin
  foreach table_name in array catalog_tables loop
    execute pg_catalog.format('revoke all privileges on table public.%I from public', table_name);
  end loop;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    foreach table_name in array catalog_tables loop
      execute pg_catalog.format('revoke all privileges on table public.%I from anon', table_name);
    end loop;
    execute 'revoke all on schema catalog_private from anon';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    foreach table_name in array catalog_tables loop
      execute pg_catalog.format('revoke all privileges on table public.%I from authenticated', table_name);
      execute pg_catalog.format('grant select on table public.%I to authenticated', table_name);
    end loop;
    execute 'revoke all on schema catalog_private from authenticated';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    foreach table_name in array catalog_tables loop
      execute pg_catalog.format(
        'grant select, insert, update, delete on table public.%I to service_role',
        table_name
      );
    end loop;
    execute 'grant usage on schema catalog_private to service_role';
    execute 'grant execute on all functions in schema catalog_private to service_role';
  end if;
end;
$block$;

comment on schema catalog_private is
  'Private catalog integrity functions; never exposed as a client API surface.';
