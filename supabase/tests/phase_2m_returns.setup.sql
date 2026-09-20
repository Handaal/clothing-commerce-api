-- Disposable acceptance policy only. Production tenants remain disabled.
insert into public.return_settings(tenant_id,enabled,window_days,manual_refunds_enabled)
values('2a000001-0000-4000-8000-000000000001',true,30,true);
insert into public.role_permissions(tenant_id,role_id,permission_id)
select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000013-0000-4000-8000-000000000001'::uuid,id
from public.permissions where key in ('returns.create','returns.read','payments.refund','inventory.receive');
