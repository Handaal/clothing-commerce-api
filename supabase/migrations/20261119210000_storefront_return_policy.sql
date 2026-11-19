-- Phase 4 follow-up: the Storefront shows the store's real return window.
--
-- The window is the tenant's editable return setting (return_settings.window_days, edited in Admin
-- Mobile / POS Settings → Returns). This public read exposes only whether the store accepts returns and
-- the number of days, so the website's copy follows the setting instead of hard-coding a number.

create function online_private.storefront_return_policy(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'acceptingReturns', coalesce(s.enabled, false),
    'windowDays', case when coalesce(s.enabled, false) then s.window_days else null end
  )
  from public.tenants t
  left join public.return_settings s on s.tenant_id = t.id
  where t.id = p_tenant and t.status = 'active';
$function$;

revoke all on function online_private.storefront_return_policy(uuid) from public;
do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function online_private.storefront_return_policy(uuid) to service_role';
  end if;
end;
$block$;
