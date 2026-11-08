-- Variant unit cost: a single current cost basis per variant, in minor units.
--
-- The POS needs an inventory valuation ("total stock value" = sum of unit_cost * on_hand)
-- alongside the existing selling value. Unlike supplier purchase costs (immutable AP/history
-- facts), this is the merchant's current replacement/cost basis for the variant, entered when
-- stock is created or received. It is deliberately a simple overwritable column on the variant
-- (not a costing engine): no FIFO/weighted-average, no COGS. Nullable so existing variants and
-- variants whose cost is unknown simply do not contribute to the valuation.

alter table public.product_variants
  add column unit_cost_minor bigint
  constraint product_variants_unit_cost_nonnegative
    check (unit_cost_minor is null or (unit_cost_minor >= 0 and unit_cost_minor <= 9007199254740991));

comment on column public.product_variants.unit_cost_minor is
  'Current merchant cost basis for the variant in minor units; null when unknown. Not a costing engine (no FIFO/COGS).';

-- Sanctioned write (catalog_private, service_role only): overwrite the current unit cost.
-- Reuses the shared idempotency helpers so a retried write is a no-op replay.
create function catalog_private.set_variant_cost(
  p_tenant_id uuid,
  p_variant_id uuid,
  p_unit_cost_minor bigint,
  p_idempotency_key text
)
returns table (variant_id uuid, unit_cost_minor bigint)
language plpgsql
security invoker
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_replay jsonb;
begin
  if p_unit_cost_minor is null or p_unit_cost_minor < 0 then
    raise exception using errcode = '22023', message = 'unit cost must be zero or greater';
  end if;

  v_fingerprint := pg_catalog.md5(
    p_tenant_id::text || E'\n' || 'set_variant_cost' || E'\n' || p_variant_id::text || E'\n'
    || p_unit_cost_minor::text
  );

  v_replay := catalog_private.claim_write(p_tenant_id, p_idempotency_key, 'set_variant_cost', v_fingerprint);
  if v_replay is not null then
    return query select (v_replay ->> 'variant_id')::uuid, (v_replay ->> 'unit_cost_minor')::bigint;
    return;
  end if;

  -- Lock the variant so the cost write is atomic against a concurrent variant mutation.
  perform 1 from public.product_variants
  where tenant_id = p_tenant_id and id = p_variant_id and status <> 'archived'
  for update;
  if not found then
    raise exception using errcode = 'CT002', message = 'variant not found or archived';
  end if;

  update public.product_variants
  set unit_cost_minor = p_unit_cost_minor, updated_at = pg_catalog.now()
  where tenant_id = p_tenant_id and id = p_variant_id;

  perform catalog_private.complete_write(
    p_tenant_id, p_idempotency_key,
    pg_catalog.jsonb_build_object('variant_id', p_variant_id, 'unit_cost_minor', p_unit_cost_minor)
  );
  return query select p_variant_id, p_unit_cost_minor;
end;
$function$;

-- catalog_private revokes execute from public, so the new function needs an explicit service_role
-- grant for the server write repository to call it.
do $block$
begin
  execute 'revoke all on function catalog_private.set_variant_cost(uuid, uuid, bigint, text) from public';
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function catalog_private.set_variant_cost(uuid, uuid, bigint, text) to service_role';
  end if;
end;
$block$;
