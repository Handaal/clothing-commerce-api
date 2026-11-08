-- Applied after phase_2h_pos_sale.setup.sql by the Phase 2I integration runner only.
update public.registers
set code = 'OFFLINE-2',
    display_name = 'Offline Two',
    status = 'active',
    default_inventory_location_id = '2a000004-0000-4000-8000-000000000001',
    selling_currency = 'USD'
where id = '2a000005-0000-4000-8000-000000000002';

insert into public.registers(id,tenant_id,branch_id,code,display_name,status,default_inventory_location_id,selling_currency)
values
('2a000005-0000-4000-8000-000000000003','2a000001-0000-4000-8000-000000000001','2a000003-0000-4000-8000-000000000001','OFFLINE-NO-POLICY','Offline No Policy','active','2a000004-0000-4000-8000-000000000001','USD');

insert into public.offline_pos_policies(id,tenant_id,register_id,enabled,operator_lease_seconds,catalog_grant_seconds,max_sale_amount_minor,max_cumulative_exposure_minor,max_quantity_per_line,max_pending_offline_sales,max_offline_credit_exposure_minor)
values
('2a000020-0000-4000-8000-000000000001','2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001',true,43200,86400,6000,10000,3,3,8000),
('2a000020-0000-4000-8000-000000000002','2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000002',true,43200,86400,6000,10000,3,3,8000);

-- A customer the offline bootstrap must deliver (with its current outstanding) so the till can attach
-- installments offline. Phase D: issue_grant embeds the customer snapshot + the offline credit cap.
insert into public.customers(id,tenant_id,name,phone)
values ('2a000030-0000-4000-8000-000000000001','2a000001-0000-4000-8000-000000000001','Layla Hassan','+201000000000')
on conflict do nothing;

create function public.phase_2i_test_set_price(p_amount bigint) returns void
language plpgsql security definer set search_path='' as $function$
begin
 update public.variant_prices set status='archived',archived_at=now(),updated_at=now()
 where tenant_id='2a000001-0000-4000-8000-000000000001' and variant_id='2a000007-0000-4000-8000-000000000001' and currency='USD' and status='active';
 insert into public.variant_prices(tenant_id,variant_id,currency,amount_minor,status)
 values('2a000001-0000-4000-8000-000000000001','2a000007-0000-4000-8000-000000000001','USD',p_amount,'active');
end;
$function$;
grant execute on function public.phase_2i_test_set_price(bigint) to service_role;

create function public.phase_2i_test_deplete_stock() returns void
language plpgsql security definer set search_path='' as $function$
begin
 perform inventory_private.record_operation(
  '2a000001-0000-4000-8000-000000000001','issue',
  jsonb_build_array(jsonb_build_object('variant_id','2a000007-0000-4000-8000-000000000001','inventory_location_id','2a000004-0000-4000-8000-000000000001','quantity_delta',-8)),
  null,'phase-2i-test-deplete',null
 );
end;
$function$;
grant execute on function public.phase_2i_test_deplete_stock() to service_role;

create function public.phase_2i_test_fail_ingestion() returns trigger
language plpgsql set search_path='' as $function$
begin
 if new.local_sale_id = 'local-2a000030-0000-4000-8000-000000000040' then
  raise exception 'forced Phase 2I ingestion failure';
 end if;
 return new;
end;
$function$;

create trigger phase_2i_test_fail_ingestion
before insert on public.offline_sale_ingestions
for each row execute function public.phase_2i_test_fail_ingestion();

-- Phase 2O-C offline-PIN roster fixtures: give the POS staff login usernames so they can appear in the
-- offline staff roster. pos-full is a tenant-wide seller on the main branch/location (will be INCLUDED);
-- pos-no-payment lacks payments.capture and pos-wrong-location holds inventory.issue only on a DIFFERENT
-- location, so both must be EXCLUDED from REGISTER's roster even once they have a PIN. The PIN credentials
-- themselves are sealed with the per-run KEK and so are provisioned from the integration test, not here.
-- Real PIN staff always carry a display name (create_staff_login requires it); the base fixture inserted
-- these identities with only (id, status), so set both here.
update public.user_identities set login_username='pos.full',     display_name='POS Full'     where id='2a000010-0000-4000-8000-000000000001';
update public.user_identities set login_username='pos.nopay',    display_name='POS No Pay'   where id='2a000010-0000-4000-8000-000000000002';
update public.user_identities set login_username='pos.wrongloc', display_name='POS Wrong Loc' where id='2a000010-0000-4000-8000-000000000004';

notify pgrst, 'reload schema';
