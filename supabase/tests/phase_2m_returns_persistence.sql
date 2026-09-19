\set ON_ERROR_STOP on
begin;
set role service_role;
select pos_sales_private.record_sale('2a000001-0000-4000-8000-000000000001','2a000005-0000-4000-8000-000000000001','2a000012-0000-4000-8000-000000000001','return-proof-sale',5000,5000,'[{"variant_id":"2a000007-0000-4000-8000-000000000001","quantity":2}]');
reset role;
do $b$
declare t uuid:='2a000001-0000-4000-8000-000000000001'; actor uuid:='2a000012-0000-4000-8000-000000000001'; loc uuid:='2a000004-0000-4000-8000-000000000001'; o uuid; l uuid; intent jsonb; a jsonb; b jsonb; original jsonb;
begin
 select order_id into o from pos_sales where tenant_id=t;
 select id into l from order_lines where tenant_id=t and order_id=o;
 select to_jsonb(x) into original from orders x where id=o;
 assert (returns_private.return_eligibility(t,o)->>'maxRefundableMinor')::bigint=5000,'initial refundable amount';
 assert (select on_hand_quantity=8 from inventory_balances where tenant_id=t and inventory_location_id=loc),'sale issued two';
 intent:=jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('orderLineId',l,'quantity',1,'reason','size','disposition','restock')),'inventoryLocationId',loc,'refundMode','manual_confirmed','settlementReference','cash paid');
 a:=returns_private.accept_return(t,o,actor,'management','return-proof',intent);
 assert a->>'status'='accepted','accepted return';
 assert a#>>'{refund,status}'='succeeded','cash refund attested';
 assert (a->>'amountMinor')::bigint=2500,'snapshot economics';
 assert (select on_hand_quantity=9 from inventory_balances where tenant_id=t and inventory_location_id=loc),'restocked one';
 b:=returns_private.accept_return(t,o,actor,'management','RETURN-PROOF',intent);
 assert a=b,'normalized-key exact replay';
 assert (select count(*)=1 from returns),'no duplicate return';
 assert (select count(*)=1 from return_lines),'no duplicate lines';
 assert (select count(*)=1 from refunds),'no duplicate refund';
 assert (select on_hand_quantity=9 from inventory_balances where tenant_id=t and inventory_location_id=loc),'no duplicate stock';
 begin
  perform returns_private.accept_return(t,o,actor,'management','return-proof',jsonb_set(intent,'{settlementReference}','"changed"'));
  raise exception 'expected idempotency conflict';
 exception when sqlstate 'ID409' then null; end;
 begin
  perform returns_private.accept_return(t,o,actor,'management','excess',jsonb_set(intent,'{lines,0,quantity}','2'));
  raise exception 'expected quantity denial';
 exception when sqlstate 'RTQTY' then null; end;
 assert (returns_private.return_eligibility(t,o)->>'maxRefundableMinor')::bigint=2500,'prior refund deducted';
 b:=returns_private.accept_return(t,o,actor,'management','non-restock',jsonb_set(jsonb_set(intent,'{inventoryLocationId}','null'),'{lines,0,disposition}','"non_restock"'));
 assert b->>'inventoryOperationId' is null,'no stock operation for damaged item';
 assert (select on_hand_quantity=9 from inventory_balances where tenant_id=t and inventory_location_id=loc),'no sellable increase';
 assert (select sum(amount_minor)=5000 from refunds),'full refund through two partials';
 assert (returns_private.return_eligibility(t,o)->>'maxRefundableMinor')::bigint=0,'no money remains';
 assert (returns_private.return_eligibility(t,o)#>>'{lines,0,eligibleQuantity}')::bigint=0,'no quantity remains';
 assert (select to_jsonb(x)=original from orders x where id=o),'original order unchanged';
 assert (select status='captured' and amount_minor=5000 from payments where order_id=o),'original captured payment unchanged';
 assert returns_private.return_detail('2a000001-0000-4000-8000-000000000002',(a->>'id')::uuid) is null,'foreign tenant cannot read';
 raise notice 'ALL_RETURNS_PERSISTENCE_ASSERTIONS_PASSED';
end $b$;
rollback;
