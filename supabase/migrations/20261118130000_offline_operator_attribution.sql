-- ADR-043 §5.1 — stable operator attribution for offline sales (additive; no data rewrite, no client grants).
--
-- Before: an offline sale was attributed only to the offline GRANT operator (whoever last signed in online on the
-- till and bootstrapped its authority). A different cashier who unlocked offline with their own PIN was not
-- recorded server-side.
--
-- Now the till's main process stamps `unlockedByMembershipId` into the device-signed sale command. At ingestion
-- (AFTER INSERT on offline_sale_ingestions, same transaction, so every ingestion path is covered) the server:
--   * VERIFIES the claim: it is the grant operator, OR the member held an offline-PIN enrollment on THAT device
--     covering acceptedAt (enrolled before it and not revoked at that moment);
--   * records one immutable attribution row (verified ⇒ attributed to the unlocking member; unverified ⇒ the
--     claim is kept as evidence and attribution falls back to the grant operator — never silently trusted);
--   * reports through the EXISTING pos_sync_conflicts surface (kind sync_integrity):
--       OFFLINE_OPERATOR_UNVERIFIED          — the claim could not be verified for that device/time;
--       OFFLINE_OPERATOR_CHANGED_BEFORE_SYNC — verified at acceptance, but before sync the member was deactivated
--                                             or suspended, or that enrollment was revoked (PIN reset, removal).
-- The sale itself is never rejected, rewritten or lost, and the grant's authority/limits are unchanged.

create table public.offline_sale_operator_attributions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  ingestion_id uuid not null,
  order_id uuid,
  sync_command_id uuid not null,
  device_id uuid not null,
  accepted_at timestamptz not null,
  grant_operator_membership_id uuid not null,
  claimed_membership_id uuid,
  attributed_membership_id uuid not null,
  attribution text not null,
  changed_before_sync boolean not null default false,
  recorded_at timestamptz not null default now(),
  constraint offline_sale_operator_attributions_kind check (
    attribution in ('grant_operator', 'verified_unlock', 'unverified_claim')),
  constraint offline_sale_operator_attributions_claim check (
    (attribution = 'grant_operator') = (claimed_membership_id is null)),
  constraint offline_sale_operator_attributions_ingestion_unique unique (tenant_id, ingestion_id),
  constraint offline_sale_operator_attributions_attributed_fk
    foreign key (tenant_id, attributed_membership_id) references public.memberships (tenant_id, id)
);
create index offline_sale_operator_attributions_member_idx
  on public.offline_sale_operator_attributions (tenant_id, attributed_membership_id, accepted_at desc);

comment on table public.offline_sale_operator_attributions is
  'ADR-043 §5.1: who actually operated the till for each offline sale (verified PIN unlock or grant operator). Unverified claims are kept as evidence only. Immutable; written by the ingestion trigger.';

alter table public.offline_sale_operator_attributions enable row level security;
revoke all on public.offline_sale_operator_attributions from public;
create trigger offline_sale_operator_attributions_immutable
  before update or delete on public.offline_sale_operator_attributions
  for each row execute function offline_pos_private.forbid_immutable_mutation();

create function offline_pos_private.attribute_offline_sale_operator()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_command jsonb := new.canonical_command::jsonb;
  v_claim_text text := v_command->>'unlockedByMembershipId';
  v_claim uuid;
  v_grant public.offline_grants%rowtype;
  v_enrollment public.staff_offline_pin_enrollments%rowtype;
  v_verified boolean := false;
  v_changed boolean := false;
  v_member_status text;
  v_row public.pos_sync_conflicts%rowtype;
begin
  select * into v_grant from public.offline_grants g where g.tenant_id = new.tenant_id and g.id = new.grant_id;

  if v_claim_text is null then
    insert into public.offline_sale_operator_attributions (tenant_id, ingestion_id, order_id, sync_command_id,
      device_id, accepted_at, grant_operator_membership_id, claimed_membership_id, attributed_membership_id,
      attribution)
    values (new.tenant_id, new.id, new.order_id, new.sync_command_id, new.device_id, new.accepted_at,
      v_grant.operator_membership_id, null, v_grant.operator_membership_id, 'grant_operator');
    return new;
  end if;

  v_claim := v_claim_text::uuid; -- the contract guarantees a UUID; a malformed value aborts ingestion (never silent)
  select m.status into v_member_status from public.memberships m where m.tenant_id = new.tenant_id and m.id = v_claim;

  if v_claim = v_grant.operator_membership_id then
    v_verified := true;
  elsif v_member_status is not null then
    select * into v_enrollment from public.staff_offline_pin_enrollments e
     where e.tenant_id = new.tenant_id and e.membership_id = v_claim and e.device_id = new.device_id
       and e.enrolled_at <= new.accepted_at and (e.revoked_at is null or e.revoked_at > new.accepted_at)
     order by e.verifier_version desc limit 1;
    v_verified := found;
  end if;

  if v_verified then
    v_changed := coalesce(v_member_status, 'missing') <> 'active'
      or (v_enrollment.id is not null and v_enrollment.revoked_at is not null
          and v_enrollment.revoked_at <= new.received_at and v_enrollment.revoked_reason <> 'superseded');
  end if;

  insert into public.offline_sale_operator_attributions (tenant_id, ingestion_id, order_id, sync_command_id,
    device_id, accepted_at, grant_operator_membership_id, claimed_membership_id, attributed_membership_id,
    attribution, changed_before_sync)
  values (new.tenant_id, new.id, new.order_id, new.sync_command_id, new.device_id, new.accepted_at,
    v_grant.operator_membership_id, v_claim,
    case when v_verified then v_claim else v_grant.operator_membership_id end,
    case when v_verified then 'verified_unlock' else 'unverified_claim' end, v_changed);

  if v_verified and not v_changed then return new; end if;

  v_row.tenant_id := new.tenant_id;
  v_row.dedupe_key := 'operator:' || new.sync_command_id::text;
  v_row.kind := 'sync_integrity';
  v_row.reason_code := case when v_verified then 'OFFLINE_OPERATOR_CHANGED_BEFORE_SYNC' else 'OFFLINE_OPERATOR_UNVERIFIED' end;
  v_row.status := 'open';
  v_row.branch_id := new.branch_id;
  v_row.inventory_location_id := new.inventory_location_id;
  v_row.device_id := new.device_id;
  v_row.register_id := new.register_id;
  v_row.grant_id := new.grant_id;
  v_row.source_table := 'offline_sale_ingestions';
  v_row.source_id := new.id;
  v_row.sync_command_id := new.sync_command_id;
  v_row.local_reference := new.local_sale_id;
  v_row.order_id := new.order_id;
  v_row.payment_id := new.payment_id;
  -- Only a verified member id is placed in the typed column; an unverified claim stays in the evidence.
  v_row.membership_id := case when v_verified then v_claim else null end;
  v_row.amount_minor := (new.price_provenance->>'totalMinor')::bigint;
  v_row.currency := v_grant.currency;
  v_row.local_event_at := new.accepted_at;
  v_row.local_evidence := pg_catalog.jsonb_build_object('localSaleId', new.local_sale_id,
    'acceptedAt', new.accepted_at, 'unlockedByMembershipId', v_claim);
  v_row.server_evidence := pg_catalog.jsonb_build_object('saleRecorded', true,
    'grantOperatorMembershipId', v_grant.operator_membership_id,
    'attributedMembershipId', case when v_verified then v_claim else v_grant.operator_membership_id end,
    'memberStatusAtSync', v_member_status,
    'enrollmentRevokedReason', v_enrollment.revoked_reason,
    'enrollmentRevokedAt', v_enrollment.revoked_at);
  perform offline_pos_private.record_sync_conflict(v_row);
  return new;
end;
$function$;

create trigger offline_sale_ingestions_attribute_operator
  after insert on public.offline_sale_ingestions
  for each row execute function offline_pos_private.attribute_offline_sale_operator();

revoke all on function offline_pos_private.attribute_offline_sale_operator() from public, anon, authenticated;

-- Read access for the server boundary only (management reads / reporting); no client role is granted anything.
do $grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant select on public.offline_sale_operator_attributions to service_role;
  end if;
end
$grants$;
