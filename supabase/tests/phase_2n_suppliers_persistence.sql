\set ON_ERROR_STOP on
begin;
set role service_role;
do $b$
declare
 t uuid:='2a000001-0000-4000-8000-000000000001'; foreign_t uuid:='2a000001-0000-4000-8000-000000000002';
 a uuid:='2a000012-0000-4000-8000-000000000001'; s uuid; op uuid; replay uuid; before_qty bigint;
 v uuid:='2a000007-0000-4000-8000-000000000001'; l uuid:='2a000004-0000-4000-8000-000000000001';
 payload jsonb; created jsonb; updated jsonb; history jsonb;
begin
 created:=suppliers_private.write_supplier(t,null,a,'create-proof','{"name":"Needle Supplier","code":"NDL"}');
 s:=(created->>'id')::uuid;
 assert created->>'status'='active','new supplier active';
 assert created->>'tenantId'=t::text,'tenant owned';
 assert suppliers_private.write_supplier(t,null,a,'CREATE-PROOF','{"name":"Needle Supplier","code":"NDL"}')=created,'create exact replay';
 begin
  perform suppliers_private.write_supplier(t,null,a,'create-proof','{"name":"Changed"}'); raise exception 'expected create conflict';
 exception when sqlstate 'ID409' then null; end;
 assert jsonb_array_length(suppliers_private.list_suppliers(t,'needle',null,null,26))=1,'case insensitive name search';
 assert jsonb_array_length(suppliers_private.list_suppliers(t,'ndl',null,null,26))=1,'code search';
 assert jsonb_array_length(suppliers_private.list_suppliers(foreign_t,'needle',null,null,26))=0,'tenant isolated list';
 assert jsonb_array_length(suppliers_private.list_suppliers(t,'%',null,null,26))=0,'literal search wildcard';
 begin
  perform suppliers_private.write_supplier(foreign_t,s,a,'foreign-edit','{"status":"inactive"}'); raise exception 'expected foreign denial';
 exception when sqlstate 'SU404' then null; end;
 updated:=suppliers_private.write_supplier(t,s,a,'edit-proof','{"phone":"123","notes":"Contact buyer"}');
 assert updated->>'phone'='123','contact updated'; assert updated->>'notes'='Contact buyer','notes updated';
 select on_hand_quantity into before_qty from public.inventory_balances where tenant_id=t and variant_id=v and inventory_location_id=l;
 payload:=jsonb_build_array(jsonb_build_object('variant_id',v,'inventory_location_id',l,'quantity_delta',3));
 op:=inventory_private.record_operation(t,'receipt',payload,a,'supplier-receipt',null,null,s,'DN-1');
 assert (select on_hand_quantity=before_qty+3 from public.inventory_balances where tenant_id=t and variant_id=v and inventory_location_id=l),'canonical increase exactly three';
 assert (select supplier_id=s and supplier_reference='DN-1' and supplier_name_snapshot='Needle Supplier' from public.inventory_operations where id=op),'immutable linkage at insert';
 replay:=inventory_private.record_operation(t,'receipt',payload,a,'SUPPLIER-RECEIPT',null,null,s,'DN-1');
 assert replay=op,'same canonical operation';
 assert (select on_hand_quantity=before_qty+3 from public.inventory_balances where tenant_id=t and variant_id=v and inventory_location_id=l),'replay no second increase';
 begin
  perform inventory_private.record_operation(t,'receipt',payload,a,'supplier-receipt',null,null,s,'DN-2'); raise exception 'expected changed reference conflict';
 exception when sqlstate 'ID409' then null; end;
 begin
  perform inventory_private.record_operation(t,'receipt',payload,a,'supplier-receipt',null,null,null,null); raise exception 'expected removed supplier conflict';
 exception when sqlstate 'ID409' then null; end;
 begin
  perform inventory_private.record_operation(t,'receipt',payload,a,'foreign-receipt',null,null,'2a000020-0000-4000-8000-000000000002','DN'); raise exception 'expected cross tenant denial';
 exception when sqlstate 'SU404' then null; end;
 begin
  perform inventory_private.record_operation(t,'receipt',payload,a,'unknown-receipt',null,null,'2a000020-0000-4000-8000-999999999999',null); raise exception 'expected unknown denial';
 exception when sqlstate 'SU404' then null; end;
 updated:=suppliers_private.write_supplier(t,s,a,'deactivate-proof','{"name":"New Name","status":"inactive"}');
 assert updated->>'status'='inactive','deactivation readable';
 assert inventory_private.record_operation(t,'receipt',payload,a,'supplier-receipt',null,null,s,'DN-1')=op,'inactive supplier exact replay';
 begin
  perform inventory_private.record_operation(t,'receipt',payload,a,'inactive-receipt',null,null,s,'DN-1'); raise exception 'expected inactive denial';
 exception when sqlstate 'SU409' then null; end;
 history:=suppliers_private.supplier_receipts(t,s,null,null,26);
 assert jsonb_array_length(history)=1,'one historical operation';
 assert history#>>'{0,supplierName}'='Needle Supplier','original name preserved';
 assert history#>>'{0,lines,0,quantity}'='3','canonical movement projected';
 assert jsonb_array_length(suppliers_private.supplier_receipts(foreign_t,s,null,null,26))=0,'cross tenant history denied';
 assert jsonb_array_length(suppliers_private.supplier_receipts(t,s,array[]::uuid[],null,26))=0,'empty location scope cannot read';
 perform inventory_private.record_operation(t,'receipt',payload,a,'legacy-proof');
 assert (select on_hand_quantity=before_qty+6 from public.inventory_balances where tenant_id=t and variant_id=v and inventory_location_id=l),'legacy no supplier receive works';
 assert (select count(*)=1 from public.inventory_operations where supplier_id=s),'one linked operation after all denials';
 updated:=suppliers_private.write_supplier(t,s,a,'reactivate-proof','{"status":"active","phone":null}');
 assert updated->>'status'='active' and updated->>'phone' is null,'reactivation and clearing';
end $b$;
reset role;
-- Composite foreign key and immutable ledger prevent bypass via internal SQL.
do $b$ begin
 begin
  insert into public.inventory_operations(tenant_id,operation_type,supplier_id,supplier_name_snapshot)
  values('2a000001-0000-4000-8000-000000000001','receipt','2a000020-0000-4000-8000-000000000002','Foreign');
  raise exception 'expected composite FK';
 exception when foreign_key_violation then null; end;
 begin
  update public.inventory_operations set supplier_name_snapshot='Corrupted' where normalized_idempotency_key='supplier-receipt';
  raise exception 'expected immutable history';
 exception when sqlstate '42501' then null; end;
 begin
  delete from public.suppliers where code='NDL'; raise exception 'expected protected history';
 exception when foreign_key_violation then null; end;
end $b$;
select 'ALL_SUPPLIERS_PERSISTENCE_ASSERTIONS_PASSED';
rollback;
