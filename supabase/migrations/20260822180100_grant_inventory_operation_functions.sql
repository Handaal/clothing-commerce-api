-- Phase 2C: grants for the new inventory operation functions.
-- The privilege boundary is unchanged from Phase 2B: only service_role may EXECUTE the sanctioned
-- mutation paths, and it still holds no direct INSERT/UPDATE/DELETE on any inventory table. anon and
-- authenticated receive nothing new -- they cannot use the private schema and cannot execute the
-- functions. No new tables are introduced, so there are no new RLS policies.

do $block$
declare
  inventory_operation_functions constant text[] := array[
    'inventory_private.record_opening(uuid, uuid, uuid, bigint, uuid, text, timestamptz, text)',
    'inventory_private.record_count_adjustment(uuid, uuid, uuid, bigint, bigint, uuid, text, timestamptz, text)'
  ];
  function_signature text;
begin
  foreach function_signature in array inventory_operation_functions loop
    execute pg_catalog.format('revoke all on function %s from public', function_signature);

    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
      execute pg_catalog.format('revoke all on function %s from anon', function_signature);
    end if;

    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
      execute pg_catalog.format('revoke all on function %s from authenticated', function_signature);
    end if;

    -- service_role may EXECUTE the sanctioned functions only. It gains no table DML; the functions
    -- run as inventory_writer, the sole role able to write inventory.
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
      execute pg_catalog.format('grant execute on function %s to service_role', function_signature);
    end if;
  end loop;
end;
$block$;
