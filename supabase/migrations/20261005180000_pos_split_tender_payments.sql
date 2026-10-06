-- Phase 2B — Split-tender POS payments.
--
-- Until now a POS sale captured exactly one cash Payment (one row per Order). Split tender lets the
-- cashier settle one sale across multiple cashier-confirmed methods (cash / card / instapay / wallet)
-- whose amounts sum to the authoritative Order total. Each tender becomes its own captured Payment
-- row, grouped by a shared tender_group_key. Only the cash tender carries physical cash_received and
-- change; the others are exact captures. This preserves the immutable Payment entity and all existing
-- online (cash_on_delivery / electronic) behaviour — it only relaxes the single-payment assumption
-- and adds the four cashier-confirmed retail methods.

grant create on schema public, payments_private to payments_writer;

-- Allow the four cashier-confirmed retail methods alongside the existing online methods, and permit
-- more than one captured Payment per Order (a split sale). The shared tender_group_key + sequence
-- keep a split's rows uniquely identifiable for idempotent replay.
alter table public.payments
  drop constraint payments_method_valid,
  drop constraint payments_one_v1_payment_per_order,
  add constraint payments_method_valid
    check (method in ('cash', 'cash_on_delivery', 'electronic', 'card', 'instapay', 'wallet')),
  add column tender_sequence smallint not null default 1,
  add column tender_group_key text,
  add constraint payments_tender_sequence_positive check (tender_sequence >= 1);

-- One row per (group, sequence); scoped to rows that belong to a split capture.
create unique index payments_tender_group_sequence_unique
  on public.payments (tenant_id, tender_group_key, tender_sequence)
  where tender_group_key is not null;

comment on column public.payments.tender_sequence is
  'Ordinal of this tender within its sale (1-based). Standalone payments use 1.';
comment on column public.payments.tender_group_key is
  'Normalized idempotency key shared by all tenders captured together in one split sale.';

-- Capture one-or-more cashier-confirmed tenders for an Order in a single statement. The tenders must
-- sum exactly to the authoritative Order total. Returns the primary payment id (the cash tender when
-- present, otherwise the first tender) so the composition record can reference one representative row.
create function payments_private.capture_payments(
  p_tenant_id uuid,
  p_order_id uuid,
  p_tenders jsonb,
  p_captured_by_membership_id uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql security definer set search_path = '' as $function$
declare
  v_group_key text := lower(btrim(p_idempotency_key));
  v_order_total bigint;
  v_currency text;
  v_fingerprint text;
  v_existing_primary uuid;
  v_existing_fingerprint text;
  v_sum bigint := 0;
  v_seen text[] := array[]::text[];
  v_element jsonb;
  v_method text;
  v_amount bigint;
  v_cash_received bigint;
  v_change bigint;
  v_seq smallint := 0;
  v_cash_count int := 0;
  v_payment_id uuid;
  v_primary_id uuid;
begin
  if p_tenant_id is null or p_order_id is null or p_captured_by_membership_id is null
    or p_idempotency_key is null or v_group_key = '' or p_tenders is null then
    raise exception using errcode = '22004', message = 'payment capture fields are required';
  end if;
  if pg_catalog.jsonb_typeof(p_tenders) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_tenders) = 0 then
    raise exception using errcode = '22023', message = 'at least one tender is required';
  end if;

  select o.total_minor, o.currency into v_order_total, v_currency
  from public.orders o where o.tenant_id = p_tenant_id and o.id = p_order_id;
  if not found then
    raise exception using errcode = 'FF010', message = 'order not found';
  end if;

  -- Canonical fingerprint over the ordered tender set, so replaying the same key with a different
  -- split conflicts rather than silently re-capturing.
  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || p_order_id::text || E'\n' || coalesce((
      select pg_catalog.string_agg(
        E'\n' || (t.value ->> 'method') || ',' || (t.value ->> 'amount_minor') || ','
          || coalesce(t.value ->> 'cash_received_minor', ''),
        '' order by t.ord
      )
      from pg_catalog.jsonb_array_elements(p_tenders) with ordinality t(value, ord)
    ), '')
  );

  -- Idempotent replay: the group was already captured.
  select p.id, p.payload_fingerprint into v_existing_primary, v_existing_fingerprint
  from public.payments p
  where p.tenant_id = p_tenant_id and p.tender_group_key = v_group_key
  order by case when p.method = 'cash' then 0 else 1 end, p.tender_sequence
  limit 1;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'payment idempotency conflict';
    end if;
    return v_existing_primary;
  end if;

  for v_element in
    select t.value from pg_catalog.jsonb_array_elements(p_tenders) with ordinality t(value, ord)
    order by t.ord
  loop
    v_method := v_element ->> 'method';
    if v_method is null or v_method not in ('cash', 'card', 'instapay', 'wallet') then
      raise exception using errcode = '22023', message = 'unsupported tender method';
    end if;
    if v_method = any(v_seen) then
      raise exception using errcode = '22023', message = 'a method may appear at most once per sale';
    end if;
    v_seen := v_seen || v_method;

    if v_element ->> 'amount_minor' is null then
      raise exception using errcode = '22023', message = 'tender amount is required';
    end if;
    v_amount := (v_element ->> 'amount_minor')::bigint;
    if v_amount <= 0 then
      raise exception using errcode = '22023', message = 'tender amount must be positive';
    end if;
    v_sum := v_sum + v_amount;
    v_seq := v_seq + 1;

    if v_method = 'cash' then
      v_cash_count := v_cash_count + 1;
      v_cash_received := coalesce((v_element ->> 'cash_received_minor')::bigint, v_amount);
      if v_cash_received < v_amount then
        raise exception using errcode = 'PS030', message = 'cash received below cash tender amount';
      end if;
      v_change := v_cash_received - v_amount;
    else
      -- Exact cashier-confirmed capture; no physical cash or change.
      v_cash_received := v_amount;
      v_change := 0;
    end if;

    insert into public.payments (
      tenant_id, order_id, method, status, currency, amount_minor, cash_received_minor,
      change_minor, captured_by_membership_id, idempotency_key, payload_fingerprint,
      tender_sequence, tender_group_key
    ) values (
      p_tenant_id, p_order_id, v_method, 'captured', v_currency, v_amount, v_cash_received,
      v_change, p_captured_by_membership_id, p_idempotency_key || ':' || v_seq::text, v_fingerprint,
      v_seq, v_group_key
    ) returning id into v_payment_id;

    if v_method = 'cash' or v_primary_id is null then
      v_primary_id := v_payment_id;
    end if;
  end loop;

  if v_sum is distinct from v_order_total then
    raise exception using errcode = 'PS031', message = 'tenders do not sum to the order total';
  end if;
  return v_primary_id;
exception
  when unique_violation then
    select p.id, p.payload_fingerprint into v_existing_primary, v_existing_fingerprint
    from public.payments p
    where p.tenant_id = p_tenant_id and p.tender_group_key = v_group_key
    order by case when p.method = 'cash' then 0 else 1 end, p.tender_sequence
    limit 1;
    if v_existing_primary is null or v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'ID409', message = 'payment idempotency conflict';
    end if;
    return v_existing_primary;
end;
$function$;

alter function payments_private.capture_payments(uuid, uuid, jsonb, uuid, text)
  owner to payments_writer;
revoke create on schema public, payments_private from payments_writer;
revoke all on function payments_private.capture_payments(uuid, uuid, jsonb, uuid, text) from public;

grant execute on function payments_private.capture_payments(uuid, uuid, jsonb, uuid, text)
  to pos_sales_writer;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function payments_private.capture_payments(uuid, uuid, jsonb, uuid, text) from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function payments_private.capture_payments(uuid, uuid, jsonb, uuid, text) from authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function payments_private.capture_payments(uuid, uuid, jsonb, uuid, text) to service_role';
  end if;
end;
$block$;
