-- Phase 2I PR1: bounded offline POS authority, device credentials, ingestion, and reconciliation.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'offline_pos_writer') then
    create role offline_pos_writer nologin noinherit nobypassrls;
  end if;
  execute pg_catalog.format('grant offline_pos_writer to %I with set true', current_user);
end;
$block$;

create schema if not exists offline_pos_private;
revoke all on schema offline_pos_private from public;
grant usage on schema public, offline_pos_private, inventory_private, orders_private, payments_private,
  fulfillments_private to offline_pos_writer;

create table public.offline_pos_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  register_id uuid not null,
  enabled boolean not null default false,
  operator_lease_seconds integer not null,
  catalog_grant_seconds integer not null,
  max_sale_amount_minor bigint not null,
  max_cumulative_exposure_minor bigint not null,
  max_quantity_per_line bigint not null,
  max_pending_offline_sales integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offline_pos_policies_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_pos_policies_register_fk foreign key (tenant_id, register_id) references public.registers(tenant_id, id) on delete restrict,
  constraint offline_pos_policies_positive check (
    operator_lease_seconds > 0 and catalog_grant_seconds > 0 and max_sale_amount_minor >= 0
    and max_cumulative_exposure_minor >= 0 and max_quantity_per_line > 0
    and max_pending_offline_sales > 0
  ),
  constraint offline_pos_policies_tenant_id_unique unique (tenant_id, id),
  constraint offline_pos_policies_register_unique unique (tenant_id, register_id)
);

create table public.device_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  device_id uuid not null,
  algorithm text not null,
  public_key_spki_base64 text not null,
  public_key_fingerprint text not null,
  status text not null default 'active',
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  constraint device_credentials_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint device_credentials_device_fk foreign key (tenant_id, device_id) references public.devices(tenant_id, id) on delete restrict,
  constraint device_credentials_algorithm check (algorithm = 'Ed25519'),
  constraint device_credentials_key_not_blank check (btrim(public_key_spki_base64) <> ''),
  constraint device_credentials_fingerprint check (public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint device_credentials_status check (status in ('active', 'rotated', 'revoked')),
  constraint device_credentials_validity check ((status = 'active') = (valid_to is null)),
  constraint device_credentials_tenant_id_unique unique (tenant_id, id),
  constraint device_credentials_fingerprint_unique unique (public_key_fingerprint)
);
create unique index device_credentials_one_active_idx on public.device_credentials(tenant_id, device_id) where status = 'active';

create table public.offline_device_management_commands (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, idempotency_key text not null,
  normalized_idempotency_key text generated always as (lower(btrim(idempotency_key))) stored,
  command_type text not null, command_fingerprint text not null, device_id uuid not null,
  credential_id uuid not null, created_at timestamptz not null default now(),
  constraint offline_device_commands_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_device_commands_device_fk foreign key (tenant_id,device_id) references public.devices(tenant_id,id) on delete restrict,
  constraint offline_device_commands_credential_fk foreign key (tenant_id,credential_id) references public.device_credentials(tenant_id,id) on delete restrict,
  constraint offline_device_commands_type check (command_type in ('enroll','rotate','revoke')),
  constraint offline_device_commands_key check (normalized_idempotency_key<>''),
  constraint offline_device_commands_tenant_id_unique unique (tenant_id,id),
  constraint offline_device_commands_key_unique unique (tenant_id,normalized_idempotency_key)
);

create table public.offline_grants (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null unique default gen_random_uuid(),
  tenant_id uuid not null,
  device_id uuid not null,
  register_id uuid not null,
  branch_id uuid not null,
  inventory_location_id uuid not null,
  operator_membership_id uuid not null,
  currency text not null,
  schema_version integer not null default 1,
  minimum_client_version text not null default '0.5.0',
  issued_at timestamptz not null default now(),
  operator_expires_at timestamptz not null,
  catalog_valid_until timestamptz not null,
  accepted_until timestamptz not null,
  max_sale_amount_minor bigint not null,
  max_cumulative_exposure_minor bigint not null,
  max_quantity_per_line bigint not null,
  max_pending_offline_sales integer not null,
  catalog_snapshot jsonb not null,
  issuance_idempotency_key text not null,
  normalized_issuance_idempotency_key text generated always as (lower(btrim(issuance_idempotency_key))) stored,
  issuance_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint offline_grants_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_grants_device_fk foreign key (tenant_id, device_id) references public.devices(tenant_id, id) on delete restrict,
  constraint offline_grants_register_branch_fk foreign key (tenant_id, branch_id, register_id) references public.registers(tenant_id, branch_id, id) on delete restrict,
  constraint offline_grants_location_fk foreign key (tenant_id, inventory_location_id) references public.inventory_locations(tenant_id, id) on delete restrict,
  constraint offline_grants_operator_fk foreign key (tenant_id, operator_membership_id) references public.memberships(tenant_id, id) on delete restrict,
  constraint offline_grants_currency check (currency ~ '^[A-Z]{3}$'),
  constraint offline_grants_version check (schema_version = 1 and btrim(minimum_client_version) <> ''),
  constraint offline_grants_times check (accepted_until = least(operator_expires_at, catalog_valid_until) and accepted_until > issued_at),
  constraint offline_grants_limits check (max_sale_amount_minor >= 0 and max_cumulative_exposure_minor >= 0 and max_quantity_per_line > 0 and max_pending_offline_sales > 0),
  constraint offline_grants_snapshot_array check (jsonb_typeof(catalog_snapshot) = 'array'),
  constraint offline_grants_issuance_key check (normalized_issuance_idempotency_key<>''),
  constraint offline_grants_issuance_key_unique unique (tenant_id,normalized_issuance_idempotency_key),
  constraint offline_grants_tenant_id_unique unique (tenant_id, id)
);
create index offline_grants_active_location_idx on public.offline_grants(tenant_id, inventory_location_id, accepted_until desc);

create table public.offline_sale_ingestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  grant_id uuid not null,
  device_id uuid not null,
  credential_id uuid not null,
  register_id uuid not null,
  branch_id uuid not null,
  inventory_location_id uuid not null,
  local_sale_id text not null,
  sync_command_id uuid not null,
  command_fingerprint text not null,
  canonical_command text not null,
  device_signature_base64 text not null,
  accepted_at timestamptz not null,
  received_at timestamptz not null default now(),
  order_id uuid not null,
  payment_id uuid not null,
  fulfillment_id uuid,
  sync_status text not null,
  price_provenance jsonb not null,
  created_at timestamptz not null default now(),
  constraint offline_sale_ingestions_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_sale_ingestions_grant_fk foreign key (tenant_id, grant_id) references public.offline_grants(tenant_id, id) on delete restrict,
  constraint offline_sale_ingestions_device_fk foreign key (tenant_id, device_id) references public.devices(tenant_id, id) on delete restrict,
  constraint offline_sale_ingestions_credential_fk foreign key (tenant_id, credential_id) references public.device_credentials(tenant_id, id) on delete restrict,
  constraint offline_sale_ingestions_order_fk foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete restrict,
  constraint offline_sale_ingestions_payment_fk foreign key (tenant_id, payment_id) references public.payments(tenant_id, id) on delete restrict,
  constraint offline_sale_ingestions_fulfillment_fk foreign key (tenant_id, fulfillment_id) references public.fulfillments(tenant_id, id) on delete restrict,
  constraint offline_sale_ingestions_status check (sync_status in ('synced', 'needs_reconciliation')),
  constraint offline_sale_ingestions_fulfillment_status check ((sync_status = 'synced') = (fulfillment_id is not null)),
  constraint offline_sale_ingestions_fingerprint check (command_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint offline_sale_ingestions_local_sale_not_blank check (btrim(local_sale_id) <> ''),
  constraint offline_sale_ingestions_tenant_id_unique unique (tenant_id, id),
  constraint offline_sale_ingestions_sync_unique unique (tenant_id, sync_command_id),
  constraint offline_sale_ingestions_local_unique unique (tenant_id, device_id, local_sale_id),
  constraint offline_sale_ingestions_order_unique unique (tenant_id, order_id),
  constraint offline_sale_ingestions_payment_unique unique (tenant_id, payment_id)
);

create table public.offline_reconciliations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  ingestion_id uuid not null,
  local_sale_id text not null,
  order_id uuid not null,
  payment_id uuid not null,
  reason text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offline_reconciliations_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_reconciliations_ingestion_fk foreign key (tenant_id, ingestion_id) references public.offline_sale_ingestions(tenant_id, id) on delete restrict,
  constraint offline_reconciliations_order_fk foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete restrict,
  constraint offline_reconciliations_payment_fk foreign key (tenant_id, payment_id) references public.payments(tenant_id, id) on delete restrict,
  constraint offline_reconciliations_reason check (reason in ('insufficient_stock_at_ingestion', 'device_revoked_at_ingestion')),
  constraint offline_reconciliations_status check (status = 'open'),
  constraint offline_reconciliations_tenant_id_unique unique (tenant_id, id),
  constraint offline_reconciliations_ingestion_unique unique (tenant_id, ingestion_id)
);

create table public.offline_reconciliation_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, reconciliation_id uuid not null,
  event_type text not null default 'opened', reason text not null, occurred_at timestamptz not null default now(),
  constraint offline_reconciliation_events_tenant_fk foreign key (tenant_id) references public.tenants(id) on delete restrict,
  constraint offline_reconciliation_events_reconciliation_fk foreign key (tenant_id, reconciliation_id) references public.offline_reconciliations(tenant_id, id) on delete restrict,
  constraint offline_reconciliation_events_type check (event_type = 'opened')
);

create function offline_pos_private.forbid_immutable_mutation() returns trigger language plpgsql security invoker set search_path = '' as $function$
begin raise exception using errcode = '42501', message = pg_catalog.format('%I is immutable', tg_table_name); end;
$function$;
create trigger offline_grants_immutable before update or delete on public.offline_grants for each row execute function offline_pos_private.forbid_immutable_mutation();
create trigger offline_device_commands_immutable before update or delete on public.offline_device_management_commands for each row execute function offline_pos_private.forbid_immutable_mutation();
create trigger offline_ingestions_immutable before update or delete on public.offline_sale_ingestions for each row execute function offline_pos_private.forbid_immutable_mutation();
create trigger offline_reconciliation_events_immutable before update or delete on public.offline_reconciliation_events for each row execute function offline_pos_private.forbid_immutable_mutation();

create function offline_pos_private.enroll_device(
  p_tenant_id uuid, p_register_id uuid, p_membership_id uuid, p_installation_id text,
  p_display_name text, p_public_key text, p_fingerprint text, p_client_version text,
  p_platform text, p_os_version text, p_idempotency_key text
) returns table(device_id uuid, credential_id uuid, register_id uuid, status text,
  public_key_fingerprint text, activated_at timestamptz, revoked_at timestamptz)
language plpgsql security definer set search_path = '' as $function$
declare v_device public.devices%rowtype; v_credential public.device_credentials%rowtype; v_assignment_register uuid; v_command public.offline_device_management_commands%rowtype; v_command_fingerprint text;
begin
  v_command_fingerprint:=pg_catalog.md5(p_register_id::text||E'\n'||lower(btrim(p_installation_id))||E'\n'||p_fingerprint||E'\n'||coalesce(p_client_version,'')||E'\n'||coalesce(p_platform,'')||E'\n'||coalesce(p_os_version,''));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text||':'||lower(btrim(p_idempotency_key)),0));
  select * into v_command from public.offline_device_management_commands where tenant_id=p_tenant_id and normalized_idempotency_key=lower(btrim(p_idempotency_key));
  if found then
    if v_command.command_type<>'enroll' or v_command.command_fingerprint<>v_command_fingerprint then raise exception using errcode='ID409',message='device command idempotency conflict'; end if;
    select * into v_device from public.devices where tenant_id=p_tenant_id and id=v_command.device_id;
    select * into v_credential from public.device_credentials where tenant_id=p_tenant_id and id=v_command.credential_id;
    select a.register_id into v_assignment_register from public.register_device_assignments a where a.tenant_id=p_tenant_id and a.device_id=v_device.id and a.unassigned_at is null;
    return query select v_device.id,v_credential.id,v_assignment_register,v_device.status,v_credential.public_key_fingerprint,v_device.activated_at,v_device.revoked_at; return;
  end if;
  perform 1 from public.registers r where r.tenant_id=p_tenant_id and r.id=p_register_id and r.status='active';
  if not found then raise exception using errcode='OD404', message='register not found'; end if;
  select * into v_device from public.devices d where d.normalized_installation_id=lower(btrim(p_installation_id)) for update;
  if found then
    if v_device.tenant_id <> p_tenant_id then raise exception using errcode='OD403', message='installation belongs to another tenant'; end if;
    if v_device.status='revoked' then raise exception using errcode='OD410', message='device revoked'; end if;
    select a.register_id into v_assignment_register from public.register_device_assignments a where a.tenant_id=p_tenant_id and a.device_id=v_device.id and a.unassigned_at is null;
    if v_assignment_register is distinct from p_register_id then raise exception using errcode='OD409', message='device assignment conflict'; end if;
    select * into v_credential from public.device_credentials c where c.tenant_id=p_tenant_id and c.device_id=v_device.id and c.status='active';
    if v_credential.public_key_fingerprint is distinct from p_fingerprint then raise exception using errcode='OD409', message='credential conflict'; end if;
  else
    insert into public.devices(tenant_id,installation_id,device_type,display_name,status,client_version,platform,os_version,activated_at)
    values(p_tenant_id,p_installation_id,'pos',p_display_name,'active',p_client_version,p_platform,p_os_version,now()) returning * into v_device;
    insert into public.register_device_assignments(tenant_id,register_id,device_id,assigned_by_membership_id,assignment_reason)
    values(p_tenant_id,p_register_id,v_device.id,p_membership_id,'Offline POS enrollment');
    insert into public.device_credentials(tenant_id,device_id,algorithm,public_key_spki_base64,public_key_fingerprint)
    values(p_tenant_id,v_device.id,'Ed25519',p_public_key,p_fingerprint) returning * into v_credential;
  end if;
  insert into public.offline_device_management_commands(tenant_id,idempotency_key,command_type,command_fingerprint,device_id,credential_id) values(p_tenant_id,p_idempotency_key,'enroll',v_command_fingerprint,v_device.id,v_credential.id);
  return query select v_device.id,v_credential.id,p_register_id,v_device.status,v_credential.public_key_fingerprint,v_device.activated_at,v_device.revoked_at;
end;
$function$;

create function offline_pos_private.rotate_credential(p_tenant_id uuid,p_device_id uuid,p_public_key text,p_fingerprint text,p_idempotency_key text)
returns table(device_id uuid,credential_id uuid,register_id uuid,status text,public_key_fingerprint text,activated_at timestamptz,revoked_at timestamptz)
language plpgsql security definer set search_path='' as $function$
declare v_device public.devices%rowtype; v_credential public.device_credentials%rowtype; v_register uuid; v_command public.offline_device_management_commands%rowtype; v_command_fingerprint text:=pg_catalog.md5(p_device_id::text||E'\n'||p_fingerprint);
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text||':'||lower(btrim(p_idempotency_key)),0));
 select * into v_command from public.offline_device_management_commands where tenant_id=p_tenant_id and normalized_idempotency_key=lower(btrim(p_idempotency_key));
 if found then
  if v_command.command_type<>'rotate' or v_command.command_fingerprint<>v_command_fingerprint then raise exception using errcode='ID409',message='device command idempotency conflict'; end if;
  select * into v_device from public.devices where tenant_id=p_tenant_id and id=v_command.device_id; select * into v_credential from public.device_credentials where tenant_id=p_tenant_id and id=v_command.credential_id; select a.register_id into v_register from public.register_device_assignments a where a.tenant_id=p_tenant_id and a.device_id=p_device_id and a.unassigned_at is null;
  return query select v_device.id,v_credential.id,v_register,v_device.status,v_credential.public_key_fingerprint,v_device.activated_at,v_device.revoked_at; return;
 end if;
 select * into v_device from public.devices where tenant_id=p_tenant_id and id=p_device_id for update;
 if not found then raise exception using errcode='OD404',message='device not found'; end if;
 if v_device.status='revoked' then raise exception using errcode='OD410',message='device revoked'; end if;
 if exists(select 1 from public.device_credentials c where c.public_key_fingerprint=p_fingerprint) then raise exception using errcode='OD409',message='credential already enrolled'; end if;
 update public.device_credentials c set status='rotated',valid_to=now() where c.tenant_id=p_tenant_id and c.device_id=p_device_id and c.status='active';
 insert into public.device_credentials(tenant_id,device_id,algorithm,public_key_spki_base64,public_key_fingerprint) values(p_tenant_id,p_device_id,'Ed25519',p_public_key,p_fingerprint) returning * into v_credential;
 select a.register_id into v_register from public.register_device_assignments a where a.tenant_id=p_tenant_id and a.device_id=p_device_id and a.unassigned_at is null;
 insert into public.offline_device_management_commands(tenant_id,idempotency_key,command_type,command_fingerprint,device_id,credential_id) values(p_tenant_id,p_idempotency_key,'rotate',v_command_fingerprint,v_device.id,v_credential.id);
 return query select v_device.id,v_credential.id,v_register,v_device.status,v_credential.public_key_fingerprint,v_device.activated_at,v_device.revoked_at;
end;
$function$;

create function offline_pos_private.revoke_device(p_tenant_id uuid,p_device_id uuid,p_reason text,p_idempotency_key text)
returns table(device_id uuid,credential_id uuid,register_id uuid,status text,public_key_fingerprint text,activated_at timestamptz,revoked_at timestamptz)
language plpgsql security definer set search_path='' as $function$
declare v_device public.devices%rowtype; v_credential public.device_credentials%rowtype; v_register uuid; v_command public.offline_device_management_commands%rowtype; v_command_fingerprint text:=pg_catalog.md5(p_device_id::text||E'\n'||p_reason);
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text||':'||lower(btrim(p_idempotency_key)),0));
 select * into v_command from public.offline_device_management_commands where tenant_id=p_tenant_id and normalized_idempotency_key=lower(btrim(p_idempotency_key));
 if found then
  if v_command.command_type<>'revoke' or v_command.command_fingerprint<>v_command_fingerprint then raise exception using errcode='ID409',message='device command idempotency conflict'; end if;
  select * into v_device from public.devices where tenant_id=p_tenant_id and id=v_command.device_id; select * into v_credential from public.device_credentials where tenant_id=p_tenant_id and id=v_command.credential_id; select a.register_id into v_register from public.register_device_assignments a where a.tenant_id=p_tenant_id and a.device_id=p_device_id and a.unassigned_at is null;
  return query select v_device.id,v_credential.id,v_register,v_device.status,v_credential.public_key_fingerprint,v_device.activated_at,v_device.revoked_at; return;
 end if;
 select * into v_device from public.devices where tenant_id=p_tenant_id and id=p_device_id for update;
 if not found then raise exception using errcode='OD404',message='device not found'; end if;
 if v_device.status <> 'revoked' then
   update public.devices set status='revoked',revoked_at=now(),revocation_reason=p_reason,updated_at=now() where tenant_id=p_tenant_id and id=p_device_id returning * into v_device;
   update public.device_credentials c set status='revoked',valid_to=now() where c.tenant_id=p_tenant_id and c.device_id=p_device_id and c.status='active';
 end if;
 select * into v_credential from public.device_credentials c where c.tenant_id=p_tenant_id and c.device_id=p_device_id order by c.created_at desc limit 1;
 select a.register_id into v_register from public.register_device_assignments a where a.tenant_id=p_tenant_id and a.device_id=p_device_id and a.unassigned_at is null;
 insert into public.offline_device_management_commands(tenant_id,idempotency_key,command_type,command_fingerprint,device_id,credential_id) values(p_tenant_id,p_idempotency_key,'revoke',v_command_fingerprint,v_device.id,v_credential.id);
 return query select v_device.id,v_credential.id,v_register,v_device.status,v_credential.public_key_fingerprint,v_device.activated_at,v_device.revoked_at;
end;
$function$;

create function offline_pos_private.issue_grant(p_tenant_id uuid,p_device_id uuid,p_register_id uuid,p_operator_membership_id uuid,p_idempotency_key text)
returns setof public.offline_grants language plpgsql security definer set search_path='' as $function$
declare v_policy public.offline_pos_policies%rowtype; v_branch uuid; v_location uuid; v_currency text; v_grant public.offline_grants%rowtype; v_now timestamptz:=now(); v_catalog jsonb; v_fingerprint text:=pg_catalog.md5(p_device_id::text||E'\n'||p_register_id::text||E'\n'||p_operator_membership_id::text);
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text||':'||lower(btrim(p_idempotency_key)),0));
 select * into v_grant from public.offline_grants where tenant_id=p_tenant_id and normalized_issuance_idempotency_key=lower(btrim(p_idempotency_key));
 if found then
  if v_grant.issuance_fingerprint<>v_fingerprint then raise exception using errcode='ID409',message='grant issuance idempotency conflict'; end if;
  return next v_grant; return;
 end if;
 select branch_id,default_inventory_location_id,selling_currency into v_branch,v_location,v_currency from public.registers where tenant_id=p_tenant_id and id=p_register_id and status='active';
 if not found then raise exception using errcode='OD404',message='register not found'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text||':'||v_location::text,0));
 select * into v_policy from public.offline_pos_policies where tenant_id=p_tenant_id and register_id=p_register_id;
 if not found or not v_policy.enabled then raise exception using errcode='OP403',message='offline selling disabled'; end if;
 perform 1 from public.devices d join public.register_device_assignments a on a.tenant_id=d.tenant_id and a.device_id=d.id and a.unassigned_at is null
 where d.tenant_id=p_tenant_id and d.id=p_device_id and d.status='active' and a.register_id=p_register_id;
 if not found then raise exception using errcode='OD410',message='device unavailable'; end if;
 if exists(select 1 from public.offline_grants g join public.devices d on d.tenant_id=g.tenant_id and d.id=g.device_id and d.status='active' where g.tenant_id=p_tenant_id and g.inventory_location_id=v_location and g.device_id<>p_device_id and g.accepted_until>v_now) then
   raise exception using errcode='OL409',message='location already has active offline authority';
 end if;
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'productId',p.id,'brandId',p.brand_id,'name',p.name,'active',p.status='active',
   'variants',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'variantId',pv.id,'sku',pv.sku,'optionSummary',pv.display_name,
      'active',(p.status='active' and pv.status='active'),
      'authorizedUnitPriceMinor',vp.amount_minor,'priceId',vp.id,'priceVersion',vp.updated_at,
      'advisoryInventory',pg_catalog.jsonb_build_object('onHandQuantity',coalesce(ib.on_hand_quantity,0),'version',coalesce(ib.version,0),'asOf',coalesce(ib.updated_at,v_now))
    ) order by pv.sku,pv.id),'[]'::jsonb)
    from public.product_variants pv
    join public.variant_prices vp on vp.tenant_id=pv.tenant_id and vp.variant_id=pv.id and vp.currency=v_currency and vp.status='active'
    left join public.inventory_balances ib on ib.tenant_id=pv.tenant_id and ib.variant_id=pv.id and ib.inventory_location_id=v_location
    where pv.tenant_id=p_tenant_id and pv.product_id=p.id)
  ) order by p.name,p.id),'[]'::jsonb) into v_catalog
 from public.products p
 where p.tenant_id=p_tenant_id
   and exists(select 1 from public.branch_brands bb where bb.tenant_id=p_tenant_id and bb.branch_id=v_branch and bb.brand_id=p.brand_id)
   and exists(select 1 from public.product_variants pv join public.variant_prices vp on vp.tenant_id=pv.tenant_id and vp.variant_id=pv.id and vp.currency=v_currency and vp.status='active' where pv.tenant_id=p_tenant_id and pv.product_id=p.id);
 insert into public.offline_grants(tenant_id,device_id,register_id,branch_id,inventory_location_id,operator_membership_id,currency,
   operator_expires_at,catalog_valid_until,accepted_until,max_sale_amount_minor,max_cumulative_exposure_minor,max_quantity_per_line,max_pending_offline_sales,catalog_snapshot,issuance_idempotency_key,issuance_fingerprint)
 values(p_tenant_id,p_device_id,p_register_id,v_branch,v_location,p_operator_membership_id,v_currency,
   v_now+pg_catalog.make_interval(secs=>v_policy.operator_lease_seconds),v_now+pg_catalog.make_interval(secs=>v_policy.catalog_grant_seconds),
   least(v_now+pg_catalog.make_interval(secs=>v_policy.operator_lease_seconds),v_now+pg_catalog.make_interval(secs=>v_policy.catalog_grant_seconds)),
   v_policy.max_sale_amount_minor,v_policy.max_cumulative_exposure_minor,v_policy.max_quantity_per_line,v_policy.max_pending_offline_sales,v_catalog,p_idempotency_key,v_fingerprint) returning * into v_grant;
 return next v_grant;
end;
$function$;

grant create on schema inventory_private to inventory_writer;
create function inventory_private.lock_balance_for_offline_sale(
  p_tenant_id uuid, p_variant_id uuid, p_inventory_location_id uuid
) returns bigint
language sql security definer set search_path='' as $function$
  select b.on_hand_quantity
  from public.inventory_balances b
  where b.tenant_id = p_tenant_id
    and b.variant_id = p_variant_id
    and b.inventory_location_id = p_inventory_location_id
  for update;
$function$;
alter function inventory_private.lock_balance_for_offline_sale(uuid,uuid,uuid) owner to inventory_writer;
revoke create on schema inventory_private from inventory_writer;
revoke all on function inventory_private.lock_balance_for_offline_sale(uuid,uuid,uuid) from public;
grant execute on function inventory_private.lock_balance_for_offline_sale(uuid,uuid,uuid) to offline_pos_writer;

create function offline_pos_private.record_offline_sale(p_tenant_id uuid,p_credential_id uuid,p_command jsonb,p_canonical text,p_fingerprint text,p_signature text)
returns table(ingestion_id uuid,sync_status text,order_id uuid,payment_id uuid,fulfillment_id uuid,reconciliation_id uuid,received_at timestamptz)
language plpgsql security definer set search_path='' as $function$
declare v_grant public.offline_grants%rowtype; v_existing public.offline_sale_ingestions%rowtype; v_device_status text; v_element jsonb; v_snapshot jsonb;
 v_total numeric:=0; v_quantity bigint; v_variant uuid; v_price bigint; v_price_id uuid; v_order_lines jsonb:='[]'; v_fulfillment_lines jsonb:='[]';
 v_brand uuid; v_order uuid; v_payment uuid; v_fulfillment uuid; v_inventory_operation uuid; v_ingestion uuid; v_reconciliation uuid;
 v_sufficient boolean:=true; v_reason text; v_suffix text; v_received timestamptz:=now(); v_accepted timestamptz; v_sync uuid; v_line record;
begin
 v_sync := (p_command->>'syncCommandId')::uuid;
 select * into v_existing from public.offline_sale_ingestions where tenant_id=p_tenant_id and sync_command_id=v_sync;
 if found then
   if v_existing.command_fingerprint<>p_fingerprint then raise exception using errcode='ID409',message='offline idempotency conflict'; end if;
   select r.id into v_reconciliation from public.offline_reconciliations r where r.tenant_id=p_tenant_id and r.ingestion_id=v_existing.id;
   return query select v_existing.id,v_existing.sync_status,v_existing.order_id,v_existing.payment_id,v_existing.fulfillment_id,v_reconciliation,v_existing.received_at; return;
 end if;
 select * into v_grant from public.offline_grants where tenant_id=p_tenant_id and id=(p_command->>'grantId')::uuid;
 if not found then raise exception using errcode='OG404',message='grant not found'; end if;
 if (p_command->>'deviceId')::uuid<>v_grant.device_id or (p_command->>'registerId')::uuid<>v_grant.register_id or p_command->>'currency'<>v_grant.currency then raise exception using errcode='OG403',message='grant binding mismatch'; end if;
 if (p_command->>'schemaVersion')::integer<>v_grant.schema_version then raise exception using errcode='OG422',message='schema version unsupported'; end if;
 v_accepted := (p_command->>'acceptedAt')::timestamptz;
 if v_accepted < v_grant.issued_at-interval '5 minutes' or v_accepted>v_grant.accepted_until or v_accepted>v_received+interval '5 minutes' then raise exception using errcode='OG410',message='acceptedAt outside grant authority'; end if;
 select d.status into v_device_status from public.devices d where d.tenant_id=p_tenant_id and d.id=v_grant.device_id;
 perform 1 from public.device_credentials c where c.tenant_id=p_tenant_id and c.id=p_credential_id and c.device_id=v_grant.device_id and c.valid_from<=v_accepted and (c.valid_to is null or c.valid_to>=v_accepted);
 if not found then raise exception using errcode='OS401',message='credential not valid at acceptance'; end if;
 if (p_command->>'offlineSaleOrdinal')::integer>v_grant.max_pending_offline_sales then raise exception using errcode='OL422',message='pending sale limit exceeded'; end if;
 for v_element in select value from pg_catalog.jsonb_array_elements(p_command->'lines') loop
   v_variant:=(v_element->>'variantId')::uuid; v_quantity:=(v_element->>'quantity')::bigint; v_price:=(v_element->>'grantedUnitPriceMinor')::bigint; v_price_id:=(v_element->>'priceId')::uuid;
   if v_quantity<=0 or v_quantity>v_grant.max_quantity_per_line then raise exception using errcode='OL422',message='line quantity limit exceeded'; end if;
   select variant into v_snapshot from (select variants.value variant from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) products(value), lateral pg_catalog.jsonb_array_elements(products.value->'variants') variants(value) where variants.value->>'variantId'=v_variant::text) q;
   if v_snapshot is null or (v_snapshot->>'authorizedUnitPriceMinor')::bigint<>v_price or (v_snapshot->>'priceId')::uuid<>v_price_id or not (v_snapshot->>'active')::boolean then raise exception using errcode='OG422',message='line not authorized by grant'; end if;
   select (product.value->>'brandId')::uuid into v_brand from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) product(value), lateral pg_catalog.jsonb_array_elements(product.value->'variants') variant(value) where variant.value->>'variantId'=v_variant::text;
   v_total:=v_total+v_quantity::numeric*v_price::numeric;
   v_order_lines:=v_order_lines||pg_catalog.jsonb_build_object('variant_id',v_variant,'product_id',(select (product.value->>'productId')::uuid from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) product(value), lateral pg_catalog.jsonb_array_elements(product.value->'variants') variant(value) where variant.value->>'variantId'=v_variant::text),'quantity',v_quantity,'unit_price_minor',v_price,'product_name',(select product.value->>'name' from pg_catalog.jsonb_array_elements(v_grant.catalog_snapshot) product(value), lateral pg_catalog.jsonb_array_elements(product.value->'variants') variant(value) where variant.value->>'variantId'=v_variant::text),'variant_name',null,'sku',v_snapshot->>'sku','option_summary',v_snapshot->>'optionSummary');
 end loop;
 if v_total::bigint<>(p_command->>'totalMinor')::bigint or (p_command->>'cashReceivedMinor')::bigint-v_total::bigint<>(p_command->>'changeMinor')::bigint or (p_command->>'cashReceivedMinor')::bigint<v_total then raise exception using errcode='OS422',message='offline monetary totals invalid'; end if;
 if v_total>v_grant.max_sale_amount_minor or (p_command->>'cumulativeExposureMinor')::bigint>v_grant.max_cumulative_exposure_minor or (p_command->>'cumulativeExposureMinor')::bigint<v_total then raise exception using errcode='OL422',message='offline exposure limit exceeded'; end if;
 if coalesce((select sum((i.price_provenance->>'totalMinor')::bigint) from public.offline_sale_ingestions i where i.tenant_id=p_tenant_id and i.grant_id=v_grant.id),0)+v_total>v_grant.max_cumulative_exposure_minor then raise exception using errcode='OL422',message='cumulative exposure exceeded'; end if;
 v_suffix:=pg_catalog.md5(p_tenant_id::text||':'||v_sync::text);
 v_order:=orders_private.create_order(p_tenant_id,'pos',v_grant.currency,v_brand,v_grant.branch_id,v_grant.register_id,v_grant.operator_membership_id,'offline-order:'||v_suffix,v_accepted,'Accepted offline; synchronized later.',v_order_lines);
 v_payment:=payments_private.capture_cash_payment(p_tenant_id,v_order,(p_command->>'cashReceivedMinor')::bigint,v_grant.operator_membership_id,'offline-payment:'||v_suffix);
 if v_device_status='revoked' then v_sufficient:=false; v_reason:='device_revoked_at_ingestion';
 else
   for v_element in select value from pg_catalog.jsonb_array_elements(p_command->'lines') loop
     v_quantity:=inventory_private.lock_balance_for_offline_sale(p_tenant_id,(v_element->>'variantId')::uuid,v_grant.inventory_location_id);
     if coalesce(v_quantity,0)<(v_element->>'quantity')::bigint then v_sufficient:=false; end if;
   end loop;
   if not v_sufficient then v_reason:='insufficient_stock_at_ingestion'; end if;
 end if;
 if v_sufficient then
   for v_line in select l.id,l.quantity from public.order_lines l where l.tenant_id=p_tenant_id and l.order_id=v_order order by l.line_number loop v_fulfillment_lines:=v_fulfillment_lines||pg_catalog.jsonb_build_object('order_line_id',v_line.id,'quantity',v_line.quantity); end loop;
   select f.fulfillment_id,f.inventory_operation_id into v_fulfillment,v_inventory_operation from fulfillments_private.record_fulfillment(p_tenant_id,v_order,v_grant.inventory_location_id,v_grant.operator_membership_id,'offline-fulfillment:'||v_suffix,v_received,v_fulfillment_lines) f;
 end if;
 insert into public.offline_sale_ingestions(tenant_id,grant_id,device_id,credential_id,register_id,branch_id,inventory_location_id,local_sale_id,sync_command_id,command_fingerprint,canonical_command,device_signature_base64,accepted_at,received_at,order_id,payment_id,fulfillment_id,sync_status,price_provenance)
 values(p_tenant_id,v_grant.id,v_grant.device_id,p_credential_id,v_grant.register_id,v_grant.branch_id,v_grant.inventory_location_id,p_command->>'localSaleId',v_sync,p_fingerprint,p_canonical,p_signature,v_accepted,v_received,v_order,v_payment,v_fulfillment,case when v_sufficient then 'synced' else 'needs_reconciliation' end,pg_catalog.jsonb_build_object('grantId',v_grant.id,'snapshotId',v_grant.snapshot_id,'lines',p_command->'lines','totalMinor',v_total::bigint)) returning id into v_ingestion;
 if not v_sufficient then
   insert into public.offline_reconciliations(tenant_id,ingestion_id,local_sale_id,order_id,payment_id,reason) values(p_tenant_id,v_ingestion,p_command->>'localSaleId',v_order,v_payment,v_reason) returning id into v_reconciliation;
   insert into public.offline_reconciliation_events(tenant_id,reconciliation_id,reason) values(p_tenant_id,v_reconciliation,v_reason);
 end if;
 return query select v_ingestion,case when v_sufficient then 'synced' else 'needs_reconciliation' end,v_order,v_payment,v_fulfillment,v_reconciliation,v_received;
exception when unique_violation then
 select * into v_existing from public.offline_sale_ingestions where tenant_id=p_tenant_id and sync_command_id=v_sync;
 if not found or v_existing.command_fingerprint<>p_fingerprint then raise exception using errcode='ID409',message='offline idempotency conflict'; end if;
 select id into v_reconciliation from public.offline_reconciliations where tenant_id=p_tenant_id and ingestion_id=v_existing.id;
 return query select v_existing.id,v_existing.sync_status,v_existing.order_id,v_existing.payment_id,v_existing.fulfillment_id,v_reconciliation,v_existing.received_at;
end;
$function$;

grant select,insert,update on public.devices,public.register_device_assignments to offline_pos_writer;
grant select,insert,update on public.device_credentials to offline_pos_writer;
grant select,insert on public.offline_device_management_commands,public.offline_grants,public.offline_sale_ingestions,public.offline_reconciliations,public.offline_reconciliation_events to offline_pos_writer;
grant select on public.offline_pos_policies,public.registers,public.inventory_balances,public.order_lines to offline_pos_writer;
grant select on public.products,public.product_variants,public.variant_prices,public.branch_brands to offline_pos_writer;
grant execute on function orders_private.create_order(uuid,text,text,uuid,uuid,uuid,uuid,text,timestamptz,text,jsonb) to offline_pos_writer;
grant execute on function payments_private.capture_cash_payment(uuid,uuid,bigint,uuid,text) to offline_pos_writer;
grant execute on function fulfillments_private.record_fulfillment(uuid,uuid,uuid,uuid,text,timestamptz,jsonb) to offline_pos_writer;

create policy offline_writer_devices on public.devices for all to offline_pos_writer using(true) with check(true);
create policy offline_writer_assignments on public.register_device_assignments for all to offline_pos_writer using(true) with check(true);
create policy offline_writer_policies on public.offline_pos_policies for select to offline_pos_writer using(true);
create policy offline_writer_registers on public.registers for select to offline_pos_writer using(true);
create policy offline_writer_balances on public.inventory_balances for select to offline_pos_writer using(true);
create policy offline_writer_order_lines on public.order_lines for select to offline_pos_writer using(true);
create policy offline_writer_products on public.products for select to offline_pos_writer using(true);
create policy offline_writer_variants on public.product_variants for select to offline_pos_writer using(true);
create policy offline_writer_prices on public.variant_prices for select to offline_pos_writer using(true);
create policy offline_writer_branch_brands on public.branch_brands for select to offline_pos_writer using(true);

alter table public.offline_pos_policies enable row level security;
alter table public.device_credentials enable row level security;
alter table public.offline_device_management_commands enable row level security;
alter table public.offline_grants enable row level security;
alter table public.offline_sale_ingestions enable row level security;
alter table public.offline_reconciliations enable row level security;
alter table public.offline_reconciliation_events enable row level security;
revoke all on table public.offline_pos_policies,public.device_credentials,public.offline_device_management_commands,public.offline_grants,public.offline_sale_ingestions,public.offline_reconciliations,public.offline_reconciliation_events from public;

grant create on schema public,offline_pos_private to offline_pos_writer;
alter table public.device_credentials owner to offline_pos_writer;
alter table public.offline_device_management_commands owner to offline_pos_writer;
alter table public.offline_grants owner to offline_pos_writer;
alter table public.offline_sale_ingestions owner to offline_pos_writer;
alter table public.offline_reconciliations owner to offline_pos_writer;
alter table public.offline_reconciliation_events owner to offline_pos_writer;
alter function offline_pos_private.forbid_immutable_mutation() owner to offline_pos_writer;
alter function offline_pos_private.enroll_device(uuid,uuid,uuid,text,text,text,text,text,text,text,text) owner to offline_pos_writer;
alter function offline_pos_private.rotate_credential(uuid,uuid,text,text,text) owner to offline_pos_writer;
alter function offline_pos_private.revoke_device(uuid,uuid,text,text) owner to offline_pos_writer;
alter function offline_pos_private.issue_grant(uuid,uuid,uuid,uuid,text) owner to offline_pos_writer;
alter function offline_pos_private.record_offline_sale(uuid,uuid,jsonb,text,text,text) owner to offline_pos_writer;
revoke create on schema public,offline_pos_private from offline_pos_writer;
revoke all on all functions in schema offline_pos_private from public;

do $block$
begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='service_role') then
  execute 'grant select on public.offline_pos_policies,public.device_credentials,public.offline_device_management_commands,public.offline_grants,public.offline_sale_ingestions,public.offline_reconciliations,public.offline_reconciliation_events to service_role';
  execute 'grant usage on schema offline_pos_private to service_role';
  execute 'grant execute on function offline_pos_private.enroll_device(uuid,uuid,uuid,text,text,text,text,text,text,text,text) to service_role';
  execute 'grant execute on function offline_pos_private.rotate_credential(uuid,uuid,text,text,text) to service_role';
  execute 'grant execute on function offline_pos_private.revoke_device(uuid,uuid,text,text) to service_role';
  execute 'grant execute on function offline_pos_private.issue_grant(uuid,uuid,uuid,uuid,text) to service_role';
  execute 'grant execute on function offline_pos_private.record_offline_sale(uuid,uuid,jsonb,text,text,text) to service_role';
 end if;
end;
$block$;

comment on table public.offline_grants is 'Immutable server-issued offline price and policy authority; expiry prevents new acceptance but not later ingestion.';
comment on table public.offline_sale_ingestions is 'Permanently replay-safe mapping from signed offline command to canonical commerce entities; no automatic retention deletion.';
comment on column public.offline_sale_ingestions.accepted_at is 'Device-observed time trusted only within the bounded server-issued grant window and five-minute skew allowance.';
