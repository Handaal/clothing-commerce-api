-- Phase 4 (Storefront program): after purchase — order tracking and customer return requests.
--
-- A shopper has no account, so they identify an order by its order number plus the phone they gave
-- at checkout (customer or delivery phone). Both public entry points are SECURITY DEFINER functions
-- that answer "not found" identically for a wrong number and a wrong phone, and that refuse further
-- guesses for an order number after repeated misses (storefront_lookup_failures) so a known order
-- number cannot be paired with phone numbers by brute force.
--
-- A return REQUEST is the customer asking; it moves no stock and no money. Staff approve, decline or
-- complete it from Admin Mobile / POS and handle the item through the existing returns flow or by
-- exchange. Quantities are capped by what was handed over (fulfilled), minus what was already returned
-- and what is already asked for in an open request. The store's return settings (enabled + window)
-- decide whether requests are accepted at all.

-- 1. Failed lookups (throttle) ----------------------------------------------------------------------------
create table public.storefront_lookup_failures (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  normalized_order_number text not null,
  created_at timestamptz not null default pg_catalog.now()
);
create index storefront_lookup_failures_recent_idx
  on public.storefront_lookup_failures (tenant_id, normalized_order_number, created_at desc);
alter table public.storefront_lookup_failures enable row level security;
revoke all on table public.storefront_lookup_failures from public, anon, authenticated;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'revoke all on table public.storefront_lookup_failures from service_role';
  end if;
end;
$block$;
comment on table public.storefront_lookup_failures is
  'Missed order-number + phone matches from the Storefront; used only to throttle guessing.';

-- 2. Return requests ---------------------------------------------------------------------------------------
create table public.return_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  brand_id uuid not null,
  order_id uuid not null,
  reference text not null,
  status text not null default 'requested',
  preference text not null default 'refund',
  customer_note text,
  staff_note text,
  decided_by_membership_id uuid,
  decided_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (tenant_id, id),
  unique (tenant_id, reference),
  constraint return_requests_order_fk foreign key (tenant_id, order_id, brand_id)
    references public.orders (tenant_id, id, brand_id) on delete restrict,
  constraint return_requests_status_valid
    check (status in ('requested', 'approved', 'declined', 'completed')),
  constraint return_requests_preference_valid check (preference in ('refund', 'exchange')),
  constraint return_requests_customer_note_len
    check (customer_note is null or pg_catalog.length(customer_note) <= 500),
  constraint return_requests_staff_note_len
    check (staff_note is null or pg_catalog.length(staff_note) <= 500),
  constraint return_requests_decision_consistent
    check ((status = 'requested') = (decided_at is null))
);
create index return_requests_tenant_created_idx
  on public.return_requests (tenant_id, created_at desc, id desc);
create index return_requests_order_idx on public.return_requests (tenant_id, order_id);

create table public.return_request_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  request_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  line_number integer not null,
  quantity bigint not null check (quantity > 0),
  reason text not null,
  unique (tenant_id, request_id, order_line_id),
  constraint return_request_lines_request_fk foreign key (tenant_id, request_id)
    references public.return_requests (tenant_id, id) on delete cascade,
  constraint return_request_lines_order_line_fk foreign key (tenant_id, order_id, order_line_id)
    references public.order_lines (tenant_id, order_id, id) on delete restrict,
  constraint return_request_lines_reason_valid
    check (reason in ('too_small', 'too_big', 'not_as_pictured', 'damaged', 'wrong_item', 'changed_mind', 'other'))
);
create index return_request_lines_order_line_idx
  on public.return_request_lines (tenant_id, order_line_id);

alter table public.return_requests enable row level security;
alter table public.return_request_lines enable row level security;
revoke all on table public.return_requests, public.return_request_lines from public, anon, authenticated;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    -- Reads only: the sanctioned functions below are the only writers.
    execute 'revoke all on table public.return_requests, public.return_request_lines from service_role';
    execute 'grant select on table public.return_requests, public.return_request_lines to service_role';
  end if;
end;
$block$;
comment on table public.return_requests is
  'A customer''s request to return items from an online order. Moves no stock or money; staff decide.';

-- 3. Helpers ------------------------------------------------------------------------------------------------
-- Resolves an online order by number + phone, or records a miss. Raises TR429 once an order number has
-- collected too many misses in the last 15 minutes (checked BEFORE matching, so a correct guess after
-- the limit is refused too).
create function online_private.match_storefront_order(
  p_tenant uuid,
  p_brand uuid,
  p_reference text,
  p_phone text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_number text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_reference, '')));
  v_phone text := pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^+0-9]', '', 'g');
  v_order uuid;
begin
  -- Customers often type the number with a leading "#".
  v_number := pg_catalog.ltrim(v_number, '#');
  if pg_catalog.length(v_number) not between 1 and 40 then
    return null;
  end if;
  if (
    select pg_catalog.count(*) from public.storefront_lookup_failures f
    where f.tenant_id = p_tenant and f.normalized_order_number = v_number
      and f.created_at > pg_catalog.now() - interval '15 minutes'
  ) >= 8 then
    raise exception using errcode = 'TR429', message = 'too many attempts';
  end if;

  select o.id into v_order
  from public.orders o
  join public.tenants t on t.id = o.tenant_id and t.status = 'active'
  where o.tenant_id = p_tenant
    and o.channel = 'online'
    and o.normalized_order_number = v_number
    and (p_brand is null or o.brand_id = p_brand)
    and pg_catalog.length(v_phone) >= 8
    and v_phone in (
      pg_catalog.regexp_replace(coalesce(o.customer_snapshot ->> 'phone', ''), '[^+0-9]', '', 'g'),
      pg_catalog.regexp_replace(coalesce(o.delivery_snapshot ->> 'phone', ''), '[^+0-9]', '', 'g')
    );

  if v_order is null and exists (select 1 from public.tenants where id = p_tenant) then
    insert into public.storefront_lookup_failures (tenant_id, normalized_order_number)
    values (p_tenant, v_number);
  end if;
  return v_order;
end;
$function$;

-- Per-line quantities for one order: ordered, handed over, returned, open (requested/approved) requests.
create function online_private.order_line_return_state(p_tenant uuid, p_order uuid)
returns table (
  order_line_id uuid,
  line_number integer,
  ordered bigint,
  fulfilled bigint,
  returned bigint,
  requested bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    l.id,
    l.line_number,
    l.quantity,
    least(l.quantity, coalesce((select pg_catalog.sum(fl.quantity) from public.fulfillment_lines fl
      where fl.tenant_id = p_tenant and fl.order_line_id = l.id), 0))::bigint,
    -- Returned = recorded returns, or completed requests when staff closed one without recording a
    -- formal return (e.g. an exchange); the larger, so the same item is never counted twice.
    greatest(
      coalesce((select pg_catalog.sum(rl.quantity) from public.return_lines rl
        where rl.tenant_id = p_tenant and rl.order_line_id = l.id), 0),
      coalesce((select pg_catalog.sum(q.quantity) from public.return_request_lines q
        join public.return_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
        where q.tenant_id = p_tenant and q.order_line_id = l.id and r.status = 'completed'), 0)
    )::bigint,
    coalesce((select pg_catalog.sum(q.quantity) from public.return_request_lines q
      join public.return_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
      where q.tenant_id = p_tenant and q.order_line_id = l.id
        and r.status in ('requested', 'approved')), 0)::bigint
  from public.order_lines l
  where l.tenant_id = p_tenant and l.order_id = p_order;
$function$;

-- Order lines snapshot the chosen option VALUE ids (comma-separated). Shoppers and staff read names, so
-- map each id to its display value in the order the snapshot lists them ("S · Navy"). Text that isn't
-- a list of ids is returned as is; null when nothing readable remains.
create function online_private.readable_option_summary(p_tenant uuid, p_summary text)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_summary is null or pg_catalog.btrim(p_summary) = '' then null
    when p_summary !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(s*,s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$'
      then p_summary
    else (
      select pg_catalog.string_agg(v.display_value, ' · ' order by ids.ord)
      from pg_catalog.unnest(pg_catalog.string_to_array(pg_catalog.replace(p_summary, ' ', ''), ',')) with ordinality as ids(id, ord)
      join public.product_option_values v on v.tenant_id = p_tenant and v.id = ids.id::uuid
    )
  end;
$function$;

-- Why a return request cannot be opened right now (null = it can).
create function online_private.return_request_refusal(p_tenant uuid, p_order uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  o public.orders;
  s public.return_settings;
begin
  select * into o from public.orders where tenant_id = p_tenant and id = p_order;
  select * into s from public.return_settings where tenant_id = p_tenant;
  if s.enabled is distinct from true then return 'RETURNS_DISABLED'; end if;
  if o.status <> 'placed' then return 'ORDER_CANCELLED'; end if;
  if s.window_days is not null and pg_catalog.now() > o.placed_at + pg_catalog.make_interval(days => s.window_days) then
    return 'RETURN_WINDOW_EXPIRED';
  end if;
  if not exists (
    select 1 from online_private.order_line_return_state(p_tenant, p_order) x where x.fulfilled > 0
  ) then
    return 'NOT_YET_DELIVERED';
  end if;
  if not exists (
    select 1 from online_private.order_line_return_state(p_tenant, p_order) x
    where x.fulfilled - x.returned - x.requested > 0
  ) then
    return 'NOTHING_TO_RETURN';
  end if;
  return null;
end;
$function$;

create function online_private.return_request_json(p_tenant uuid, p_request uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', r.id,
    'reference', r.reference,
    'orderId', r.order_id,
    'orderNumber', o.order_number,
    'brandId', r.brand_id,
    'status', r.status,
    'preference', r.preference,
    'customerNote', r.customer_note,
    'staffNote', r.staff_note,
    'customerName', o.customer_snapshot ->> 'name',
    'customerPhone', o.customer_snapshot ->> 'phone',
    'createdAt', pg_catalog.to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'decidedAt', pg_catalog.to_char(r.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lines', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'lineNumber', q.line_number,
        'productName', l.product_name_snapshot,
        'variantName', l.variant_name_snapshot,
        'optionSummary', online_private.readable_option_summary(p_tenant, l.option_summary_snapshot),
        'sku', l.sku_snapshot,
        'quantity', q.quantity,
        'reason', q.reason) order by q.line_number)
      from public.return_request_lines q
      join public.order_lines l on l.tenant_id = q.tenant_id and l.id = q.order_line_id
      where q.tenant_id = p_tenant and q.request_id = r.id), '[]'::jsonb)
  )
  from public.return_requests r
  join public.orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
  where r.tenant_id = p_tenant and r.id = p_request;
$function$;

-- 4. Public: track an order ---------------------------------------------------------------------------------
-- Returns null when nothing matches. Exposes no street address, email, or internal ids.
create function online_private.track_storefront_order(
  p_tenant uuid,
  p_brand uuid,
  p_reference text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order uuid := online_private.match_storefront_order(p_tenant, p_brand, p_reference, p_phone);
  o public.orders;
  s public.return_settings;
  p public.payments;
  v_refusal text;
begin
  if v_order is null then return null; end if;
  select * into o from public.orders where tenant_id = p_tenant and id = v_order;
  select * into s from public.return_settings where tenant_id = p_tenant;
  select * into p from public.payments where tenant_id = p_tenant and order_id = v_order
    order by created_at limit 1;
  v_refusal := online_private.return_request_refusal(p_tenant, v_order);

  return pg_catalog.jsonb_build_object(
    'orderReference', o.order_number,
    'status', o.status,
    'placedAt', pg_catalog.to_char(o.placed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cancelledAt', pg_catalog.to_char(o.cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastFulfilledAt', (select pg_catalog.to_char(pg_catalog.max(f.fulfilled_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      from public.fulfillments f where f.tenant_id = p_tenant and f.order_id = v_order),
    'currency', o.currency,
    'totalMinor', o.total_minor,
    'grossSubtotalMinor', coalesce(o.gross_subtotal_minor, o.total_minor),
    'discountTotalMinor', o.discount_total_minor,
    'deliveryFeeMinor', o.delivery_fee_minor,
    'payment', case when p.id is null then null else
      pg_catalog.jsonb_build_object('method', p.method, 'status', p.status) end,
    'recipientName', pg_catalog.split_part(pg_catalog.btrim(coalesce(o.delivery_snapshot ->> 'recipientName', '')), ' ', 1),
    'deliveryCity', o.delivery_snapshot ->> 'city',
    'deliveryRegion', o.delivery_snapshot ->> 'region',
    'lines', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'lineNumber', l.line_number,
        'productName', l.product_name_snapshot,
        'variantName', l.variant_name_snapshot,
        'optionSummary', online_private.readable_option_summary(p_tenant, l.option_summary_snapshot),
        'quantity', l.quantity,
        'unitPriceMinor', l.unit_price_minor,
        'lineTotalMinor', l.line_total_minor,
        'fulfilledQuantity', x.fulfilled,
        'returnedQuantity', x.returned,
        'requestedQuantity', x.requested,
        'returnableQuantity', case when v_refusal is null
          then greatest(0, x.fulfilled - x.returned - x.requested) else 0 end
      ) order by l.line_number)
      from public.order_lines l
      join online_private.order_line_return_state(p_tenant, v_order) x on x.order_line_id = l.id
      where l.tenant_id = p_tenant and l.order_id = v_order), '[]'::jsonb),
    'returns', pg_catalog.jsonb_build_object(
      'accepting', v_refusal is null,
      'reason', v_refusal,
      'windowDays', s.window_days,
      'windowEndsAt', case when s.window_days is null then null else
        pg_catalog.to_char((o.placed_at + pg_catalog.make_interval(days => s.window_days)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
    ),
    'returnRequests', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'reference', r.reference,
        'status', r.status,
        'preference', r.preference,
        'createdAt', pg_catalog.to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'lines', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('lineNumber', q.line_number, 'quantity', q.quantity) order by q.line_number)
          from public.return_request_lines q where q.tenant_id = p_tenant and q.request_id = r.id)
      ) order by r.created_at)
      from public.return_requests r where r.tenant_id = p_tenant and r.order_id = v_order), '[]'::jsonb)
  );
end;
$function$;

-- 5. Public: request a return ----------------------------------------------------------------------------------
-- p_lines: [{"lineNumber": 1, "quantity": 1, "reason": "too_small"}, ...]
-- Returns {"request": {...}} or {"refusal": "<CODE>"}; refusals are answers, not exceptions, so the
-- recorded lookup miss survives. ORDER_NOT_FOUND covers both a wrong number and a wrong phone.
create function online_private.request_storefront_return(
  p_tenant uuid,
  p_brand uuid,
  p_reference text,
  p_phone text,
  p_preference text,
  p_note text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order uuid := online_private.match_storefront_order(p_tenant, p_brand, p_reference, p_phone);
  o public.orders;
  v_refusal text;
  v_request uuid;
  v_count integer;
  v_line jsonb;
  v_state record;
  v_qty bigint;
begin
  if v_order is null then return pg_catalog.jsonb_build_object('refusal', 'ORDER_NOT_FOUND'); end if;
  if pg_catalog.jsonb_typeof(p_lines) is distinct from 'array' or pg_catalog.jsonb_array_length(p_lines) = 0 then
    return pg_catalog.jsonb_build_object('refusal', 'INVALID_RETURN_REQUEST');
  end if;

  select * into o from public.orders where tenant_id = p_tenant and id = v_order for update;
  v_refusal := online_private.return_request_refusal(p_tenant, v_order);
  if v_refusal is not null then return pg_catalog.jsonb_build_object('refusal', v_refusal); end if;

  -- Each line once, a known line number, a positive whole quantity within what is returnable.
  if (select pg_catalog.count(distinct e ->> 'lineNumber') from pg_catalog.jsonb_array_elements(p_lines) e)
       <> pg_catalog.jsonb_array_length(p_lines) then
    return pg_catalog.jsonb_build_object('refusal', 'INVALID_RETURN_REQUEST');
  end if;
  for v_line in select * from pg_catalog.jsonb_array_elements(p_lines) loop
    if pg_catalog.jsonb_typeof(v_line -> 'lineNumber') is distinct from 'number'
       or pg_catalog.jsonb_typeof(v_line -> 'quantity') is distinct from 'number'
       or (v_line ->> 'quantity') !~ '^[1-9][0-9]{0,5}$'
       or (v_line ->> 'lineNumber') !~ '^[1-9][0-9]{0,5}$'
       or coalesce(v_line ->> 'reason', '') not in
          ('too_small', 'too_big', 'not_as_pictured', 'damaged', 'wrong_item', 'changed_mind', 'other') then
      return pg_catalog.jsonb_build_object('refusal', 'INVALID_RETURN_REQUEST');
    end if;
    select * into v_state from online_private.order_line_return_state(p_tenant, v_order) x
      where x.line_number = (v_line ->> 'lineNumber')::integer;
    if not found then return pg_catalog.jsonb_build_object('refusal', 'INVALID_RETURN_REQUEST'); end if;
    v_qty := (v_line ->> 'quantity')::bigint;
    if v_qty > v_state.fulfilled - v_state.returned - v_state.requested then
      return pg_catalog.jsonb_build_object('refusal', 'RETURN_QUANTITY_EXCEEDED');
    end if;
  end loop;

  select pg_catalog.count(*) + 1 into v_count from public.return_requests
    where tenant_id = p_tenant and order_id = v_order;
  insert into public.return_requests (tenant_id, brand_id, order_id, reference, preference, customer_note)
  values (p_tenant, o.brand_id, v_order, o.order_number || '-R' || v_count,
    case when p_preference = 'exchange' then 'exchange' else 'refund' end,
    nullif(pg_catalog.btrim(coalesce(p_note, '')), ''))
  returning id into v_request;

  insert into public.return_request_lines (tenant_id, request_id, order_id, order_line_id, line_number, quantity, reason)
  select p_tenant, v_request, v_order, l.id, l.line_number, (e ->> 'quantity')::bigint, e ->> 'reason'
  from pg_catalog.jsonb_array_elements(p_lines) e
  join public.order_lines l on l.tenant_id = p_tenant and l.order_id = v_order
    and l.line_number = (e ->> 'lineNumber')::integer;

  return pg_catalog.jsonb_build_object('request', pg_catalog.jsonb_build_object(
    'reference', o.order_number || '-R' || v_count,
    'status', 'requested'));
end;
$function$;

-- 6. Staff: decide a request ------------------------------------------------------------------------------------
-- Allowed moves: requested -> approved | declined; approved -> completed | declined. Authorization is
-- done by the API before this is called (returns.create in the order's brand scope).
create function online_private.set_return_request_status(
  p_tenant uuid,
  p_request uuid,
  p_actor uuid,
  p_status text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  r public.return_requests;
begin
  select * into r from public.return_requests where tenant_id = p_tenant and id = p_request for update;
  if not found then raise exception using errcode = 'RQ404', message = 'return request not found'; end if;
  if r.status = p_status then
    -- Same decision again (e.g. a retried tap): no change.
    return online_private.return_request_json(p_tenant, p_request);
  end if;
  if not ((r.status = 'requested' and p_status in ('approved', 'declined'))
       or (r.status = 'approved' and p_status in ('completed', 'declined'))) then
    raise exception using errcode = 'RQ409', message = 'return request status cannot change that way';
  end if;
  update public.return_requests
     set status = p_status,
         staff_note = coalesce(nullif(pg_catalog.btrim(coalesce(p_note, '')), ''), staff_note),
         decided_by_membership_id = p_actor,
         decided_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where tenant_id = p_tenant and id = p_request;
  return online_private.return_request_json(p_tenant, p_request);
end;
$function$;

-- Staff list, newest first. p_status: open (requested + approved) | all | one status.
create function online_private.list_return_requests(
  p_tenant uuid,
  p_status text,
  p_order uuid,
  p_limit integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(online_private.return_request_json(p_tenant, x.id) order by x.created_at desc, x.id desc), '[]'::jsonb)
  from (
    select r.id, r.created_at from public.return_requests r
    where r.tenant_id = p_tenant
      and (p_order is null or r.order_id = p_order)
      and case p_status
            when 'open' then r.status in ('requested', 'approved')
            when 'all' then true
            else r.status = p_status end
    order by r.created_at desc, r.id desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) x;
$function$;

-- 7. Grants -------------------------------------------------------------------------------------------------------
revoke all on function online_private.list_return_requests(uuid, text, uuid, integer) from public;
revoke all on function online_private.match_storefront_order(uuid, uuid, text, text) from public;
revoke all on function online_private.order_line_return_state(uuid, uuid) from public;
revoke all on function online_private.return_request_refusal(uuid, uuid) from public;
revoke all on function online_private.readable_option_summary(uuid, text) from public;
revoke all on function online_private.return_request_json(uuid, uuid) from public;
revoke all on function online_private.track_storefront_order(uuid, uuid, text, text) from public;
revoke all on function online_private.request_storefront_return(uuid, uuid, text, text, text, text, jsonb) from public;
revoke all on function online_private.set_return_request_status(uuid, uuid, uuid, text, text) from public;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function online_private.track_storefront_order(uuid, uuid, text, text) to service_role';
    execute 'grant execute on function online_private.request_storefront_return(uuid, uuid, text, text, text, text, jsonb) to service_role';
    execute 'grant execute on function online_private.set_return_request_status(uuid, uuid, uuid, text, text) to service_role';
    execute 'grant execute on function online_private.list_return_requests(uuid, text, uuid, integer) to service_role';
  end if;
end;
$block$;
