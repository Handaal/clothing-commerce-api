-- Phase 2E (4/7): the narrow inventory custody primitive a Fulfillment issues through, plus the
-- minimum read capability it needs to authoritatively check the Location.
--
-- inventory_private.record_fulfillment_issue is the ONLY additional inventory write path introduced by
-- Phase 2E. It is SECURITY DEFINER, owned by inventory_writer (the same role that owns the ledger and
-- record_operation), runs with an empty search_path and full schema qualification, and uses no dynamic
-- SQL. It is granted to fulfillments_writer ONLY -- never to service_role, anon, authenticated, or
-- PUBLIC. service_role therefore can never issue fulfillment stock directly; only the sanctioned
-- fulfillments_private.record_fulfillment (running as fulfillments_writer) can reach it.
--
-- Custom SQLSTATEs are internal-only signals mapped to stable application errors by the repository:
--   FF020 = fulfillment Location not found in tenant
--   FF021 = Location not active
--   FF022 = Location active but not fulfillment-enabled

-- The authoritative Location capability check reads public.inventory_locations. inventory_writer is not
-- the table owner and is NOBYPASSRLS, so under the foundational RLS (enabled, not forced) a plain
-- SELECT grant alone returns zero rows. Grant SELECT AND add a narrow permissive SELECT policy scoped
-- to this internal, non-login role so the definer function can read the row. The function itself always
-- filters by the verified tenant. inventory_writer gets NO insert/update/delete on inventory_locations:
-- it can read lifecycle/capability state but can never mutate it.
grant select on table public.inventory_locations to inventory_writer;

create policy inventory_writer_fulfillment_read
on public.inventory_locations
for select
to inventory_writer
using (true);

comment on policy inventory_writer_fulfillment_read on public.inventory_locations is
  'Lets the SECURITY DEFINER inventory_private.record_fulfillment_issue (running as inventory_writer) read Location status/capability. Read-only; inventory_writer holds no DML on this table.';

-- fulfillments_writer calls the qualified inventory_private.record_fulfillment_issue, so it needs USAGE
-- on the schema and EXECUTE on that ONE function only. It gets NO USAGE-derived access to any other
-- inventory_private function; in particular it can never EXECUTE the generic record_operation.
grant usage on schema inventory_private to fulfillments_writer;

-- Narrow custody exit for a Fulfillment. Acquires the Location lifecycle lock, verifies the Location is
-- active AND fulfillment-enabled, validates every movement is a NEGATIVE delta targeting exactly the
-- one Location, forces operation_type='issue', and delegates the ledger/balance write to the audited
-- record_operation. It never duplicates ledger or balance logic.
create function inventory_private.record_fulfillment_issue(
  p_tenant_id uuid,
  p_inventory_location_id uuid,
  p_movements jsonb,
  p_actor_membership_id uuid default null,
  p_idempotency_key text default null,
  p_occurred_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text;
  v_fulfillment_enabled boolean;
  v_element jsonb;
  v_operation_id uuid;
begin
  if p_tenant_id is null or p_inventory_location_id is null then
    raise exception using errcode = '22004', message = 'tenant and inventory location are required';
  end if;

  if pg_catalog.jsonb_typeof(p_movements) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_movements) = 0 then
    raise exception using errcode = '22023', message = 'at least one fulfillment movement is required';
  end if;

  -- Lock class 2: serialize this capability read against any future sanctioned Location lifecycle
  -- mutation for (tenant, location) BEFORE reading status/capability, so a concurrent deactivation can
  -- never slip between the read and the issue.
  perform commerce_locks.acquire_inventory_location_lifecycle_lock(p_tenant_id, p_inventory_location_id);

  select location.status, location.is_fulfillment_enabled
  into v_status, v_fulfillment_enabled
  from public.inventory_locations as location
  where location.tenant_id = p_tenant_id
    and location.id = p_inventory_location_id;

  if not found then
    raise exception using errcode = 'FF020', message = 'fulfillment location not found';
  end if;

  -- An inactive/archived Location can never fulfill; a merely-active Location must ALSO be explicitly
  -- fulfillment-enabled. The two are distinguished so the caller can surface a precise reason.
  if v_status is distinct from 'active' then
    raise exception using errcode = 'FF021', message = 'inventory location is not active';
  end if;

  if v_fulfillment_enabled is distinct from true then
    raise exception using errcode = 'FF022', message = 'inventory location is not fulfillment-enabled';
  end if;

  -- Every movement must be a NEGATIVE delta (a Fulfillment only issues out) targeting EXACTLY the one
  -- Location. This closes any attempt to smuggle a positive/receiving movement or a foreign location
  -- through the fulfillment path.
  for v_element in
    select ordered.value
    from pg_catalog.jsonb_array_elements(p_movements) as ordered(value)
  loop
    if (v_element ->> 'inventory_location_id') is null
      or (v_element ->> 'inventory_location_id')::uuid is distinct from p_inventory_location_id then
      raise exception using
        errcode = '22023',
        message = 'every fulfillment movement must target the single fulfillment location';
    end if;

    if (v_element ->> 'quantity_delta') is null or (v_element ->> 'quantity_delta')::bigint >= 0 then
      raise exception using
        errcode = '22023',
        message = 'every fulfillment movement must be a negative (issue) delta';
    end if;
  end loop;

  -- Force operation_type='issue' (the existing generic physical exit; never 'sale'/'return'/a new
  -- fulfillment type) and delegate to the audited path, which applies canonical lock ordering,
  -- nonnegative enforcement, and fingerprinted idempotency.
  v_operation_id := inventory_private.record_operation(
    p_tenant_id,
    'issue',
    p_movements,
    p_actor_membership_id,
    p_idempotency_key,
    p_occurred_at,
    null
  );

  return v_operation_id;
end;
$function$;

comment on function inventory_private.record_fulfillment_issue(uuid, uuid, jsonb, uuid, text, timestamptz) is
  'Narrow custody exit for a Fulfillment. Acquires the Location lifecycle lock, requires active + is_fulfillment_enabled, enforces negative deltas at exactly one Location, forces operation_type=issue, and delegates to record_operation. Granted to fulfillments_writer only.';

-- Transfer ownership to inventory_writer so the definer function writes as the same role that owns the
-- ledger, while service_role (which never gets EXECUTE here) holds no path to it. Grant CREATE only for
-- the transfer and revoke immediately after.
grant create on schema inventory_private to inventory_writer;
alter function inventory_private.record_fulfillment_issue(uuid, uuid, jsonb, uuid, text, timestamptz)
  owner to inventory_writer;
revoke create on schema inventory_private from inventory_writer;

-- Deny PUBLIC (anon/authenticated) and grant EXECUTE to fulfillments_writer ONLY. service_role is
-- deliberately NOT granted: it must never issue fulfillment stock directly.
revoke all on function inventory_private.record_fulfillment_issue(uuid, uuid, jsonb, uuid, text, timestamptz)
  from public;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function inventory_private.record_fulfillment_issue(uuid, uuid, jsonb, uuid, text, timestamptz) from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function inventory_private.record_fulfillment_issue(uuid, uuid, jsonb, uuid, text, timestamptz) from authenticated';
  end if;
end;
$block$;

grant execute on function inventory_private.record_fulfillment_issue(uuid, uuid, jsonb, uuid, text, timestamptz)
  to fulfillments_writer;
