-- Phase 2R-A: operational settings management (tenant/business, brands, branches, warehouses,
-- inventory locations, registers, storefront checkout, return policy, and device governance).
--
-- This is NOT a generic settings engine and it does NOT redesign the organization model. It exposes the
-- EXISTING foundational tables through a hardened mutation boundary so a retailer can operate V1 without a
-- developer editing the database. Enforcement mirrors every prior write domain: a dedicated non-login
-- settings_writer role owns the SECURITY DEFINER functions and the tables it must mutate; service_role is
-- transport only (schema usage + per-function execute, never DML); every function has an empty
-- search_path with fully-qualified names, derives the tenant from the caller-supplied verified id, and is
-- idempotent through a single settings_commands ledger.
--
-- Frozen mutation-safety invariants enforced here (see docs/settings/operational-settings-core.md):
--   * tenant slug/normalized_slug/status are never mutable; default_currency is mutable only until the
--     tenant has ANY order (same value is always a no-op).
--   * brand/branch/warehouse/register `code` and inventory-location parent + location_type are immutable
--     after creation. Nothing is hard-deleted: lifecycle is activate/deactivate/archive only.
--   * register selling_currency is mutable only until the register has its first POS order; storefront
--     currency only until the brand has its first ONLINE order (same value is always a no-op).
--   * a register/branch default inventory location must belong to that branch (existing composite FKs).
--   * device private-key material never exists here; enrollment/rotation stay device-side. Admin may only
--     list/revoke devices and manage the append-only register/device assignment intervals.

-- ============================================================================================
-- Role + private schema + permission catalog + idempotency ledger.
-- ============================================================================================
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'settings_writer') then
    create role settings_writer nologin noinherit nobypassrls;
  end if;
  execute pg_catalog.format('grant settings_writer to %I with set true', current_user);
end;
$block$;

comment on role settings_writer is
  'Owns the operational-settings mutation functions and the organization/config tables they edit. Never a login or client role.';

create schema settings_private;
revoke all on schema settings_private from public, anon, authenticated;
grant usage on schema public, settings_private to settings_writer;

-- settings.read / settings.manage are ONE coherent tenant-wide permission pair. Read and manage remain
-- independent (neither implies the other); a scoped brand/branch grant never confers tenant-wide settings.
insert into public.permissions (key, description) values
  ('settings.read', 'Read tenant-wide operational settings (business, organization, devices, storefront, returns).'),
  ('settings.manage', 'Manage tenant-wide operational settings and device governance.')
on conflict (key) do nothing;

-- New settings-owned columns on the existing organization tables.
alter table public.tenants
  add column tax_identifier text,
  add constraint tenants_tax_identifier_bound check (
    tax_identifier is null or length(btrim(tax_identifier)) between 1 and 100
  );
comment on column public.tenants.tax_identifier is
  'Optional tenant tax/registration identifier surfaced on receipts. Free-form; never a slug or currency.';

alter table public.branches
  add column receipt_footer text,
  add constraint branches_receipt_footer_bound check (
    receipt_footer is null or length(btrim(receipt_footer)) between 1 and 2000
  );
comment on column public.branches.receipt_footer is
  'Optional plain-text footer line rendered on this branch''s POS receipts. Not a receipt template.';

create table public.settings_commands (
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  normalized_key text not null check (length(normalized_key) between 1 and 200),
  intent jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, normalized_key)
);
comment on table public.settings_commands is
  'Idempotency ledger for every operational-settings mutation: same (tenant,key) + intent replays the stored response; a changed intent conflicts.';

-- ============================================================================================
-- Ownership + RLS. Rather than reassign ownership of the foundational organization tables (which other
-- writer roles already own or read), settings_writer follows the EXACT precedent offline_pos_writer set
-- for public.devices: it receives least-privilege DML grants plus a permissive `FOR ALL` policy on each
-- table it must mutate. settings_writer is nobypassrls, so both the grant and the policy are required.
-- Clients still get no direct DML: only the SECURITY DEFINER functions below run as settings_writer.
-- Ownership of the config tables (owned by online_writer / returns_writer) is left untouched.
-- ============================================================================================
alter table public.settings_commands enable row level security;
revoke all on public.settings_commands from public, anon, authenticated, service_role;
grant create on schema public to settings_writer;
alter table public.settings_commands owner to settings_writer;
revoke create on schema public from settings_writer;

do $block$
declare t text;
begin
  -- Full manage (insert + update) on the config the domain creates and edits. No hard delete of any
  -- commercial organization entity: lifecycle is activate/deactivate/archive, so DELETE is never granted
  -- on these (branch_brands eligibility is the only replace-in-place set, handled below).
  foreach t in array array[
    'brands', 'branches', 'warehouses', 'inventory_locations', 'registers',
    'devices', 'register_device_assignments', 'storefront_checkout_settings', 'return_settings'
  ] loop
    execute format('grant select, insert, update on public.%I to settings_writer', t);
    execute format('create policy settings_writer_manage on public.%I for all to settings_writer using (true) with check (true)', t);
  end loop;

  -- Tenant business profile is edited in place; the row is never created or deleted here.
  grant select, update on public.tenants to settings_writer;
  create policy settings_writer_manage on public.tenants for all to settings_writer using (true) with check (true);

  -- Brand eligibility is a replace-in-place association set, so DELETE is required for it alone.
  grant select, insert, delete on public.branch_brands to settings_writer;
  create policy settings_writer_manage on public.branch_brands for all to settings_writer using (true) with check (true);

  -- Read-only dependency: currency locks test for the FIRST order per tenant / register / online brand.
  grant select on public.orders to settings_writer;
  create policy settings_writer_read on public.orders for select to settings_writer using (true);
end;
$block$;

-- ============================================================================================
-- Shared idempotency helpers. replay() takes the per-command advisory lock and returns the stored
-- response on an exact replay (or raises on an intent conflict); a null return means "proceed".
-- record() persists the canonical intent + response under the normalized key.
-- ============================================================================================
create function settings_private.replay(p_tenant uuid, p_key text, p_intent jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_key text := lower(btrim(p_key)); v_old public.settings_commands;
begin
  if p_tenant is null or p_key is null or length(v_key) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid settings command key';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('settings:' || p_tenant::text || ':' || v_key, 0));
  select * into v_old from public.settings_commands where tenant_id = p_tenant and normalized_key = v_key;
  if found then
    if v_old.intent is distinct from p_intent then
      raise exception using errcode = 'ID409', message = 'settings idempotency key reused with a different payload';
    end if;
    return v_old.response;
  end if;
  return null;
end;
$f$;

create function settings_private.record(p_tenant uuid, p_key text, p_intent jsonb, p_response jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
begin
  insert into public.settings_commands (tenant_id, normalized_key, intent, response)
  values (p_tenant, lower(btrim(p_key)), p_intent, p_response);
  return p_response;
end;
$f$;

-- Rejects any input object that carries keys outside the domain allowlist, so an unknown/forbidden field
-- (e.g. slug, status on the tenant) can never be silently ignored.
create function settings_private.only_keys(p_input jsonb, p_allowed text[])
returns void language plpgsql immutable set search_path = '' as $f$
begin
  if pg_catalog.jsonb_typeof(p_input) is distinct from 'object' or p_input = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'a non-empty settings object is required';
  end if;
  if (p_input - p_allowed) <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'unknown settings field';
  end if;
end;
$f$;

create function settings_private.text_array(p jsonb) returns text[]
language sql immutable set search_path = '' as $f$
  select case
    when p is null or pg_catalog.jsonb_typeof(p) = 'null' then null
    else (select pg_catalog.array_agg(x) from pg_catalog.jsonb_array_elements_text(p) x)
  end
$f$;

-- ============================================================================================
-- Serializers (camelCase transport). Timestamps serialize to offset ISO strings via jsonb.
-- ============================================================================================
create function settings_private.business_json(t public.tenants) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', t.id, 'slug', t.slug, 'normalizedSlug', t.normalized_slug,
    'displayName', t.display_name, 'legalName', t.legal_name, 'status', t.status,
    'onboardingState', t.onboarding_state, 'defaultLocale', t.default_locale,
    'defaultTimezone', t.default_timezone, 'defaultCurrency', t.default_currency,
    'countryCode', t.country_code, 'contactEmail', t.contact_email, 'contactPhone', t.contact_phone,
    'taxIdentifier', t.tax_identifier, 'createdAt', t.created_at, 'updatedAt', t.updated_at)
$f$;

create function settings_private.brand_json(b public.brands) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', b.id, 'tenantId', b.tenant_id, 'code', b.code,
    'displayName', b.display_name, 'legalName', b.legal_name, 'status', b.status,
    'archivedAt', b.archived_at, 'archiveReason', b.archive_reason,
    'createdAt', b.created_at, 'updatedAt', b.updated_at)
$f$;

create function settings_private.branch_json(b public.branches) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', b.id, 'tenantId', b.tenant_id, 'code', b.code,
    'displayName', b.display_name, 'timezone', b.timezone, 'status', b.status,
    'addressLine1', b.address_line_1, 'addressLine2', b.address_line_2, 'city', b.city,
    'region', b.region, 'postalCode', b.postal_code, 'countryCode', b.country_code,
    'contactEmail', b.contact_email, 'contactPhone', b.contact_phone,
    'isFulfillmentEnabled', b.is_fulfillment_enabled,
    'isClickAndCollectEnabled', b.is_click_and_collect_enabled,
    'defaultInventoryLocationId', b.default_inventory_location_id, 'receiptFooter', b.receipt_footer,
    'archivedAt', b.archived_at, 'archiveReason', b.archive_reason,
    'createdAt', b.created_at, 'updatedAt', b.updated_at,
    'eligibleBrandIds', coalesce((select jsonb_agg(bb.brand_id order by bb.brand_id)
      from public.branch_brands bb where bb.tenant_id = b.tenant_id and bb.branch_id = b.id), '[]'::jsonb))
$f$;

create function settings_private.warehouse_json(w public.warehouses) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', w.id, 'tenantId', w.tenant_id, 'code', w.code,
    'displayName', w.display_name, 'timezone', w.timezone, 'status', w.status,
    'addressLine1', w.address_line_1, 'addressLine2', w.address_line_2, 'city', w.city,
    'region', w.region, 'postalCode', w.postal_code, 'countryCode', w.country_code,
    'contactEmail', w.contact_email, 'contactPhone', w.contact_phone,
    'isFulfillmentEnabled', w.is_fulfillment_enabled, 'isReceivingEnabled', w.is_receiving_enabled,
    'isTransferOriginEnabled', w.is_transfer_origin_enabled,
    'isTransferDestinationEnabled', w.is_transfer_destination_enabled,
    'archivedAt', w.archived_at, 'archiveReason', w.archive_reason,
    'createdAt', w.created_at, 'updatedAt', w.updated_at)
$f$;

create function settings_private.location_json(l public.inventory_locations) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', l.id, 'tenantId', l.tenant_id, 'branchId', l.branch_id,
    'warehouseId', l.warehouse_id, 'code', l.code, 'displayName', l.display_name,
    'locationType', l.location_type, 'status', l.status, 'isSellable', l.is_sellable,
    'isFulfillmentEnabled', l.is_fulfillment_enabled, 'isReceivingEnabled', l.is_receiving_enabled,
    'isTransferOriginEnabled', l.is_transfer_origin_enabled,
    'isTransferDestinationEnabled', l.is_transfer_destination_enabled,
    'archivedAt', l.archived_at, 'archiveReason', l.archive_reason,
    'createdAt', l.created_at, 'updatedAt', l.updated_at)
$f$;

create function settings_private.register_json(r public.registers) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', r.id, 'tenantId', r.tenant_id, 'branchId', r.branch_id,
    'code', r.code, 'displayName', r.display_name, 'status', r.status,
    'defaultInventoryLocationId', r.default_inventory_location_id, 'sellingCurrency', r.selling_currency,
    'archivedAt', r.archived_at, 'archiveReason', r.archive_reason,
    'createdAt', r.created_at, 'updatedAt', r.updated_at)
$f$;

create function settings_private.storefront_json(s public.storefront_checkout_settings) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('tenantId', s.tenant_id, 'brandId', s.brand_id,
    'inventoryLocationId', s.inventory_location_id, 'currency', s.currency, 'codEnabled', s.cod_enabled)
$f$;

create function settings_private.return_settings_json(s public.return_settings) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('tenantId', s.tenant_id, 'enabled', s.enabled, 'windowDays', s.window_days,
    'allowedReasons', to_jsonb(coalesce(s.allowed_reasons, array[]::text[])),
    'manualRefundsEnabled', s.manual_refunds_enabled, 'maxManualRefundMinor', s.max_manual_refund_minor)
$f$;

-- Device projection. NO private key / credential material is present in public.devices or exposed here.
create function settings_private.device_json(d public.devices) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', d.id, 'tenantId', d.tenant_id, 'installationId', d.installation_id,
    'deviceType', d.device_type, 'displayName', d.display_name, 'status', d.status,
    'clientVersion', d.client_version, 'platform', d.platform, 'osVersion', d.os_version,
    'activatedAt', d.activated_at, 'revokedAt', d.revoked_at, 'revocationReason', d.revocation_reason,
    'lastSeenAt', d.last_seen_at, 'createdAt', d.created_at, 'updatedAt', d.updated_at,
    'currentAssignment', (select jsonb_build_object('assignmentId', a.id, 'registerId', a.register_id,
        'registerName', rg.display_name, 'assignedAt', a.assigned_at)
      from public.register_device_assignments a
      join public.registers rg on rg.tenant_id = a.tenant_id and rg.id = a.register_id
      where a.tenant_id = d.tenant_id and a.device_id = d.id and a.unassigned_at is null))
$f$;

-- ============================================================================================
-- Read surfaces. list_* return a JSON array ordered by id with id > p_after (keyset); the caller passes
-- limit+1 and slices. get_* return the single entity JSON or raise ST404.
-- ============================================================================================
create function settings_private.get_business(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare t public.tenants;
begin
  select * into t from public.tenants where id = p_tenant;
  if not found then raise exception using errcode = 'ST404', message = 'tenant not found'; end if;
  return settings_private.business_json(t);
end;
$f$;

create function settings_private.list_brands(p_tenant uuid, p_status text, p_after uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
begin
  if p_limit is null or p_limit not between 1 and 201
    or (p_status is not null and p_status not in ('active', 'inactive', 'archived')) then
    raise exception using errcode = '22023', message = 'invalid brand query';
  end if;
  return (select coalesce(jsonb_agg(settings_private.brand_json(b) order by b.id), '[]'::jsonb)
    from (select * from public.brands where tenant_id = p_tenant
      and (p_status is null or status = p_status) and (p_after is null or id > p_after)
      order by id limit p_limit) b);
end;
$f$;

create function settings_private.get_brand(p_tenant uuid, p_brand uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare b public.brands;
begin
  select * into b from public.brands where tenant_id = p_tenant and id = p_brand;
  if not found then raise exception using errcode = 'ST404', message = 'brand not found'; end if;
  return settings_private.brand_json(b);
end;
$f$;

create function settings_private.list_branches(p_tenant uuid, p_status text, p_after uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
begin
  if p_limit is null or p_limit not between 1 and 201
    or (p_status is not null and p_status not in ('active', 'inactive', 'archived')) then
    raise exception using errcode = '22023', message = 'invalid branch query';
  end if;
  return (select coalesce(jsonb_agg(settings_private.branch_json(b) order by b.id), '[]'::jsonb)
    from (select * from public.branches where tenant_id = p_tenant
      and (p_status is null or status = p_status) and (p_after is null or id > p_after)
      order by id limit p_limit) b);
end;
$f$;

create function settings_private.get_branch(p_tenant uuid, p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare b public.branches;
begin
  select * into b from public.branches where tenant_id = p_tenant and id = p_branch;
  if not found then raise exception using errcode = 'ST404', message = 'branch not found'; end if;
  return settings_private.branch_json(b);
end;
$f$;

create function settings_private.list_warehouses(p_tenant uuid, p_status text, p_after uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
begin
  if p_limit is null or p_limit not between 1 and 201
    or (p_status is not null and p_status not in ('active', 'inactive', 'archived')) then
    raise exception using errcode = '22023', message = 'invalid warehouse query';
  end if;
  return (select coalesce(jsonb_agg(settings_private.warehouse_json(w) order by w.id), '[]'::jsonb)
    from (select * from public.warehouses where tenant_id = p_tenant
      and (p_status is null or status = p_status) and (p_after is null or id > p_after)
      order by id limit p_limit) w);
end;
$f$;

create function settings_private.get_warehouse(p_tenant uuid, p_warehouse uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare w public.warehouses;
begin
  select * into w from public.warehouses where tenant_id = p_tenant and id = p_warehouse;
  if not found then raise exception using errcode = 'ST404', message = 'warehouse not found'; end if;
  return settings_private.warehouse_json(w);
end;
$f$;

create function settings_private.list_inventory_locations(
  p_tenant uuid, p_branch uuid, p_warehouse uuid, p_status text, p_after uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
begin
  if p_limit is null or p_limit not between 1 and 201
    or (p_status is not null and p_status not in ('active', 'inactive', 'archived')) then
    raise exception using errcode = '22023', message = 'invalid location query';
  end if;
  return (select coalesce(jsonb_agg(settings_private.location_json(l) order by l.id), '[]'::jsonb)
    from (select * from public.inventory_locations where tenant_id = p_tenant
      and (p_branch is null or branch_id = p_branch) and (p_warehouse is null or warehouse_id = p_warehouse)
      and (p_status is null or status = p_status) and (p_after is null or id > p_after)
      order by id limit p_limit) l);
end;
$f$;

create function settings_private.get_inventory_location(p_tenant uuid, p_location uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare l public.inventory_locations;
begin
  select * into l from public.inventory_locations where tenant_id = p_tenant and id = p_location;
  if not found then raise exception using errcode = 'ST404', message = 'inventory location not found'; end if;
  return settings_private.location_json(l);
end;
$f$;

create function settings_private.list_registers(p_tenant uuid, p_branch uuid, p_status text, p_after uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
begin
  if p_limit is null or p_limit not between 1 and 201
    or (p_status is not null and p_status not in ('active', 'inactive', 'archived')) then
    raise exception using errcode = '22023', message = 'invalid register query';
  end if;
  return (select coalesce(jsonb_agg(settings_private.register_json(r) order by r.id), '[]'::jsonb)
    from (select * from public.registers where tenant_id = p_tenant
      and (p_branch is null or branch_id = p_branch) and (p_status is null or status = p_status)
      and (p_after is null or id > p_after) order by id limit p_limit) r);
end;
$f$;

create function settings_private.get_register(p_tenant uuid, p_register uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare r public.registers;
begin
  select * into r from public.registers where tenant_id = p_tenant and id = p_register;
  if not found then raise exception using errcode = 'ST404', message = 'register not found'; end if;
  return settings_private.register_json(r);
end;
$f$;

create function settings_private.list_storefront(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $f$
  select coalesce(jsonb_agg(settings_private.storefront_json(s) order by s.brand_id), '[]'::jsonb)
  from public.storefront_checkout_settings s where s.tenant_id = p_tenant
$f$;

create function settings_private.get_storefront(p_tenant uuid, p_brand uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare s public.storefront_checkout_settings;
begin
  if not exists (select 1 from public.brands where tenant_id = p_tenant and id = p_brand) then
    raise exception using errcode = 'ST404', message = 'brand not found';
  end if;
  select * into s from public.storefront_checkout_settings where tenant_id = p_tenant and brand_id = p_brand;
  if not found then raise exception using errcode = 'ST404', message = 'storefront settings not found'; end if;
  return settings_private.storefront_json(s);
end;
$f$;

create function settings_private.get_return_settings(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare s public.return_settings;
begin
  select * into s from public.return_settings where tenant_id = p_tenant;
  if not found then
    -- Unconfigured returns are a valid, safe default state, not a 404.
    return jsonb_build_object('tenantId', p_tenant, 'enabled', false, 'windowDays', null,
      'allowedReasons', '[]'::jsonb, 'manualRefundsEnabled', false, 'maxManualRefundMinor', null);
  end if;
  return settings_private.return_settings_json(s);
end;
$f$;

create function settings_private.list_devices(p_tenant uuid, p_status text, p_after uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
begin
  if p_limit is null or p_limit not between 1 and 201
    or (p_status is not null and p_status not in ('enrolled', 'active', 'revoked')) then
    raise exception using errcode = '22023', message = 'invalid device query';
  end if;
  return (select coalesce(jsonb_agg(settings_private.device_json(d) order by d.id), '[]'::jsonb)
    from (select * from public.devices where tenant_id = p_tenant
      and (p_status is null or status = p_status) and (p_after is null or id > p_after)
      order by id limit p_limit) d);
end;
$f$;

create function settings_private.get_device(p_tenant uuid, p_device uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare d public.devices;
begin
  select * into d from public.devices where tenant_id = p_tenant and id = p_device;
  if not found then raise exception using errcode = 'ST404', message = 'device not found'; end if;
  return settings_private.device_json(d);
end;
$f$;

-- ============================================================================================
-- Mutations. Every write is idempotent (replay/record), takes the per-command advisory lock, and
-- enforces the frozen mutation-safety matrix server-side. Error codes: ST404 not found, SC409 currency
-- locked, SI409 immutable field, ST409 lifecycle/assignment conflict, ID409 idempotency, plus the
-- standard 22023/23514/23505/23502/23503 constraint failures mapped to INVALID_SETTINGS in the API.
-- ============================================================================================

-- TENANT / BUSINESS. slug/status are not in the allowlist so they can never change; default_currency
-- is locked once ANY order exists for the tenant (same value is always a no-op).
create function settings_private.write_business(p_tenant uuid, p_actor uuid, p_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_cur public.tenants; v_row public.tenants;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid business command'; end if;
  perform settings_private.only_keys(p_input, array['displayName', 'legalName', 'contactEmail',
    'contactPhone', 'defaultTimezone', 'countryCode', 'taxIdentifier', 'defaultCurrency']);
  v_intent := jsonb_build_object('op', 'write_business', 'actor', p_actor, 'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  select * into v_cur from public.tenants where id = p_tenant for update;
  if not found then raise exception using errcode = 'ST404', message = 'tenant not found'; end if;
  if p_input ? 'defaultCurrency'
    and (p_input ->> 'defaultCurrency') is distinct from v_cur.default_currency
    and exists (select 1 from public.orders where tenant_id = p_tenant) then
    raise exception using errcode = 'SC409', message = 'default_currency is locked once the tenant has orders';
  end if;

  update public.tenants set
    display_name = case when p_input ? 'displayName' then p_input ->> 'displayName' else display_name end,
    legal_name = case when p_input ? 'legalName' then p_input ->> 'legalName' else legal_name end,
    contact_email = case when p_input ? 'contactEmail' then p_input ->> 'contactEmail' else contact_email end,
    contact_phone = case when p_input ? 'contactPhone' then p_input ->> 'contactPhone' else contact_phone end,
    default_timezone = case when p_input ? 'defaultTimezone' then p_input ->> 'defaultTimezone' else default_timezone end,
    country_code = case when p_input ? 'countryCode' then p_input ->> 'countryCode' else country_code end,
    tax_identifier = case when p_input ? 'taxIdentifier' then p_input ->> 'taxIdentifier' else tax_identifier end,
    default_currency = case when p_input ? 'defaultCurrency' then p_input ->> 'defaultCurrency' else default_currency end,
    updated_at = clock_timestamp()
  where id = p_tenant returning * into v_row;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.business_json(v_row));
end;
$f$;

-- Shared lifecycle status resolver for the archivable organization entities.
create function settings_private.next_status(p_current text, p_input jsonb) returns text
language sql immutable set search_path = '' as $f$
  select coalesce(p_input ->> 'status', p_current)
$f$;

-- BRAND. code is required at creation and immutable thereafter (absent from the update allowlist).
create function settings_private.write_brand(p_tenant uuid, p_brand uuid, p_actor uuid, p_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_cur public.brands; v_row public.brands; v_status text;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid brand command'; end if;
  v_intent := jsonb_build_object('op', 'write_brand', 'brand', p_brand, 'actor', p_actor, 'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  if p_brand is null then
    perform settings_private.only_keys(p_input, array['code', 'displayName', 'legalName']);
    if not (p_input ? 'code') or not (p_input ? 'displayName') then
      raise exception using errcode = '22023', message = 'code and displayName are required';
    end if;
    insert into public.brands (tenant_id, code, display_name, legal_name)
    values (p_tenant, p_input ->> 'code', p_input ->> 'displayName', p_input ->> 'legalName')
    returning * into v_row;
  else
    perform settings_private.only_keys(p_input, array['displayName', 'legalName', 'status', 'archiveReason']);
    select * into v_cur from public.brands where tenant_id = p_tenant and id = p_brand for update;
    if not found then raise exception using errcode = 'ST404', message = 'brand not found'; end if;
    v_status := settings_private.next_status(v_cur.status, p_input);
    update public.brands set
      display_name = case when p_input ? 'displayName' then p_input ->> 'displayName' else display_name end,
      legal_name = case when p_input ? 'legalName' then p_input ->> 'legalName' else legal_name end,
      status = v_status,
      archived_at = case when v_status = 'archived' then coalesce(archived_at, clock_timestamp()) else null end,
      archive_reason = case when v_status = 'archived' then coalesce(p_input ->> 'archiveReason', archive_reason) else null end,
      updated_at = clock_timestamp()
    where tenant_id = p_tenant and id = p_brand returning * into v_row;
  end if;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.brand_json(v_row));
end;
$f$;

-- BRANCH. code immutable; default_inventory_location must belong to this branch (composite FK). The
-- location cannot be set at creation because it must reference the not-yet-existing branch.
create function settings_private.write_branch(p_tenant uuid, p_branch uuid, p_actor uuid, p_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_cur public.branches; v_row public.branches; v_status text;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid branch command'; end if;
  v_intent := jsonb_build_object('op', 'write_branch', 'branch', p_branch, 'actor', p_actor, 'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  if p_branch is null then
    perform settings_private.only_keys(p_input, array['code', 'displayName', 'timezone', 'addressLine1',
      'addressLine2', 'city', 'region', 'postalCode', 'countryCode', 'contactEmail', 'contactPhone',
      'isFulfillmentEnabled', 'isClickAndCollectEnabled', 'receiptFooter']);
    if not (p_input ? 'code') or not (p_input ? 'displayName') or not (p_input ? 'timezone') then
      raise exception using errcode = '22023', message = 'code, displayName and timezone are required';
    end if;
    insert into public.branches (tenant_id, code, display_name, timezone, address_line_1, address_line_2,
      city, region, postal_code, country_code, contact_email, contact_phone,
      is_fulfillment_enabled, is_click_and_collect_enabled, receipt_footer)
    values (p_tenant, p_input ->> 'code', p_input ->> 'displayName', p_input ->> 'timezone',
      p_input ->> 'addressLine1', p_input ->> 'addressLine2', p_input ->> 'city', p_input ->> 'region',
      p_input ->> 'postalCode', p_input ->> 'countryCode', p_input ->> 'contactEmail', p_input ->> 'contactPhone',
      coalesce((p_input ->> 'isFulfillmentEnabled')::boolean, false),
      coalesce((p_input ->> 'isClickAndCollectEnabled')::boolean, false), p_input ->> 'receiptFooter')
    returning * into v_row;
  else
    perform settings_private.only_keys(p_input, array['displayName', 'timezone', 'addressLine1',
      'addressLine2', 'city', 'region', 'postalCode', 'countryCode', 'contactEmail', 'contactPhone',
      'isFulfillmentEnabled', 'isClickAndCollectEnabled', 'defaultInventoryLocationId', 'receiptFooter',
      'status', 'archiveReason']);
    select * into v_cur from public.branches where tenant_id = p_tenant and id = p_branch for update;
    if not found then raise exception using errcode = 'ST404', message = 'branch not found'; end if;
    v_status := settings_private.next_status(v_cur.status, p_input);
    update public.branches set
      display_name = case when p_input ? 'displayName' then p_input ->> 'displayName' else display_name end,
      timezone = case when p_input ? 'timezone' then p_input ->> 'timezone' else timezone end,
      address_line_1 = case when p_input ? 'addressLine1' then p_input ->> 'addressLine1' else address_line_1 end,
      address_line_2 = case when p_input ? 'addressLine2' then p_input ->> 'addressLine2' else address_line_2 end,
      city = case when p_input ? 'city' then p_input ->> 'city' else city end,
      region = case when p_input ? 'region' then p_input ->> 'region' else region end,
      postal_code = case when p_input ? 'postalCode' then p_input ->> 'postalCode' else postal_code end,
      country_code = case when p_input ? 'countryCode' then p_input ->> 'countryCode' else country_code end,
      contact_email = case when p_input ? 'contactEmail' then p_input ->> 'contactEmail' else contact_email end,
      contact_phone = case when p_input ? 'contactPhone' then p_input ->> 'contactPhone' else contact_phone end,
      is_fulfillment_enabled = case when p_input ? 'isFulfillmentEnabled' then (p_input ->> 'isFulfillmentEnabled')::boolean else is_fulfillment_enabled end,
      is_click_and_collect_enabled = case when p_input ? 'isClickAndCollectEnabled' then (p_input ->> 'isClickAndCollectEnabled')::boolean else is_click_and_collect_enabled end,
      default_inventory_location_id = case when p_input ? 'defaultInventoryLocationId' then (p_input ->> 'defaultInventoryLocationId')::uuid else default_inventory_location_id end,
      receipt_footer = case when p_input ? 'receiptFooter' then p_input ->> 'receiptFooter' else receipt_footer end,
      status = v_status,
      archived_at = case when v_status = 'archived' then coalesce(archived_at, clock_timestamp()) else null end,
      archive_reason = case when v_status = 'archived' then coalesce(p_input ->> 'archiveReason', archive_reason) else null end,
      updated_at = clock_timestamp()
    where tenant_id = p_tenant and id = p_branch returning * into v_row;
  end if;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.branch_json(v_row));
end;
$f$;

-- BRANCH brand eligibility (replace-in-place). Never models brand ownership of a branch.
create function settings_private.set_branch_brands(p_tenant uuid, p_branch uuid, p_actor uuid, p_key text, p_brand_ids jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_row public.branches;
begin
  if p_tenant is null or p_actor is null or pg_catalog.jsonb_typeof(p_brand_ids) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid brand eligibility command';
  end if;
  v_intent := jsonb_build_object('op', 'set_branch_brands', 'branch', p_branch, 'actor', p_actor, 'brandIds', p_brand_ids);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  select * into v_row from public.branches where tenant_id = p_tenant and id = p_branch for update;
  if not found then raise exception using errcode = 'ST404', message = 'branch not found'; end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements_text(p_brand_ids) e(bid)
    where not exists (select 1 from public.brands b where b.tenant_id = p_tenant and b.id = e.bid::uuid)) then
    raise exception using errcode = '22023', message = 'unknown brand in eligibility set';
  end if;
  delete from public.branch_brands where tenant_id = p_tenant and branch_id = p_branch;
  insert into public.branch_brands (tenant_id, branch_id, brand_id)
    select p_tenant, p_branch, e.bid::uuid from pg_catalog.jsonb_array_elements_text(p_brand_ids) e(bid)
    on conflict do nothing;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.branch_json(v_row));
end;
$f$;

-- WAREHOUSE. code immutable after creation.
create function settings_private.write_warehouse(p_tenant uuid, p_warehouse uuid, p_actor uuid, p_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_cur public.warehouses; v_row public.warehouses; v_status text;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid warehouse command'; end if;
  v_intent := jsonb_build_object('op', 'write_warehouse', 'warehouse', p_warehouse, 'actor', p_actor, 'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  if p_warehouse is null then
    perform settings_private.only_keys(p_input, array['code', 'displayName', 'timezone', 'addressLine1',
      'addressLine2', 'city', 'region', 'postalCode', 'countryCode', 'contactEmail', 'contactPhone',
      'isFulfillmentEnabled', 'isReceivingEnabled', 'isTransferOriginEnabled', 'isTransferDestinationEnabled']);
    if not (p_input ? 'code') or not (p_input ? 'displayName') or not (p_input ? 'timezone') then
      raise exception using errcode = '22023', message = 'code, displayName and timezone are required';
    end if;
    insert into public.warehouses (tenant_id, code, display_name, timezone, address_line_1, address_line_2,
      city, region, postal_code, country_code, contact_email, contact_phone, is_fulfillment_enabled,
      is_receiving_enabled, is_transfer_origin_enabled, is_transfer_destination_enabled)
    values (p_tenant, p_input ->> 'code', p_input ->> 'displayName', p_input ->> 'timezone',
      p_input ->> 'addressLine1', p_input ->> 'addressLine2', p_input ->> 'city', p_input ->> 'region',
      p_input ->> 'postalCode', p_input ->> 'countryCode', p_input ->> 'contactEmail', p_input ->> 'contactPhone',
      coalesce((p_input ->> 'isFulfillmentEnabled')::boolean, false),
      coalesce((p_input ->> 'isReceivingEnabled')::boolean, false),
      coalesce((p_input ->> 'isTransferOriginEnabled')::boolean, false),
      coalesce((p_input ->> 'isTransferDestinationEnabled')::boolean, false))
    returning * into v_row;
  else
    perform settings_private.only_keys(p_input, array['displayName', 'timezone', 'addressLine1',
      'addressLine2', 'city', 'region', 'postalCode', 'countryCode', 'contactEmail', 'contactPhone',
      'isFulfillmentEnabled', 'isReceivingEnabled', 'isTransferOriginEnabled', 'isTransferDestinationEnabled',
      'status', 'archiveReason']);
    select * into v_cur from public.warehouses where tenant_id = p_tenant and id = p_warehouse for update;
    if not found then raise exception using errcode = 'ST404', message = 'warehouse not found'; end if;
    v_status := settings_private.next_status(v_cur.status, p_input);
    update public.warehouses set
      display_name = case when p_input ? 'displayName' then p_input ->> 'displayName' else display_name end,
      timezone = case when p_input ? 'timezone' then p_input ->> 'timezone' else timezone end,
      address_line_1 = case when p_input ? 'addressLine1' then p_input ->> 'addressLine1' else address_line_1 end,
      address_line_2 = case when p_input ? 'addressLine2' then p_input ->> 'addressLine2' else address_line_2 end,
      city = case when p_input ? 'city' then p_input ->> 'city' else city end,
      region = case when p_input ? 'region' then p_input ->> 'region' else region end,
      postal_code = case when p_input ? 'postalCode' then p_input ->> 'postalCode' else postal_code end,
      country_code = case when p_input ? 'countryCode' then p_input ->> 'countryCode' else country_code end,
      contact_email = case when p_input ? 'contactEmail' then p_input ->> 'contactEmail' else contact_email end,
      contact_phone = case when p_input ? 'contactPhone' then p_input ->> 'contactPhone' else contact_phone end,
      is_fulfillment_enabled = case when p_input ? 'isFulfillmentEnabled' then (p_input ->> 'isFulfillmentEnabled')::boolean else is_fulfillment_enabled end,
      is_receiving_enabled = case when p_input ? 'isReceivingEnabled' then (p_input ->> 'isReceivingEnabled')::boolean else is_receiving_enabled end,
      is_transfer_origin_enabled = case when p_input ? 'isTransferOriginEnabled' then (p_input ->> 'isTransferOriginEnabled')::boolean else is_transfer_origin_enabled end,
      is_transfer_destination_enabled = case when p_input ? 'isTransferDestinationEnabled' then (p_input ->> 'isTransferDestinationEnabled')::boolean else is_transfer_destination_enabled end,
      status = v_status,
      archived_at = case when v_status = 'archived' then coalesce(archived_at, clock_timestamp()) else null end,
      archive_reason = case when v_status = 'archived' then coalesce(p_input ->> 'archiveReason', archive_reason) else null end,
      updated_at = clock_timestamp()
    where tenant_id = p_tenant and id = p_warehouse returning * into v_row;
  end if;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.warehouse_json(v_row));
end;
$f$;

-- INVENTORY LOCATION. Exactly one parent (branch XOR warehouse) at creation; parent + location_type +
-- code are immutable (absent from the update allowlist). An InventoryLocation is never re-parented.
create function settings_private.write_inventory_location(p_tenant uuid, p_location uuid, p_actor uuid, p_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_cur public.inventory_locations; v_row public.inventory_locations; v_status text;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid location command'; end if;
  v_intent := jsonb_build_object('op', 'write_inventory_location', 'location', p_location, 'actor', p_actor, 'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  if p_location is null then
    perform settings_private.only_keys(p_input, array['branchId', 'warehouseId', 'code', 'displayName',
      'locationType', 'isSellable', 'isFulfillmentEnabled', 'isReceivingEnabled',
      'isTransferOriginEnabled', 'isTransferDestinationEnabled']);
    if not (p_input ? 'code') or not (p_input ? 'displayName') or not (p_input ? 'locationType') then
      raise exception using errcode = '22023', message = 'code, displayName and locationType are required';
    end if;
    -- The exactly-one-parent CHECK is the backstop; this gives a clean early error.
    if (p_input ? 'branchId') = (p_input ? 'warehouseId') then
      raise exception using errcode = '22023', message = 'exactly one of branchId or warehouseId is required';
    end if;
    insert into public.inventory_locations (tenant_id, branch_id, warehouse_id, code, display_name,
      location_type, is_sellable, is_fulfillment_enabled, is_receiving_enabled,
      is_transfer_origin_enabled, is_transfer_destination_enabled)
    values (p_tenant, (p_input ->> 'branchId')::uuid, (p_input ->> 'warehouseId')::uuid,
      p_input ->> 'code', p_input ->> 'displayName', p_input ->> 'locationType',
      coalesce((p_input ->> 'isSellable')::boolean, false),
      coalesce((p_input ->> 'isFulfillmentEnabled')::boolean, false),
      coalesce((p_input ->> 'isReceivingEnabled')::boolean, false),
      coalesce((p_input ->> 'isTransferOriginEnabled')::boolean, false),
      coalesce((p_input ->> 'isTransferDestinationEnabled')::boolean, false))
    returning * into v_row;
  else
    perform settings_private.only_keys(p_input, array['displayName', 'isSellable', 'isFulfillmentEnabled',
      'isReceivingEnabled', 'isTransferOriginEnabled', 'isTransferDestinationEnabled', 'status', 'archiveReason']);
    select * into v_cur from public.inventory_locations where tenant_id = p_tenant and id = p_location for update;
    if not found then raise exception using errcode = 'ST404', message = 'inventory location not found'; end if;
    v_status := settings_private.next_status(v_cur.status, p_input);
    update public.inventory_locations set
      display_name = case when p_input ? 'displayName' then p_input ->> 'displayName' else display_name end,
      is_sellable = case when p_input ? 'isSellable' then (p_input ->> 'isSellable')::boolean else is_sellable end,
      is_fulfillment_enabled = case when p_input ? 'isFulfillmentEnabled' then (p_input ->> 'isFulfillmentEnabled')::boolean else is_fulfillment_enabled end,
      is_receiving_enabled = case when p_input ? 'isReceivingEnabled' then (p_input ->> 'isReceivingEnabled')::boolean else is_receiving_enabled end,
      is_transfer_origin_enabled = case when p_input ? 'isTransferOriginEnabled' then (p_input ->> 'isTransferOriginEnabled')::boolean else is_transfer_origin_enabled end,
      is_transfer_destination_enabled = case when p_input ? 'isTransferDestinationEnabled' then (p_input ->> 'isTransferDestinationEnabled')::boolean else is_transfer_destination_enabled end,
      status = v_status,
      archived_at = case when v_status = 'archived' then coalesce(archived_at, clock_timestamp()) else null end,
      archive_reason = case when v_status = 'archived' then coalesce(p_input ->> 'archiveReason', archive_reason) else null end,
      updated_at = clock_timestamp()
    where tenant_id = p_tenant and id = p_location returning * into v_row;
  end if;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.location_json(v_row));
end;
$f$;

-- REGISTER. branch_id + code immutable; default location must belong to the branch (composite FK);
-- selling_currency locked once the register has its first POS order (same value is always a no-op).
create function settings_private.write_register(p_tenant uuid, p_register uuid, p_actor uuid, p_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_cur public.registers; v_row public.registers; v_status text;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid register command'; end if;
  v_intent := jsonb_build_object('op', 'write_register', 'register', p_register, 'actor', p_actor, 'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  if p_register is null then
    perform settings_private.only_keys(p_input, array['branchId', 'code', 'displayName',
      'defaultInventoryLocationId', 'sellingCurrency', 'status']);
    if not (p_input ? 'branchId') or not (p_input ? 'code') or not (p_input ? 'displayName')
      or not (p_input ? 'sellingCurrency') then
      raise exception using errcode = '22023', message = 'branchId, code, displayName and sellingCurrency are required';
    end if;
    insert into public.registers (tenant_id, branch_id, code, display_name, default_inventory_location_id,
      selling_currency, status)
    values (p_tenant, (p_input ->> 'branchId')::uuid, p_input ->> 'code', p_input ->> 'displayName',
      (p_input ->> 'defaultInventoryLocationId')::uuid, p_input ->> 'sellingCurrency',
      coalesce(p_input ->> 'status', 'inactive'))
    returning * into v_row;
  else
    perform settings_private.only_keys(p_input, array['displayName', 'defaultInventoryLocationId',
      'sellingCurrency', 'status', 'archiveReason']);
    select * into v_cur from public.registers where tenant_id = p_tenant and id = p_register for update;
    if not found then raise exception using errcode = 'ST404', message = 'register not found'; end if;
    if p_input ? 'sellingCurrency'
      and (p_input ->> 'sellingCurrency') is distinct from v_cur.selling_currency
      and exists (select 1 from public.orders where tenant_id = p_tenant and register_id = p_register) then
      raise exception using errcode = 'SC409', message = 'selling_currency is locked once the register has a sale';
    end if;
    v_status := settings_private.next_status(v_cur.status, p_input);
    update public.registers set
      display_name = case when p_input ? 'displayName' then p_input ->> 'displayName' else display_name end,
      default_inventory_location_id = case when p_input ? 'defaultInventoryLocationId' then (p_input ->> 'defaultInventoryLocationId')::uuid else default_inventory_location_id end,
      selling_currency = case when p_input ? 'sellingCurrency' then p_input ->> 'sellingCurrency' else selling_currency end,
      status = v_status,
      archived_at = case when v_status = 'archived' then coalesce(archived_at, clock_timestamp()) else null end,
      archive_reason = case when v_status = 'archived' then coalesce(p_input ->> 'archiveReason', archive_reason) else null end,
      updated_at = clock_timestamp()
    where tenant_id = p_tenant and id = p_register returning * into v_row;
  end if;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.register_json(v_row));
end;
$f$;

-- STOREFRONT checkout settings (upsert per brand). currency locked once the brand has an ONLINE order.
create function settings_private.write_storefront(p_tenant uuid, p_brand uuid, p_actor uuid, p_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_cur public.storefront_checkout_settings; v_row public.storefront_checkout_settings;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid storefront command'; end if;
  perform settings_private.only_keys(p_input, array['inventoryLocationId', 'currency', 'codEnabled']);
  v_intent := jsonb_build_object('op', 'write_storefront', 'brand', p_brand, 'actor', p_actor, 'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  if not exists (select 1 from public.brands where tenant_id = p_tenant and id = p_brand) then
    raise exception using errcode = 'ST404', message = 'brand not found';
  end if;
  select * into v_cur from public.storefront_checkout_settings where tenant_id = p_tenant and brand_id = p_brand for update;
  if not found then
    if not (p_input ? 'inventoryLocationId') or not (p_input ? 'currency') then
      raise exception using errcode = '22023', message = 'inventoryLocationId and currency are required to configure a storefront';
    end if;
    insert into public.storefront_checkout_settings (tenant_id, brand_id, inventory_location_id, currency, cod_enabled)
    values (p_tenant, p_brand, (p_input ->> 'inventoryLocationId')::uuid, p_input ->> 'currency',
      coalesce((p_input ->> 'codEnabled')::boolean, false))
    returning * into v_row;
  else
    if p_input ? 'currency' and (p_input ->> 'currency') is distinct from v_cur.currency
      and exists (select 1 from public.orders where tenant_id = p_tenant and brand_id = p_brand and channel = 'online') then
      raise exception using errcode = 'SC409', message = 'storefront currency is locked once the brand has an online order';
    end if;
    update public.storefront_checkout_settings set
      inventory_location_id = case when p_input ? 'inventoryLocationId' then (p_input ->> 'inventoryLocationId')::uuid else inventory_location_id end,
      currency = case when p_input ? 'currency' then p_input ->> 'currency' else currency end,
      cod_enabled = case when p_input ? 'codEnabled' then (p_input ->> 'codEnabled')::boolean else cod_enabled end
    where tenant_id = p_tenant and brand_id = p_brand returning * into v_row;
  end if;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.storefront_json(v_row));
end;
$f$;

-- RETURN settings (upsert per tenant). Hard integrity ceilings stay in the table CHECKs. Editing config
-- never touches existing returns rows, so historical policy snapshots are preserved.
create function settings_private.write_return_settings(p_tenant uuid, p_actor uuid, p_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_cur public.return_settings; v_row public.return_settings;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid return-settings command'; end if;
  perform settings_private.only_keys(p_input, array['enabled', 'windowDays', 'manualRefundsEnabled',
    'maxManualRefundMinor', 'allowedReasons']);
  v_intent := jsonb_build_object('op', 'write_return_settings', 'actor', p_actor, 'input', p_input);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  select * into v_cur from public.return_settings where tenant_id = p_tenant for update;
  if not found then
    insert into public.return_settings (tenant_id, enabled, window_days, allowed_reasons,
      manual_refunds_enabled, max_manual_refund_minor)
    values (p_tenant, coalesce((p_input ->> 'enabled')::boolean, false),
      case when p_input ? 'windowDays' then (p_input ->> 'windowDays')::integer else null end,
      settings_private.text_array(p_input -> 'allowedReasons'),
      coalesce((p_input ->> 'manualRefundsEnabled')::boolean, false),
      case when p_input ? 'maxManualRefundMinor' then (p_input ->> 'maxManualRefundMinor')::bigint else null end)
    returning * into v_row;
  else
    update public.return_settings set
      enabled = case when p_input ? 'enabled' then (p_input ->> 'enabled')::boolean else enabled end,
      window_days = case when p_input ? 'windowDays' then (p_input ->> 'windowDays')::integer else window_days end,
      allowed_reasons = case when p_input ? 'allowedReasons' then settings_private.text_array(p_input -> 'allowedReasons') else allowed_reasons end,
      manual_refunds_enabled = case when p_input ? 'manualRefundsEnabled' then (p_input ->> 'manualRefundsEnabled')::boolean else manual_refunds_enabled end,
      max_manual_refund_minor = case when p_input ? 'maxManualRefundMinor' then (p_input ->> 'maxManualRefundMinor')::bigint else max_manual_refund_minor end
    where tenant_id = p_tenant returning * into v_row;
  end if;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.return_settings_json(v_row));
end;
$f$;

-- DEVICE GOVERNANCE. revoke ends any current assignment and marks the device revoked. Enrollment,
-- credential creation and key rotation stay device-side and are never performed here.
create function settings_private.revoke_device(p_tenant uuid, p_device uuid, p_actor uuid, p_key text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_dev public.devices;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid revoke command'; end if;
  v_intent := jsonb_build_object('op', 'revoke_device', 'device', p_device, 'actor', p_actor, 'reason', p_reason);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  select * into v_dev from public.devices where tenant_id = p_tenant and id = p_device for update;
  if not found then raise exception using errcode = 'ST404', message = 'device not found'; end if;
  if v_dev.status = 'revoked' then raise exception using errcode = 'ST409', message = 'device is already revoked'; end if;
  update public.register_device_assignments set unassigned_at = clock_timestamp(),
    unassigned_by_membership_id = p_actor, unassignment_reason = coalesce(p_reason, 'device revoked')
  where tenant_id = p_tenant and device_id = p_device and unassigned_at is null;
  update public.devices set status = 'revoked', revoked_at = clock_timestamp(),
    revocation_reason = coalesce(p_reason, 'revoked by administrator'), updated_at = clock_timestamp()
  where tenant_id = p_tenant and id = p_device returning * into v_dev;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.device_json(v_dev));
end;
$f$;

-- ASSIGN / REASSIGN a device to a register. Closing any open interval on either side before inserting
-- the new one preserves history and keeps at most one current assignment per side (partial unique index).
create function settings_private.assign_device(p_tenant uuid, p_register uuid, p_device uuid, p_actor uuid, p_key text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare v_intent jsonb; v_replay jsonb; v_dev public.devices;
begin
  if p_tenant is null or p_actor is null then raise exception using errcode = '22023', message = 'invalid assignment command'; end if;
  v_intent := jsonb_build_object('op', 'assign_device', 'register', p_register, 'device', p_device, 'actor', p_actor, 'reason', p_reason);
  v_replay := settings_private.replay(p_tenant, p_key, v_intent);
  if v_replay is not null then return v_replay; end if;

  select * into v_dev from public.devices where tenant_id = p_tenant and id = p_device for update;
  if not found then raise exception using errcode = 'ST404', message = 'device not found'; end if;
  if v_dev.status = 'revoked' then raise exception using errcode = 'ST409', message = 'a revoked device cannot be assigned'; end if;
  if not exists (select 1 from public.registers where tenant_id = p_tenant and id = p_register) then
    raise exception using errcode = 'ST404', message = 'register not found';
  end if;

  -- Already the current assignment for this exact pairing: idempotent no-op on the interval.
  if not exists (select 1 from public.register_device_assignments
    where tenant_id = p_tenant and device_id = p_device and register_id = p_register and unassigned_at is null) then
    update public.register_device_assignments set unassigned_at = clock_timestamp(),
      unassigned_by_membership_id = p_actor, unassignment_reason = coalesce(p_reason, 'reassigned')
    where tenant_id = p_tenant and unassigned_at is null and (device_id = p_device or register_id = p_register);
    begin
      insert into public.register_device_assignments (tenant_id, register_id, device_id,
        assigned_by_membership_id, assignment_reason)
      values (p_tenant, p_register, p_device, p_actor, p_reason);
    exception when unique_violation then
      raise exception using errcode = 'ST409', message = 'the assignment changed concurrently';
    end;
  end if;

  select * into v_dev from public.devices where tenant_id = p_tenant and id = p_device;
  return settings_private.record(p_tenant, p_key, v_intent, settings_private.device_json(v_dev));
end;
$f$;

-- ============================================================================================
-- Ownership + privilege boundary. settings_writer owns every settings_private function (so the definer
-- functions run with exactly its privileges); PUBLIC/anon/authenticated get nothing; service_role may
-- only EXECUTE the sanctioned read/write RPCs — never the internal helpers/serializers, never DML.
-- ============================================================================================
grant create on schema settings_private to settings_writer;
do $block$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'settings_private'
  loop
    execute pg_catalog.format('alter function %s owner to settings_writer', r.sig);
  end loop;
end;
$block$;
revoke create on schema settings_private from settings_writer;

revoke all on all functions in schema settings_private from public, anon, authenticated, service_role;
do $block$
declare r record;
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant usage on schema settings_private to service_role;
    for r in
      select p.oid::regprocedure::text as sig
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'settings_private'
        and p.proname like any (array['get\_%', 'list\_%', 'write\_%', 'set\_%', 'revoke\_%', 'assign\_%'])
    loop
      execute pg_catalog.format('grant execute on function %s to service_role', r.sig);
    end loop;
  end if;
end;
$block$;
