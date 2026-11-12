-- Phase 1C-B: identity-provider-neutral request context for tenant RLS.
-- The future trusted API/auth boundary supplies signed top-level JWT claims.

create schema if not exists commerce_context;

revoke all on schema commerce_context from public;

create function commerce_context.claim_uuid(claim_name text)
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  claim_value text;
begin
  claim_value := nullif(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> claim_name,
    ''
  );

  return claim_value::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$function$;

comment on function commerce_context.claim_uuid(text) is
  'Safely reads one UUID from trusted PostgREST JWT claims; malformed or missing values fail closed.';

create function commerce_context.current_user_identity_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when current_user = 'authenticated'
      then commerce_context.claim_uuid('user_identity_id')
    else null
  end
$function$;

comment on function commerce_context.current_user_identity_id() is
  'Returns the provider-neutral UserIdentity claim only for the authenticated database role.';

create function commerce_context.current_tenant_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when current_user = 'authenticated'
      then commerce_context.claim_uuid('tenant_id')
    else null
  end
$function$;

comment on function commerce_context.current_tenant_id() is
  'Returns the explicitly selected Tenant claim only for the authenticated database role.';

create function commerce_context.current_membership_id()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  selected_tenant_id uuid := commerce_context.current_tenant_id();
  selected_user_identity_id uuid := commerce_context.current_user_identity_id();
  selected_membership_id uuid;
begin
  if selected_tenant_id is null or selected_user_identity_id is null then
    return null;
  end if;

  select membership.id
  into selected_membership_id
  from public.memberships as membership
  where membership.tenant_id = selected_tenant_id
    and membership.user_identity_id = selected_user_identity_id
    and membership.status = 'active';

  return selected_membership_id;
end;
$function$;

comment on function commerce_context.current_membership_id() is
  'Derives the active Membership for the exact UserIdentity and Tenant request claims.';

create function commerce_context.has_active_membership()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select commerce_context.current_membership_id() is not null
$function$;

comment on function commerce_context.has_active_membership() is
  'True only when the authenticated request claims resolve to one active Membership.';

revoke execute on all functions in schema commerce_context from public;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    grant usage on schema commerce_context to authenticated;
    grant execute on all functions in schema commerce_context to authenticated;
  end if;
end;
$block$;
