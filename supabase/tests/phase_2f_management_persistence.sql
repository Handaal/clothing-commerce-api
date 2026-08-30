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

-- ============================ catalog.read permission seed ============================

select pg_temp.assert_true(
  (select count(*) = 1 from public.permissions where key = 'catalog.read' and status = 'active'),
  'the catalog.read permission is seeded and active'
);

select pg_temp.assert_true(
  (select count(*) = 0
   from public.role_permissions rp
   join public.permissions p on p.id = rp.permission_id
   where p.key = 'catalog.read'),
  'catalog.read is granted to no role by the migration (provisioning is not assignment)'
);

-- ============================ management list indexes ============================

select pg_temp.assert_true(
  (select pg_get_indexdef(oid) like '%(tenant_id, created_at DESC, id DESC)'
   from pg_class where relname = 'products_tenant_created_id_idx'),
  'products_tenant_created_id_idx covers (tenant_id, created_at DESC, id DESC)'
);

select pg_temp.assert_true(
  (select pg_get_indexdef(oid) like '%(tenant_id, inventory_location_id, variant_id)'
   from pg_class where relname = 'inventory_balances_tenant_location_variant_idx'),
  'inventory_balances_tenant_location_variant_idx covers (tenant_id, inventory_location_id, variant_id)'
);

select pg_temp.assert_true(
  (select pg_get_indexdef(oid) like '%(tenant_id, placed_at DESC, id DESC)'
   from pg_class where relname = 'orders_tenant_placed_id_idx'),
  'orders_tenant_placed_id_idx covers (tenant_id, placed_at DESC, id DESC)'
);

rollback;
