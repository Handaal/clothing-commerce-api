\set ON_ERROR_STOP on
begin;
set role service_role;
select online_private.place_checkout('db-first', '{
 "tenantId":"2a000001-0000-4000-8000-000000000001",
 "brandId":"2a000002-0000-4000-8000-000000000001",
 "lines":[{"variantId":"2a000007-0000-4000-8000-000000000001","quantity":1}],
 "customer":{"name":"Guest","phone":"+201001234567","email":"Guest@example.com"},
 "delivery":{"recipientName":"Guest","phone":"+201001234567","line1":"Street","line2":null,"city":"Cairo","region":null,"postalCode":null,"countryCode":"EG","notes":null},
 "expectedTotalMinor":2500,"expectedCurrency":"USD","paymentMethod":"cash_on_delivery"
}');
reset role;
do $$ begin
  assert (select count(*)=1 from public.orders), 'one order';
  assert (select count(*)=1 from public.customers), 'one customer';
  assert (select count(*)=1 from public.payments where status='pending'), 'pending payment';
  assert (select count(*)=1 from public.stock_reservations where status='active'), 'active hold';
  raise notice 'ALL_ONLINE_PERSISTENCE_ASSERTIONS_PASSED';
end $$;
rollback;
