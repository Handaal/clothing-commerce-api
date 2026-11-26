-- ADR-043 — POS-native account lifecycle hardening (additive; no data rewrite, no new grants to clients).
--
-- G1  A POS PIN reset (any update of the online verifier hash in staff_pos_pin_credentials) now revokes every
--     active offline-PIN enrollment of that membership in the same transaction (reason 'pin_reset'). The
--     device-local verifiers were derived from the OLD PIN (same-PIN model, offline PIN v2); without this they
--     stayed authorised offline after a reset. Tills drop them at their next bootstrap and the next successful
--     online sign-in re-enrols the new PIN.
--
-- G2  Last-active-POS-admin protection: an operation may never leave a tenant that HAS an active POS admin with
--     none — neither by demoting the last admin's pos_role nor by moving the last admin's membership out of
--     'active'. Raised as SQLSTATE ST414 (mapped to LAST_POS_ADMIN, HTTP 409). Serialised per tenant with a
--     transaction-scoped advisory lock so two concurrent demotions cannot both pass.
--
-- Both are triggers so every write path (pos_pin RPCs, set_staff_status from Admin Mobile or the POS) obeys them.

create function staff_private.revoke_offline_pins_on_pin_reset()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.hash_base64 is distinct from old.hash_base64 or new.salt_base64 is distinct from old.salt_base64 then
    update public.staff_offline_pin_enrollments e
       set revoked_at = now(), revoked_reason = 'pin_reset'
     where e.tenant_id = new.tenant_id and e.membership_id = new.membership_id and e.revoked_at is null;
  end if;
  return new;
end;
$function$;

create trigger staff_pos_pin_credentials_pin_reset_revokes_offline
  after update of hash_base64, salt_base64 on public.staff_pos_pin_credentials
  for each row execute function staff_private.revoke_offline_pins_on_pin_reset();

-- True when another ACTIVE membership of the tenant (other than p_membership) holds pos_role 'admin'.
create function staff_private.other_active_pos_admin_exists(p_tenant uuid, p_membership uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.staff_pos_pin_credentials c
      join public.memberships m on m.tenant_id = c.tenant_id and m.id = c.membership_id
     where c.tenant_id = p_tenant and c.membership_id <> p_membership
       and c.pos_role = 'admin' and m.status = 'active');
$function$;

create function staff_private.guard_last_pos_admin_role()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if old.pos_role = 'admin' and new.pos_role <> 'admin' and exists (
      select 1 from public.memberships m
       where m.tenant_id = old.tenant_id and m.id = old.membership_id and m.status = 'active') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('last_pos_admin:' || old.tenant_id::text, 0));
    if not staff_private.other_active_pos_admin_exists(old.tenant_id, old.membership_id) then
      raise exception using errcode = 'ST414', message = 'Operation would remove the last active POS administrator';
    end if;
  end if;
  return new;
end;
$function$;

create trigger staff_pos_pin_credentials_last_admin_guard
  before update of pos_role on public.staff_pos_pin_credentials
  for each row execute function staff_private.guard_last_pos_admin_role();

create function staff_private.guard_last_pos_admin_membership()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if old.status = 'active' and new.status <> 'active' and exists (
      select 1 from public.staff_pos_pin_credentials c
       where c.tenant_id = old.tenant_id and c.membership_id = old.id and c.pos_role = 'admin') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('last_pos_admin:' || old.tenant_id::text, 0));
    if not staff_private.other_active_pos_admin_exists(old.tenant_id, old.id) then
      raise exception using errcode = 'ST414', message = 'Operation would remove the last active POS administrator';
    end if;
  end if;
  return new;
end;
$function$;

create trigger memberships_last_pos_admin_guard
  before update of status on public.memberships
  for each row execute function staff_private.guard_last_pos_admin_membership();

revoke all on function
  staff_private.revoke_offline_pins_on_pin_reset(),
  staff_private.other_active_pos_admin_exists(uuid, uuid),
  staff_private.guard_last_pos_admin_role(),
  staff_private.guard_last_pos_admin_membership()
from public, anon, authenticated;
