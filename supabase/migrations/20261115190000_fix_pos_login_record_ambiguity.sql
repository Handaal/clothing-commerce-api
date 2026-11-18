-- Fix: staff_private.pos_login_record could never record a FAILED connected POS sign-in.
--
-- Found 2026-11-15 by the offline PIN v2 step-up acceptance (a wrong sign-in PIN must answer 401 and count
-- toward the sign-in lockout). The function RETURNS TABLE(locked_until, failed_count); in PL/pgSQL those OUT
-- columns are variables, so the unqualified `returning failed_count, locked_until` (and the lock branch's
-- `returning locked_until, failed_count`) raised 42702 "column reference is ambiguous". Every failed attempt
-- therefore errored and rolled back: the caller saw a 500 instead of INVALID_CREDENTIALS, and the failed
-- attempt was never counted, so the connected sign-in lockout NEVER engaged. Successful sign-ins were not
-- affected (that branch has no RETURNING).
--
-- Forward-only: `create or replace` with the same signature keeps owner and grants. The behaviour is exactly
-- the originally intended one (5 failures → locked_until now()+30 s, counter reset); only the column
-- references are qualified through a table alias. The 30-second lock window itself is unchanged (a policy
-- question for the owner, not part of this fix).
create or replace function staff_private.pos_login_record(p_username text, p_success boolean)
returns table(locked_until timestamptz, failed_count integer)
language plpgsql security definer set search_path='' as $f$
declare
  v_username text := lower(btrim(coalesce(p_username,'')));
  v_failed integer; v_locked timestamptz;
begin
  if p_success then
    delete from public.pos_login_attempts a where a.username=v_username;
    return query select null::timestamptz, 0;
    return;
  end if;

  insert into public.pos_login_attempts as a (username,failed_count,locked_until,updated_at)
    values(v_username,1,null,now())
  on conflict (username) do update set
    failed_count = a.failed_count + 1,
    updated_at = now()
  returning a.failed_count, a.locked_until into v_failed, v_locked;

  if v_failed >= 5 then
    update public.pos_login_attempts a
      set locked_until = now() + interval '30 seconds', failed_count = 0, updated_at = now()
      where a.username=v_username
      returning a.locked_until, a.failed_count into v_locked, v_failed;
  end if;

  return query select v_locked, v_failed;
end $f$;
