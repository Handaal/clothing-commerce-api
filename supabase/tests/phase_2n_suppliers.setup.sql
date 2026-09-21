-- Disposable fixture only; migrations never assign Supplier permissions to roles.
insert into public.permissions(key,description) values ('inventory.adjust','Adjust inventory'),('inventory.transfer','Transfer inventory') on conflict(key) do nothing;
insert into public.role_permissions(tenant_id,role_id,permission_id)
select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000013-0000-4000-8000-000000000001'::uuid,id
from public.permissions where key in ('suppliers.read','suppliers.manage','inventory.read','inventory.adjust','inventory.transfer') on conflict do nothing;
insert into public.role_permissions(tenant_id,role_id,permission_id)
select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000013-0000-4000-8000-000000000003'::uuid,id
from public.permissions where key in ('suppliers.read','suppliers.manage','inventory.receive','inventory.read') on conflict do nothing;
insert into public.suppliers(id,tenant_id,name,code) values
 ('2a000020-0000-4000-8000-000000000001','2a000001-0000-4000-8000-000000000001','Fixture Supplier','FIXTURE'),
 ('2a000020-0000-4000-8000-000000000002','2a000001-0000-4000-8000-000000000002','Foreign Supplier','FOREIGN');
update public.inventory_locations set is_receiving_enabled=true, is_transfer_origin_enabled=true,is_transfer_destination_enabled=true
where tenant_id='2a000001-0000-4000-8000-000000000001';
