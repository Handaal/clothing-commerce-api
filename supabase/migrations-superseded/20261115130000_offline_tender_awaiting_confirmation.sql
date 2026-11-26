-- ADR-042 §4.7 (Finding B) — an OFFLINE card / instapay / wallet tender is never "captured".
--
-- Offline ingestion (offline_pos_private.record_offline_sale, every version) captures its tenders through
-- payments_private.capture_payments / capture_partial_payments with the idempotency key prefix
-- 'offline-payment:'. Those helpers write status 'captured' for every method. For cash that is true (the
-- cashier physically took the money; payments_cash_valid still requires captured + cash_received + change).
-- For card / instapay / wallet the server holds no provider confirmation at all — the till only recorded
-- that the cashier said it happened. From this migration such rows are inserted as status 'pending'
-- ("recorded at the till, awaiting provider/server confirmation") with captured_at NULL, which is the
-- existing payments state with exactly that meaning (online COD uses it). The only way forward is the
-- existing sanctioned payments_private.transition_payment (pending -> captured / failed / cancelled), which
-- by its contract is reserved for a verified provider confirmation; no public route calls it today.
--
-- Effects: returns already refuse to refund a payment that is not 'captured' (PAYMENT_NOT_CAPTURED), so no
-- refund can be settled against unconfirmed card money; sales KPIs are order-based and unchanged; the
-- order/sale itself stands (the receipt was issued). Connected (online) POS tenders are untouched.
-- Historical rows are NOT rewritten: payments are immutable and earlier offline non-cash rows keep their
-- original 'captured' status. offline_tender_confirmation_report lists both kinds so they can be told apart.

-- SECURITY DEFINER (owned by payments_writer, empty search_path): it fires for every insert into payments,
-- including roles that hold no EXECUTE on payments_private functions (e.g. the online checkout writer).
create function payments_private.offline_tender_awaiting_confirmation()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.idempotency_key like 'offline-payment:%' and new.method in ('card', 'instapay', 'wallet') then
    new.status := 'pending';
    new.captured_at := null;
  end if;
  return new;
end;
$function$;

-- Fires before payments_capture_time (triggers run in name order), so that trigger sees status 'pending'.
create trigger payments_a_offline_tender_awaiting_confirmation before insert on public.payments
  for each row execute function payments_private.offline_tender_awaiting_confirmation();

create table payments_private.offline_tender_migration_mark (
  singleton boolean primary key default true check (singleton),
  applied_at timestamptz not null default now()
);
insert into payments_private.offline_tender_migration_mark default values;
revoke all on payments_private.offline_tender_migration_mark from public;

-- Read-only owner report: offline non-cash tenders by confirmation state. 'legacy_captured_unverified' are
-- rows ingested before this migration (stored captured without provider confirmation).
create function payments_private.offline_tender_confirmation_report(p_tenant uuid)
returns table(method text, confirmation text, currency text, payments bigint, amount_minor bigint)
language sql stable security definer set search_path = '' as $function$
  select p.method,
         case when p.status = 'pending' then 'awaiting_provider_confirmation'
              when p.status = 'captured' and p.created_at < (select m.applied_at from payments_private.offline_tender_migration_mark m)
                then 'legacy_captured_unverified'
              else p.status end,
         p.currency, count(*)::bigint, coalesce(sum(p.amount_minor), 0)::bigint
    from public.payments p
   where p.tenant_id = p_tenant and p.idempotency_key like 'offline-payment:%'
     and p.method in ('card', 'instapay', 'wallet')
   group by 1, 2, 3
   order by 1, 2, 3;
$function$;

grant create on schema payments_private to payments_writer;
alter function payments_private.offline_tender_awaiting_confirmation() owner to payments_writer;
alter function payments_private.offline_tender_confirmation_report(uuid) owner to payments_writer;
alter table payments_private.offline_tender_migration_mark owner to payments_writer;
revoke create on schema payments_private from payments_writer;
revoke all on function payments_private.offline_tender_awaiting_confirmation() from public;
revoke all on function payments_private.offline_tender_confirmation_report(uuid) from public;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function payments_private.offline_tender_confirmation_report(uuid) to service_role;
  end if;
end $b$;
