-- Phase 2S-F2 release stabilization.
--
-- A pricing quote has no commercial side effects, but its canonical context/catalog helpers take
-- row locks so quote and checkout validate the same stable inputs. PostgreSQL therefore must execute
-- it in a read-write transaction even though it creates no Order, reservation, or redemption.
alter function online_private.quote_checkout(jsonb) volatile;

comment on function online_private.quote_checkout(jsonb) is
  'Non-consuming Storefront quote. VOLATILE is required because canonical context and catalog validation uses SELECT FOR SHARE; the function does not create commercial state.';

-- Settings topology checks are deliberately shared by the forward write and reverse dependency
-- guards. These helpers lock the operational rows read by a configuration write, closing the race
-- between enabling a dependency and making its Branch/Brand/InventoryLocation unusable.
create function settings_private.assert_storefront_operational(
  p_tenant uuid, p_brand uuid, p_location uuid
) returns void language plpgsql security definer set search_path = '' as $function$
begin
  perform 1
  from public.tenants t
  join public.brands b on b.tenant_id = t.id and b.id = p_brand
  join public.inventory_locations l on l.tenant_id = t.id and l.id = p_location
  where t.id = p_tenant
    and t.status = 'active'
    and b.status = 'active'
    and l.status = 'active'
    and l.is_sellable
    and l.is_fulfillment_enabled
  for share of t, b, l;
  if not found then
    raise exception using errcode = 'SF409',
      message = 'enabled storefront location is not operational';
  end if;
end;
$function$;

create function settings_private.assert_register_operational(
  p_tenant uuid, p_branch uuid, p_location uuid
) returns void language plpgsql security definer set search_path = '' as $function$
begin
  perform 1
  from public.branches b
  join public.inventory_locations l
    on l.tenant_id = b.tenant_id and l.id = p_location
  where b.tenant_id = p_tenant
    and b.id = p_branch
    and b.status = 'active'
    and l.status = 'active'
    and l.is_fulfillment_enabled
  for share of b, l;
  if not found then
    raise exception using errcode = 'RG409',
      message = 'active register topology is not operational';
  end if;
end;
$function$;

create function settings_private.assert_location_dependents(
  p_tenant uuid,
  p_location uuid,
  p_status text,
  p_sellable boolean,
  p_fulfillment boolean
) returns void language plpgsql security definer set search_path = '' as $function$
begin
  if (p_status is distinct from 'active' or p_sellable is distinct from true
      or p_fulfillment is distinct from true)
    and exists (
      select 1 from public.storefront_checkout_settings s
      where s.tenant_id = p_tenant and s.inventory_location_id = p_location and s.cod_enabled
    ) then
    raise exception using errcode = 'SD409',
      message = 'location is required by an enabled storefront';
  end if;

  if (p_status is distinct from 'active' or p_fulfillment is distinct from true)
    and exists (
      select 1 from public.registers r
      where r.tenant_id = p_tenant and r.default_inventory_location_id = p_location
        and r.status = 'active'
    ) then
    raise exception using errcode = 'RD409',
      message = 'location is required by an active register';
  end if;
end;
$function$;

create function settings_private.assert_branch_dependents(
  p_tenant uuid, p_branch uuid, p_status text
) returns void language plpgsql security definer set search_path = '' as $function$
begin
  if p_status is distinct from 'active'
    and exists (
      select 1 from public.registers r
      where r.tenant_id = p_tenant and r.branch_id = p_branch and r.status = 'active'
    ) then
    raise exception using errcode = 'RD409',
      message = 'branch is required by an active register';
  end if;
end;
$function$;

create function settings_private.assert_brand_dependents(
  p_tenant uuid, p_brand uuid, p_status text
) returns void language plpgsql security definer set search_path = '' as $function$
begin
  if p_status is distinct from 'active'
    and exists (
      select 1 from public.storefront_checkout_settings s
      where s.tenant_id = p_tenant and s.brand_id = p_brand and s.cod_enabled
    ) then
    raise exception using errcode = 'SD409',
      message = 'brand is required by an enabled storefront';
  end if;
end;
$function$;

-- Preserve the reviewed Phase 2R mutation bodies as private implementation functions. The wrappers
-- perform replay first (accepted commands remain exact-replayable after later topology changes), then
-- enforce the new forward/reverse topology contracts before delegating to those bodies.
alter function settings_private.write_brand(uuid, uuid, uuid, text, jsonb)
  rename to write_brand_unchecked;
alter function settings_private.write_branch(uuid, uuid, uuid, text, jsonb)
  rename to write_branch_unchecked;
alter function settings_private.write_inventory_location(uuid, uuid, uuid, text, jsonb)
  rename to write_inventory_location_unchecked;
alter function settings_private.write_register(uuid, uuid, uuid, text, jsonb)
  rename to write_register_unchecked;
alter function settings_private.write_storefront(uuid, uuid, uuid, text, jsonb)
  rename to write_storefront_unchecked;

create function settings_private.write_brand(
  p_tenant uuid, p_brand uuid, p_actor uuid, p_key text, p_input jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_intent jsonb; v_replay jsonb; v_cur public.brands; v_status text;
begin
  v_intent := jsonb_build_object(
    'op', 'write_brand', 'brand', p_brand, 'actor', p_actor, 'input', p_input
  );
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;
  if p_brand is not null then
    select * into v_cur from public.brands
      where tenant_id = p_tenant and id = p_brand for update;
    if found then
      v_status := settings_private.next_status(v_cur.status, p_input);
      perform settings_private.assert_brand_dependents(p_tenant, p_brand, v_status);
    end if;
  end if;
  return settings_private.write_brand_unchecked(p_tenant, p_brand, p_actor, p_key, p_input);
end;
$function$;

create function settings_private.write_branch(
  p_tenant uuid, p_branch uuid, p_actor uuid, p_key text, p_input jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_intent jsonb; v_replay jsonb; v_cur public.branches; v_status text;
begin
  v_intent := jsonb_build_object(
    'op', 'write_branch', 'branch', p_branch, 'actor', p_actor, 'input', p_input
  );
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;
  if p_branch is not null then
    select * into v_cur from public.branches
      where tenant_id = p_tenant and id = p_branch for update;
    if found then
      v_status := settings_private.next_status(v_cur.status, p_input);
      perform settings_private.assert_branch_dependents(p_tenant, p_branch, v_status);
    end if;
  end if;
  return settings_private.write_branch_unchecked(p_tenant, p_branch, p_actor, p_key, p_input);
end;
$function$;

create function settings_private.write_inventory_location(
  p_tenant uuid, p_location uuid, p_actor uuid, p_key text, p_input jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_intent jsonb; v_replay jsonb; v_cur public.inventory_locations;
  v_status text; v_sellable boolean; v_fulfillment boolean;
begin
  v_intent := jsonb_build_object(
    'op', 'write_inventory_location', 'location', p_location, 'actor', p_actor, 'input', p_input
  );
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;
  if p_location is not null then
    select * into v_cur from public.inventory_locations
      where tenant_id = p_tenant and id = p_location for update;
    if found then
      v_status := settings_private.next_status(v_cur.status, p_input);
      v_sellable := case when p_input ? 'isSellable'
        then (p_input ->> 'isSellable')::boolean else v_cur.is_sellable end;
      v_fulfillment := case when p_input ? 'isFulfillmentEnabled'
        then (p_input ->> 'isFulfillmentEnabled')::boolean else v_cur.is_fulfillment_enabled end;
      perform settings_private.assert_location_dependents(
        p_tenant, p_location, v_status, v_sellable, v_fulfillment
      );
    end if;
  end if;
  return settings_private.write_inventory_location_unchecked(
    p_tenant, p_location, p_actor, p_key, p_input
  );
end;
$function$;

create function settings_private.write_register(
  p_tenant uuid, p_register uuid, p_actor uuid, p_key text, p_input jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_intent jsonb; v_replay jsonb; v_cur public.registers;
  v_branch uuid; v_location uuid; v_location_branch uuid; v_status text;
begin
  v_intent := jsonb_build_object(
    'op', 'write_register', 'register', p_register, 'actor', p_actor, 'input', p_input
  );
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  if p_register is null then
    v_branch := (p_input ->> 'branchId')::uuid;
    v_location := (p_input ->> 'defaultInventoryLocationId')::uuid;
    v_status := coalesce(p_input ->> 'status', 'inactive');
  else
    select * into v_cur from public.registers
      where tenant_id = p_tenant and id = p_register for update;
    if found then
      v_branch := v_cur.branch_id;
      v_location := case when p_input ? 'defaultInventoryLocationId'
        then (p_input ->> 'defaultInventoryLocationId')::uuid
        else v_cur.default_inventory_location_id end;
      v_status := settings_private.next_status(v_cur.status, p_input);
    end if;
  end if;
  if v_status = 'active' then
    select branch_id into v_location_branch
    from public.inventory_locations
    where tenant_id = p_tenant and id = v_location;
    -- Preserve the established composite-FK error for a cross-branch location. Operational
    -- readiness applies after that existing relationship invariant is satisfied.
    if not found or v_location_branch is not distinct from v_branch then
      perform settings_private.assert_register_operational(p_tenant, v_branch, v_location);
    end if;
  end if;
  return settings_private.write_register_unchecked(p_tenant, p_register, p_actor, p_key, p_input);
end;
$function$;

create function settings_private.write_storefront(
  p_tenant uuid, p_brand uuid, p_actor uuid, p_key text, p_input jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_intent jsonb; v_replay jsonb; v_cur public.storefront_checkout_settings;
  v_location uuid; v_enabled boolean;
begin
  v_intent := jsonb_build_object(
    'op', 'write_storefront', 'brand', p_brand, 'actor', p_actor, 'input', p_input
  );
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  select * into v_cur from public.storefront_checkout_settings
    where tenant_id = p_tenant and brand_id = p_brand for update;
  if found then
    v_location := case when p_input ? 'inventoryLocationId'
      then (p_input ->> 'inventoryLocationId')::uuid else v_cur.inventory_location_id end;
    v_enabled := case when p_input ? 'codEnabled'
      then (p_input ->> 'codEnabled')::boolean else v_cur.cod_enabled end;
  else
    v_location := (p_input ->> 'inventoryLocationId')::uuid;
    v_enabled := coalesce((p_input ->> 'codEnabled')::boolean, false);
  end if;
  if v_enabled then
    perform settings_private.assert_storefront_operational(p_tenant, p_brand, v_location);
  end if;
  return settings_private.write_storefront_unchecked(p_tenant, p_brand, p_actor, p_key, p_input);
end;
$function$;

-- The renamed implementation functions are not transport entrypoints. Only the hardened wrappers
-- retain service-role EXECUTE; anon/authenticated remain unable even to use the schema.
revoke all on function settings_private.write_brand_unchecked(uuid, uuid, uuid, text, jsonb),
  settings_private.write_branch_unchecked(uuid, uuid, uuid, text, jsonb),
  settings_private.write_inventory_location_unchecked(uuid, uuid, uuid, text, jsonb),
  settings_private.write_register_unchecked(uuid, uuid, uuid, text, jsonb),
  settings_private.write_storefront_unchecked(uuid, uuid, uuid, text, jsonb),
  settings_private.assert_storefront_operational(uuid, uuid, uuid),
  settings_private.assert_register_operational(uuid, uuid, uuid),
  settings_private.assert_location_dependents(uuid, uuid, text, boolean, boolean),
  settings_private.assert_branch_dependents(uuid, uuid, text),
  settings_private.assert_brand_dependents(uuid, uuid, text)
from public, anon, authenticated, service_role;

grant create on schema settings_private to settings_writer;
alter function settings_private.assert_storefront_operational(uuid, uuid, uuid) owner to settings_writer;
alter function settings_private.assert_register_operational(uuid, uuid, uuid) owner to settings_writer;
alter function settings_private.assert_location_dependents(uuid, uuid, text, boolean, boolean) owner to settings_writer;
alter function settings_private.assert_branch_dependents(uuid, uuid, text) owner to settings_writer;
alter function settings_private.assert_brand_dependents(uuid, uuid, text) owner to settings_writer;
alter function settings_private.write_brand(uuid, uuid, uuid, text, jsonb) owner to settings_writer;
alter function settings_private.write_branch(uuid, uuid, uuid, text, jsonb) owner to settings_writer;
alter function settings_private.write_inventory_location(uuid, uuid, uuid, text, jsonb) owner to settings_writer;
alter function settings_private.write_register(uuid, uuid, uuid, text, jsonb) owner to settings_writer;
alter function settings_private.write_storefront(uuid, uuid, uuid, text, jsonb) owner to settings_writer;
revoke create on schema settings_private from settings_writer;

revoke all on function settings_private.write_brand(uuid, uuid, uuid, text, jsonb),
  settings_private.write_branch(uuid, uuid, uuid, text, jsonb),
  settings_private.write_inventory_location(uuid, uuid, uuid, text, jsonb),
  settings_private.write_register(uuid, uuid, uuid, text, jsonb),
  settings_private.write_storefront(uuid, uuid, uuid, text, jsonb)
from public, anon, authenticated, service_role;

grant execute on function settings_private.write_brand(uuid, uuid, uuid, text, jsonb),
  settings_private.write_branch(uuid, uuid, uuid, text, jsonb),
  settings_private.write_inventory_location(uuid, uuid, uuid, text, jsonb),
  settings_private.write_register(uuid, uuid, uuid, text, jsonb),
  settings_private.write_storefront(uuid, uuid, uuid, text, jsonb)
to service_role;
