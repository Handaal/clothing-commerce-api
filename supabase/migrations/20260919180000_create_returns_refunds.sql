-- Canonical returns for every sales channel. Original Orders/Payments remain immutable.
do $b$ begin
  if not exists(select 1 from pg_roles where rolname='returns_writer') then
    create role returns_writer nologin noinherit nobypassrls;
  end if;
  execute format('grant returns_writer to %I with set true',current_user);
end $b$;
create schema returns_private;
revoke all on schema returns_private from public;
grant usage on schema public, returns_private, commerce_locks, inventory_private to returns_writer;
insert into public.permissions(key,description) values
 ('returns.create','Accept received merchandise returns in the original Order commercial scope.'),
 ('returns.read','Read return eligibility and history in the original Order commercial scope.'),
 ('payments.refund','Initiate refunds and attest manual cash settlement in the Order commercial scope.')
on conflict(key) do nothing;

-- Deployment-owned policy: no live tenant is implicitly opted in. Null window/reasons/threshold
-- mean no additional policy restriction; integrity requirements can never be disabled.
create table public.return_settings (
 tenant_id uuid primary key references public.tenants(id) on delete restrict,
 enabled boolean not null default false,
 window_days integer check(window_days between 0 and 3650),
 allowed_reasons text[],
 manual_refunds_enabled boolean not null default false,
 max_manual_refund_minor bigint check(max_manual_refund_minor between 0 and 9007199254740991)
);
create table public.returns (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
 order_id uuid not null, channel text not null check(channel in ('pos','online')),
 source text not null check(source in ('admin-mobile','pos','management')),
 actor_membership_id uuid not null, status text not null default 'accepted' check(status='accepted'),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 amount_minor bigint not null check(amount_minor between 0 and 9007199254740991),
 inventory_location_id uuid, inventory_operation_id uuid,
 normalized_key text not null check(length(normalized_key) between 1 and 200),
 intent jsonb not null, policy_snapshot jsonb not null,
 created_at timestamptz not null default now(),
 unique(tenant_id,id), unique(tenant_id,order_id,id), unique(tenant_id,normalized_key),
 unique(tenant_id,inventory_operation_id),
 foreign key(tenant_id,order_id) references public.orders(tenant_id,id) on delete restrict,
 foreign key(tenant_id,actor_membership_id) references public.memberships(tenant_id,id) on delete restrict,
 foreign key(tenant_id,inventory_location_id) references public.inventory_locations(tenant_id,id) on delete restrict,
 foreign key(tenant_id,inventory_operation_id) references public.inventory_operations(tenant_id,id) on delete restrict,
 check((inventory_location_id is null)=(inventory_operation_id is null))
);
create index returns_order_history on public.returns(tenant_id,order_id,created_at,id);
create table public.return_lines (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null, return_id uuid not null,
 order_id uuid not null, order_line_id uuid not null, variant_id uuid not null,
 quantity bigint not null check(quantity between 1 and 9007199254740991),
 reason text not null check(length(btrim(reason)) between 1 and 500),
 disposition text not null check(disposition in ('restock','non_restock')),
 amount_minor bigint not null check(amount_minor between 0 and 9007199254740991),
 unique(tenant_id,return_id,order_line_id),
 foreign key(tenant_id,order_id,return_id) references public.returns(tenant_id,order_id,id) on delete restrict,
 foreign key(tenant_id,order_id,order_line_id) references public.order_lines(tenant_id,order_id,id) on delete restrict,
 foreign key(tenant_id,order_line_id,variant_id) references public.order_lines(tenant_id,id,variant_id) on delete restrict
);
create index return_lines_eligibility on public.return_lines(tenant_id,order_line_id);
alter table public.payments add constraint payments_tenant_order_id_unique unique(tenant_id,order_id,id);
create table public.refunds (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null, order_id uuid not null,
 return_id uuid not null, payment_id uuid not null,
 method text not null check(method in ('cash','cash_on_delivery','electronic')),
 status text not null check(status in ('pending','succeeded','failed')),
 amount_minor bigint not null check(amount_minor between 0 and 9007199254740991),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 settlement_reference text, settled_by_membership_id uuid, settled_at timestamptz,
 settlement_key text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,id), unique(tenant_id,return_id),
 foreign key(tenant_id,order_id,return_id) references public.returns(tenant_id,order_id,id) on delete restrict,
 foreign key(tenant_id,order_id,payment_id) references public.payments(tenant_id,order_id,id) on delete restrict,
 foreign key(tenant_id,settled_by_membership_id) references public.memberships(tenant_id,id) on delete restrict,
 check((status='succeeded')=(settled_at is not null)),
 check(status<>'succeeded' or (settlement_reference is not null and length(btrim(settlement_reference)) between 1 and 200)),
 check(status<>'succeeded' or method='electronic' or settled_by_membership_id is not null)
);
create index refunds_payment_ceiling on public.refunds(tenant_id,payment_id);

-- Table ownership and privileges are the mutation boundary. Public roles have neither policies nor
-- direct access; service_role can only read and invoke the narrow sanctioned RPCs.
do $b$ declare t text; begin
 foreach t in array array['return_settings','returns','return_lines','refunds'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public',t);
  execute 'grant create on schema public to returns_writer';
  execute format('alter table public.%I owner to returns_writer',t);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on public.%I from anon',t); end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on public.%I from authenticated',t); end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
   execute format('revoke all on public.%I from service_role',t);
   execute format('grant select on public.%I to service_role',t);
  end if;
 end loop;
end $b$;
revoke create on schema public from returns_writer;
do $b$ declare t text; begin
 foreach t in array array['orders','order_lines','payments','fulfillments','fulfillment_lines','inventory_locations','memberships'] loop
  execute format('grant select on public.%I to returns_writer',t);
  execute format('create policy returns_writer_read on public.%I for select to returns_writer using(true)',t);
 end loop;
end $b$;
grant execute on function commerce_locks.acquire_order_execution_lock(uuid,uuid),
 commerce_locks.acquire_inventory_location_lifecycle_lock(uuid,uuid),
 inventory_private.record_operation(uuid,text,jsonb,uuid,text,timestamptz,text) to returns_writer;

create function returns_private.forbid_history_mutation() returns trigger
language plpgsql set search_path='' as $f$ begin
 raise exception using errcode='42501',message='return history is immutable';
end $f$;
create trigger returns_immutable before update or delete on public.returns for each row execute function returns_private.forbid_history_mutation();
create trigger return_lines_immutable before update or delete on public.return_lines for each row execute function returns_private.forbid_history_mutation();

-- One aggregate projection used by create/replay/read. Timestamps use the transport's UTC format.
create function returns_private.return_detail(p_tenant uuid,p_return uuid) returns jsonb
language sql stable security definer set search_path='' as $f$
 select jsonb_build_object('id',r.id,'orderId',r.order_id,'channel',r.channel,'source',r.source,
 'actorMembershipId',r.actor_membership_id,'status',r.status,'currency',r.currency,'amountMinor',r.amount_minor,
 'inventoryLocationId',r.inventory_location_id,'inventoryOperationId',r.inventory_operation_id,
 'createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'lines',(select jsonb_agg(jsonb_build_object('orderLineId',l.order_line_id,'lineNumber',ol.line_number,
 'variantId',l.variant_id,'quantity',l.quantity,'reason',l.reason,'disposition',l.disposition,'amountMinor',l.amount_minor) order by ol.line_number)
 from public.return_lines l join public.order_lines ol on ol.tenant_id=l.tenant_id and ol.id=l.order_line_id where l.tenant_id=p_tenant and l.return_id=r.id),
 'refund',(select jsonb_build_object('id',f.id,'paymentId',f.payment_id,'returnId',f.return_id,'method',f.method,
 'status',f.status,'amountMinor',f.amount_minor,'currency',f.currency,'settlementReference',f.settlement_reference,
 'settledAt',to_char(f.settled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) from public.refunds f where f.tenant_id=p_tenant and f.return_id=r.id))
 from public.returns r where r.tenant_id=p_tenant and r.id=p_return;
$f$;

create function returns_private.return_eligibility(p_tenant uuid,p_order uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $f$
declare o public.orders; p public.payments; s public.return_settings; reason text; ceiling bigint;
begin
 select * into o from public.orders where tenant_id=p_tenant and id=p_order;
 if not found then raise exception using errcode='RT404',message='order not found'; end if;
 select * into s from public.return_settings where tenant_id=p_tenant;
 select * into p from public.payments where tenant_id=p_tenant and order_id=p_order;
 reason:=case when s.enabled is distinct from true then 'RETURNS_DISABLED'
 when o.status<>'placed' then 'ORDER_NOT_RETURNABLE'
 when p.status is distinct from 'captured' then 'PAYMENT_NOT_CAPTURED'
 when s.window_days is not null and now()>o.placed_at+make_interval(days=>s.window_days) then 'RETURN_WINDOW_EXPIRED' else null end;
 if reason is null and not exists(
  select 1 from public.order_lines l where l.tenant_id=p_tenant and l.order_id=p_order
  and least(l.quantity,coalesce((select sum(fl.quantity) from public.fulfillment_lines fl where fl.tenant_id=p_tenant and fl.order_line_id=l.id),0))>
  coalesce((select sum(rl.quantity) from public.return_lines rl where rl.tenant_id=p_tenant and rl.order_line_id=l.id),0)
 ) then reason:='RETURN_QUANTITY_EXCEEDED'; end if;
 ceiling:=greatest(0,least(coalesce(p.amount_minor,0),o.total_minor)-coalesce((select sum(amount_minor) from public.refunds where tenant_id=p_tenant and payment_id=p.id),0));
 return jsonb_build_object('orderId',o.id,'currency',o.currency,'eligible',reason is null,'reason',reason,
 'maxRefundableMinor',case when reason is null then ceiling else 0 end,
 'policy',jsonb_build_object('windowDays',s.window_days,'allowedReasons',s.allowed_reasons,'manualRefundsEnabled',coalesce(s.manual_refunds_enabled,false),'maxManualRefundMinor',s.max_manual_refund_minor),
 'lines',(select jsonb_agg(jsonb_build_object('orderLineId',l.id,'lineNumber',l.line_number,'variantId',l.variant_id,
 'purchasedQuantity',l.quantity,'fulfilledQuantity',coalesce((select sum(fl.quantity) from public.fulfillment_lines fl where fl.tenant_id=p_tenant and fl.order_line_id=l.id),0),
 'returnedQuantity',coalesce((select sum(rl.quantity) from public.return_lines rl where rl.tenant_id=p_tenant and rl.order_line_id=l.id),0),
 'eligibleQuantity',case when reason is null then greatest(0,least(l.quantity,coalesce((select sum(fl.quantity) from public.fulfillment_lines fl where fl.tenant_id=p_tenant and fl.order_line_id=l.id),0))-coalesce((select sum(rl.quantity) from public.return_lines rl where rl.tenant_id=p_tenant and rl.order_line_id=l.id),0)) else 0 end,
 'unitPriceMinor',l.unit_price_minor) order by l.line_number) from public.order_lines l where l.tenant_id=p_tenant and l.order_id=p_order));
end $f$;

create function returns_private.accept_return(p_tenant uuid,p_order uuid,p_actor uuid,p_source text,p_key text,p_intent jsonb) returns jsonb
language plpgsql security definer set search_path='' as $f$
declare o public.orders; p public.payments; s public.return_settings; old public.returns;
 l public.order_lines; item jsonb; amount bigint:=0; qty bigint; fulfilled bigint; returned bigint;
 rid uuid:=gen_random_uuid(); loc uuid; operation uuid; moves jsonb:='[]'; eligibility jsonb;
 mode text:=p_intent->>'refundMode'; reference text:=p_intent->>'settlementReference';
begin
 if p_actor is null or p_key is null or length(btrim(p_key)) not between 1 and 200 or p_source not in ('admin-mobile','pos','management')
 or jsonb_typeof(p_intent->'lines') is distinct from 'array' or jsonb_array_length(p_intent->'lines') not between 1 and 100
 or mode is null or mode not in ('pending','manual_confirmed') then raise exception using errcode='RT400',message='invalid return'; end if;
 -- Key lock precedes order lock; all quantity and monetary decisions are serialized per original order.
 perform pg_advisory_xact_lock(hashtextextended('return_key:'||p_tenant::text||':'||lower(btrim(p_key)),0));
 select * into old from public.returns where tenant_id=p_tenant and normalized_key=lower(btrim(p_key));
 if found then
  if old.order_id<>p_order or old.intent is distinct from p_intent then raise exception using errcode='ID409',message='changed return intent'; end if;
  return returns_private.return_detail(p_tenant,old.id);
 end if;
 perform commerce_locks.acquire_order_execution_lock(p_tenant,p_order);
 select * into o from public.orders where tenant_id=p_tenant and id=p_order;
 if not found then raise exception using errcode='RT404',message='order not found'; end if;
 select * into s from public.return_settings where tenant_id=p_tenant;
 eligibility:=returns_private.return_eligibility(p_tenant,p_order);
 if eligibility->>'reason' is not null then raise exception using errcode='RT422',message=eligibility->>'reason'; end if;
 select * into p from public.payments where tenant_id=p_tenant and order_id=p_order;
 if p.currency<>o.currency then raise exception using errcode='RT409',message='payment currency mismatch'; end if;
 if (select count(distinct x->>'orderLineId') from jsonb_array_elements(p_intent->'lines') x)<>jsonb_array_length(p_intent->'lines') then raise exception using errcode='RT400',message='duplicate lines'; end if;
 loc:=(p_intent->>'inventoryLocationId')::uuid;
 if exists(select 1 from jsonb_array_elements(p_intent->'lines') x where x->>'disposition'='restock') then
  if loc is null then raise exception using errcode='RT400',message='restock location required'; end if;
  perform commerce_locks.acquire_inventory_location_lifecycle_lock(p_tenant,loc);
  if not exists(select 1 from public.inventory_locations where tenant_id=p_tenant and id=loc and status='active' and is_sellable) then raise exception using errcode='RTLOC',message='restock location unavailable'; end if;
 elsif loc is not null then raise exception using errcode='RT400',message='non-restock has no stock location'; end if;
 for item in select value from jsonb_array_elements(p_intent->'lines') loop
  if item->>'quantity' is null or (item->>'quantity') !~ '^[1-9][0-9]*$' or item->>'reason' is null or length(btrim(item->>'reason')) not between 1 and 500 or item->>'disposition' is null or item->>'disposition' not in ('restock','non_restock') then raise exception using errcode='RT400',message='invalid line'; end if;
  qty:=(item->>'quantity')::bigint;
  select * into l from public.order_lines where tenant_id=p_tenant and order_id=p_order and id=(item->>'orderLineId')::uuid;
  if not found then raise exception using errcode='RTLIN',message='line does not belong to order'; end if;
  if s.allowed_reasons is not null and not (item->>'reason'=any(s.allowed_reasons)) then raise exception using errcode='RT422',message='RETURN_REASON_NOT_ALLOWED'; end if;
  select coalesce(sum(quantity),0) into fulfilled from public.fulfillment_lines where tenant_id=p_tenant and order_line_id=l.id;
  select coalesce(sum(quantity),0) into returned from public.return_lines where tenant_id=p_tenant and order_line_id=l.id;
  if qty>least(l.quantity,fulfilled)-returned then raise exception using errcode='RTQTY',message='return quantity exceeds eligibility'; end if;
  amount:=amount+l.unit_price_minor*qty;
  if item->>'disposition'='restock' then moves:=moves||jsonb_build_array(jsonb_build_object('variant_id',l.variant_id,'inventory_location_id',loc,'quantity_delta',qty)); end if;
 end loop;
 if amount>(eligibility->>'maxRefundableMinor')::bigint then raise exception using errcode='RT409',message='refund ceiling exceeded'; end if;
 if mode='manual_confirmed' then
  if p.method='electronic' or not s.manual_refunds_enabled or (s.max_manual_refund_minor is not null and amount>s.max_manual_refund_minor) then raise exception using errcode='RT422',message='MANUAL_REFUND_NOT_ALLOWED'; end if;
  if reference is null or length(btrim(reference)) not between 1 and 200 then raise exception using errcode='RT400',message='settlement attestation required'; end if;
 elsif reference is not null then raise exception using errcode='RT400',message='pending is not settlement'; end if;
 -- Canonical receipt is in this same transaction; any later failure rolls the ledger back too.
 if jsonb_array_length(moves)>0 then
  select jsonb_agg(x order by x->>'variant_id') into moves from jsonb_array_elements(moves) x;
  operation:=inventory_private.record_operation(p_tenant,'receipt',moves,p_actor,'return:'||rid::text,null,'Accepted merchandise return');
 end if;
 insert into public.returns(id,tenant_id,order_id,channel,source,actor_membership_id,currency,amount_minor,inventory_location_id,inventory_operation_id,normalized_key,intent,policy_snapshot)
 values(rid,p_tenant,p_order,o.channel,p_source,p_actor,o.currency,amount,loc,operation,lower(btrim(p_key)),p_intent,to_jsonb(s));
 for item in select value from jsonb_array_elements(p_intent->'lines') loop
  select * into l from public.order_lines where tenant_id=p_tenant and order_id=p_order and id=(item->>'orderLineId')::uuid;
  insert into public.return_lines(tenant_id,return_id,order_id,order_line_id,variant_id,quantity,reason,disposition,amount_minor)
  values(p_tenant,rid,p_order,l.id,l.variant_id,(item->>'quantity')::bigint,item->>'reason',item->>'disposition',l.unit_price_minor*(item->>'quantity')::bigint);
 end loop;
 insert into public.refunds(tenant_id,order_id,return_id,payment_id,method,status,amount_minor,currency,settlement_reference,settled_by_membership_id,settled_at)
 values(p_tenant,p_order,rid,p.id,p.method,case when mode='manual_confirmed' then 'succeeded' else 'pending' end,amount,o.currency,reference,case when mode='manual_confirmed' then p_actor end,case when mode='manual_confirmed' then now() end);
 return returns_private.return_detail(p_tenant,rid);
end $f$;

create function returns_private.settle_manual_refund(p_tenant uuid,p_return uuid,p_actor uuid,p_key text,p_reference text) returns jsonb
language plpgsql security definer set search_path='' as $f$
declare r public.returns; f public.refunds; s public.return_settings;
begin
 if p_actor is null or p_key is null or length(btrim(p_key)) not between 1 and 200 or p_reference is null or length(btrim(p_reference)) not between 1 and 200 then raise exception using errcode='RT400',message='settlement attestation required'; end if;
 select * into r from public.returns where tenant_id=p_tenant and id=p_return;
 if not found then raise exception using errcode='RT404',message='return not found'; end if;
 perform commerce_locks.acquire_order_execution_lock(p_tenant,r.order_id);
 select * into f from public.refunds where tenant_id=p_tenant and return_id=p_return for update;
 if f.settlement_key=lower(btrim(p_key)) then
  if f.settlement_reference<>p_reference then raise exception using errcode='ID409',message='changed settlement intent'; end if;
  return returns_private.return_detail(p_tenant,p_return);
 end if;
 if f.status<>'pending' then raise exception using errcode='RT409',message='refund is not pending'; end if;
 select * into s from public.return_settings where tenant_id=p_tenant;
 if f.method='electronic' or s.manual_refunds_enabled is distinct from true or (s.max_manual_refund_minor is not null and f.amount_minor>s.max_manual_refund_minor) then raise exception using errcode='RT422',message='MANUAL_REFUND_NOT_ALLOWED'; end if;
 update public.refunds set status='succeeded',settlement_key=lower(btrim(p_key)),settlement_reference=p_reference,
 settled_by_membership_id=p_actor,settled_at=now(),updated_at=now() where tenant_id=p_tenant and id=f.id;
 return returns_private.return_detail(p_tenant,p_return);
end $f$;

create function returns_private.order_return_summary(p_tenant uuid,p_order uuid) returns jsonb
language sql stable security definer set search_path='' as $f$
 select jsonb_build_object('lines',coalesce((select jsonb_agg(x order by x->>'lineNumber') from
 (select jsonb_build_object('orderLineId',ol.id,'lineNumber',ol.line_number,'returnedQuantity',coalesce(sum(rl.quantity),0)) x
 from public.order_lines ol left join public.return_lines rl on rl.tenant_id=ol.tenant_id and rl.order_line_id=ol.id
 where ol.tenant_id=p_tenant and ol.order_id=p_order group by ol.id) q),'[]'),
 'pendingRefundMinor',coalesce((select sum(amount_minor) from public.refunds where tenant_id=p_tenant and order_id=p_order and status<>'succeeded'),0),
 'refundedMinor',coalesce((select sum(amount_minor) from public.refunds where tenant_id=p_tenant and order_id=p_order and status='succeeded'),0));
$f$;
grant create on schema returns_private to returns_writer;
alter function returns_private.return_detail(uuid,uuid) owner to returns_writer;
alter function returns_private.return_eligibility(uuid,uuid) owner to returns_writer;
alter function returns_private.accept_return(uuid,uuid,uuid,text,text,jsonb) owner to returns_writer;
alter function returns_private.settle_manual_refund(uuid,uuid,uuid,text,text) owner to returns_writer;
alter function returns_private.order_return_summary(uuid,uuid) owner to returns_writer;
revoke create on schema returns_private from returns_writer;
revoke all on all functions in schema returns_private from public;
do $b$ begin
 if exists(select 1 from pg_roles where rolname='service_role') then
  grant usage on schema returns_private to service_role;
  grant execute on function returns_private.return_detail(uuid,uuid),returns_private.return_eligibility(uuid,uuid),
   returns_private.accept_return(uuid,uuid,uuid,text,text,jsonb),returns_private.settle_manual_refund(uuid,uuid,uuid,text,text),returns_private.order_return_summary(uuid,uuid) to service_role;
 end if;
end $b$;
