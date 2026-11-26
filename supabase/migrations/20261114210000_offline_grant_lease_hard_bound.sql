-- ADR-042 §6.1 (owner D-5) — HARD LEASE BOUND AT GRANT ISSUANCE + VIOLATION VIEW (additive, forward-only).
--
-- 20261114165000 added offline_pos_policies_lease_bounds (operator lease <= 24 h, catalog window <= operator
-- lease) as NOT VALID, so it only checks rows written after it. A pre-existing row outside those bounds (the
-- shared dev register has catalog 24 h > operator 12 h) could still shape a grant. accepted_until was already
-- least(operator, catalog), so the catalog case never extended authority, but an operator lease above 24 h
-- would have. This migration makes the policy impossible to exceed WITHOUT rewriting anyone's settings:
--
--   * a BEFORE INSERT trigger on offline_grants clamps every new grant:
--       operator_expires_at <= issued_at + 24 h
--       catalog_valid_until  <= operator_expires_at          (catalog freshness never outlives the lease)
--       accepted_until       <= least(operator_expires_at, catalog_valid_until)
--     Stock/voucher/return grants and admin verifiers already expire at or before accepted_until.
--   * offline_pos_private.lease_policy_violations lists every policy row outside the bounds so an operator can
--     correct it (then VALIDATE the constraint). No settings row is modified here: changing a register's
--     configured values is an owner action.

create function offline_pos_private.clamp_offline_grant_lease()
returns trigger language plpgsql set search_path = '' as $function$
declare v_base timestamptz := coalesce(new.issued_at, pg_catalog.now());
begin
  new.operator_expires_at := least(new.operator_expires_at, v_base + interval '24 hours');
  new.catalog_valid_until := least(new.catalog_valid_until, new.operator_expires_at);
  new.accepted_until := least(new.accepted_until, new.operator_expires_at, new.catalog_valid_until);
  return new;
end;
$function$;
revoke all on function offline_pos_private.clamp_offline_grant_lease() from public;

create trigger offline_grants_clamp_lease
  before insert on public.offline_grants
  for each row execute function offline_pos_private.clamp_offline_grant_lease();

create view offline_pos_private.lease_policy_violations
with (security_invoker = true) as
  select p.tenant_id, p.register_id, p.operator_lease_seconds, p.catalog_grant_seconds,
         case
           when p.operator_lease_seconds > 86400 then 'operator_lease_above_24h'
           when p.catalog_grant_seconds > p.operator_lease_seconds then 'catalog_window_above_operator_lease'
         end as violation
    from public.offline_pos_policies p
   where not (p.operator_lease_seconds <= 86400 and p.catalog_grant_seconds <= p.operator_lease_seconds);
comment on view offline_pos_private.lease_policy_violations is
  'ADR-042 D-5: offline POS policy rows outside the lease bounds (operator <= 24 h, catalog <= operator). Grants issued from them are clamped; fix the row, then VALIDATE offline_pos_policies_lease_bounds.';
revoke all on offline_pos_private.lease_policy_violations from public;
do $b$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on offline_pos_private.lease_policy_violations to service_role;
  end if;
end $b$;
