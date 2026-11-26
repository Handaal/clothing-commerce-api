-- ADR-042 §3.5 (Finding C) — no silent last-writer-wins between concurrent Website/POS splits.
--
-- allocate_channel_stock sets ABSOLUTE website/pos targets and only guarded the canonical balance version,
-- which a split does not change. Two admins who loaded the same numbers could therefore both save and the
-- later one silently replaced the earlier split. This migration adds a per-(location, variant) allocation
-- version, bumped by every committed split, and a guarded entry point:
--
--   allocate_channel_stock_v2(tenant, location, actor, reason, key, lines)
--     * every line MUST carry expectedBalanceVersion AND expectedAllocationVersion (CH428 otherwise);
--     * the same advisory key lock and balance row locks as the split (lock order unchanged: balances by
--       variant -> location -> channel rows), so concurrent splits on a variant serialize; the loser re-reads
--       the committed version (READ COMMITTED, new statement snapshot) and gets CH409 with the CURRENT values
--       of every stale line in the error detail (JSON) — nothing is written;
--     * all-or-nothing per request: any stale/invalid line aborts the whole batch (one transaction);
--     * idempotency: an exact replay of the same key returns the original run even though the versions have
--       since moved; the same key with any different line (including different expected versions) is ID409.
-- The original allocate_channel_stock remains for the data layer only (now callable solely through v2: its
-- service_role grant is revoked) so no path can split without the version guard.

alter table public.inventory_channel_balances add column allocation_version bigint not null default 0;

create table public.inventory_allocation_run_guards (
  tenant_id uuid not null,
  normalized_idempotency_key text not null,
  allocation_run_id uuid not null,
  guard_fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, normalized_idempotency_key)
);
alter table public.inventory_allocation_run_guards enable row level security;
revoke all on public.inventory_allocation_run_guards from public;

-- Current versions for the split screen: canonical balance version + allocation version per variant.
create function inventory_private.channel_versions(p_tenant_id uuid, p_location_id uuid)
returns table(variant_id uuid, balance_version bigint, allocation_version bigint)
language sql stable security definer set search_path = '' as $function$
  select k.variant_id, coalesce(ib.version, 0)::bigint,
         coalesce((select max(b.allocation_version) from public.inventory_channel_balances b
                    where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
                      and b.variant_id = k.variant_id), 0)::bigint
    from (select ib2.variant_id from public.inventory_balances ib2
           where ib2.tenant_id = p_tenant_id and ib2.inventory_location_id = p_location_id
          union
          select b2.variant_id from public.inventory_channel_balances b2
           where b2.tenant_id = p_tenant_id and b2.inventory_location_id = p_location_id) k
    left join public.inventory_balances ib
      on ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id and ib.variant_id = k.variant_id;
$function$;

create function inventory_private.allocate_channel_stock_v2(
  p_tenant_id uuid, p_location_id uuid, p_actor_membership_id uuid, p_reason text,
  p_idempotency_key text, p_lines jsonb
) returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_norm text := lower(btrim(coalesce(p_idempotency_key, '')));
  v_guard_fp text; v_existing public.inventory_allocation_run_guards%rowtype; v_line jsonb;
  v_variant uuid; v_balance_version bigint; v_allocation_version bigint; v_stale jsonb := '[]'::jsonb;
  v_run uuid; v_detail jsonb;
begin
  if v_norm = '' then
    raise exception using errcode = '22023', message = 'idempotency_key is required';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = '22023', message = 'between 1 and 1000 allocation lines are required';
  end if;
  for v_line in select x.value from jsonb_array_elements(p_lines) x loop
    if jsonb_typeof(v_line) <> 'object'
       or coalesce(v_line ->> 'expectedBalanceVersion', '') !~ '^[0-9]{1,18}$'
       or coalesce(v_line ->> 'expectedAllocationVersion', '') !~ '^[0-9]{1,18}$' then
      raise exception using errcode = 'CH428', message = 'every allocation line needs expectedBalanceVersion and expectedAllocationVersion';
    end if;
  end loop;
  select md5(p_tenant_id::text || E'\n' || p_location_id::text || E'\n' || coalesce(p_actor_membership_id::text, '')
             || E'\n' || btrim(coalesce(p_reason, '')) || E'\n'
             || string_agg(x.value ->> 'variantId' || ',' || coalesce(x.value ->> 'websiteQuantity', '') || ','
                           || coalesce(x.value ->> 'posQuantity', '') || ',' || (x.value ->> 'expectedBalanceVersion')
                           || ',' || (x.value ->> 'expectedAllocationVersion'), E'\n' order by x.value ->> 'variantId'))
    into v_guard_fp from jsonb_array_elements(p_lines) x;

  -- Same advisory key as allocate_channel_stock: replays of one key serialize.
  perform pg_advisory_xact_lock(hashtextextended('channel-allocation:' || p_tenant_id::text || ':' || v_norm, 0));
  select * into v_existing from public.inventory_allocation_run_guards g
   where g.tenant_id = p_tenant_id and g.normalized_idempotency_key = v_norm;
  if found then
    if v_existing.guard_fingerprint <> v_guard_fp then
      raise exception using errcode = 'ID409', message = 'idempotency key reused with a different payload';
    end if;
    return v_existing.allocation_run_id;
  end if;
  if exists (select 1 from public.inventory_allocation_runs r
              where r.tenant_id = p_tenant_id and r.normalized_idempotency_key = v_norm) then
    -- A key first used through an unguarded path can never be replayed as a guarded split.
    raise exception using errcode = 'ID409', message = 'idempotency key reused with a different payload';
  end if;

  -- A legacy / unknown location is reported as such before any version comparison.
  perform 1 from public.inventory_locations l where l.tenant_id = p_tenant_id and l.id = p_location_id;
  if not found then raise exception using errcode = 'CH404', message = 'inventory location not found'; end if;
  if (select l.channel_stock_mode from public.inventory_locations l
       where l.tenant_id = p_tenant_id and l.id = p_location_id) = 'legacy' then
    raise exception using errcode = 'CH412', message = 'channel stock not initialized for this location';
  end if;

  -- Lock order: balances (by variant) -> location -> channel rows (allocate_channel_stock re-takes them).
  perform 1 from public.inventory_balances ib
   where ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id
     and ib.variant_id in (select (x.value ->> 'variantId')::uuid from jsonb_array_elements(p_lines) x)
   order by ib.variant_id for update;
  perform 1 from public.inventory_locations l where l.tenant_id = p_tenant_id and l.id = p_location_id for share;

  for v_line in select x.value from jsonb_array_elements(p_lines) x order by (x.value ->> 'variantId') loop
    v_variant := (v_line ->> 'variantId')::uuid;
    select coalesce((select ib.version from public.inventory_balances ib
                      where ib.tenant_id = p_tenant_id and ib.inventory_location_id = p_location_id
                        and ib.variant_id = v_variant), 0),
           coalesce((select max(b.allocation_version) from public.inventory_channel_balances b
                      where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
                        and b.variant_id = v_variant), 0)
      into v_balance_version, v_allocation_version;
    if v_balance_version <> (v_line ->> 'expectedBalanceVersion')::bigint
       or v_allocation_version <> (v_line ->> 'expectedAllocationVersion')::bigint then
      select jsonb_build_object('variantId', v_variant, 'balanceVersion', v_balance_version,
               'allocationVersion', v_allocation_version,
               'websiteOnHand', coalesce(sum(b.on_hand_qty) filter (where b.channel = 'website'), 0),
               'posOnHand', coalesce(sum(b.on_hand_qty) filter (where b.channel = 'pos'), 0),
               'unallocatedOnHand', coalesce(sum(b.on_hand_qty) filter (where b.channel = 'unallocated'), 0),
               'posReserved', coalesce(sum(b.reserved_qty) filter (where b.channel = 'pos'), 0))
        into v_detail from public.inventory_channel_balances b
       where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id and b.variant_id = v_variant;
      v_stale := v_stale || jsonb_build_array(v_detail);
    end if;
  end loop;
  if jsonb_array_length(v_stale) > 0 then
    raise exception using errcode = 'CH409', message = 'stock or split changed since it was read; reload and retry',
      detail = jsonb_build_object('stale', v_stale)::text;
  end if;

  v_run := inventory_private.allocate_channel_stock(p_tenant_id, p_location_id, p_actor_membership_id, p_reason,
             p_idempotency_key, (select jsonb_agg(x.value - 'expectedAllocationVersion') from jsonb_array_elements(p_lines) x));

  update public.inventory_channel_balances b
     set allocation_version = b.allocation_version + 1
   where b.tenant_id = p_tenant_id and b.inventory_location_id = p_location_id
     and b.variant_id in (select (x.value ->> 'variantId')::uuid from jsonb_array_elements(p_lines) x);
  insert into public.inventory_allocation_run_guards (tenant_id, normalized_idempotency_key, allocation_run_id, guard_fingerprint)
  values (p_tenant_id, v_norm, v_run, v_guard_fp);
  return v_run;
end;
$function$;

grant create on schema public, inventory_private to inventory_writer;
alter table public.inventory_allocation_run_guards owner to inventory_writer;
alter function inventory_private.channel_versions(uuid, uuid) owner to inventory_writer;
alter function inventory_private.allocate_channel_stock_v2(uuid, uuid, uuid, text, text, jsonb) owner to inventory_writer;
revoke create on schema public, inventory_private from inventory_writer;
revoke all on function inventory_private.channel_versions(uuid, uuid) from public;
revoke all on function inventory_private.allocate_channel_stock_v2(uuid, uuid, uuid, text, text, jsonb) from public;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function inventory_private.channel_versions(uuid, uuid) to service_role;
    grant execute on function inventory_private.allocate_channel_stock_v2(uuid, uuid, uuid, text, text, jsonb) to service_role;
    revoke execute on function inventory_private.allocate_channel_stock(uuid, uuid, uuid, text, text, jsonb) from service_role;
  end if;
end $b$;
