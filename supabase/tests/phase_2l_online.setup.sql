-- Runs after the existing POS fixture in a disposable local database. COD enabled only in this fixture.
update public.inventory_locations set is_sellable=true where id='2a000004-0000-4000-8000-000000000001';
insert into public.storefront_checkout_settings(tenant_id,brand_id,inventory_location_id,currency,cod_enabled)
values('2a000001-0000-4000-8000-000000000001','2a000002-0000-4000-8000-000000000001','2a000004-0000-4000-8000-000000000001','USD',true);
-- Same-tenant wrong brand and a fully configured foreign tenant for negative containment tests.
insert into public.brands(id,tenant_id,code,display_name) values
('2a000002-0000-4000-8000-000000000002','2a000001-0000-4000-8000-000000000001','other','Other brand'),
('2a000002-0000-4000-8000-000000000003','2a000001-0000-4000-8000-000000000002','foreign','Foreign brand');
insert into public.storefront_checkout_settings(tenant_id,brand_id,inventory_location_id,currency,cod_enabled)
values('2a000001-0000-4000-8000-000000000001','2a000002-0000-4000-8000-000000000002','2a000004-0000-4000-8000-000000000001','USD',true);
set role service_role;
select * from catalog_private.publish_product('2a000001-0000-4000-8000-000000000001','2a000006-0000-4000-8000-000000000001','online-publish');
reset role;
