-- A cashier-confirmed POS sale may correct the name on an existing customer matched by phone.
-- Keep the phone as the stable tenant-scoped match key and update the name inside the sale transaction.
create or replace function orders_private.upsert_pos_customer(p_tenant uuid, p_name text, p_phone text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_norm text := pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^+0-9]', '', 'g');
  v_id uuid;
begin
  if v_name = '' or pg_catalog.length(v_name) > 200 then
    raise exception using errcode = '22023', message = 'customer name is required';
  end if;
  if v_norm !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception using errcode = '22023', message = 'customer phone must be E.164';
  end if;
  select c.id into v_id from public.customers c
    where c.tenant_id = p_tenant and c.normalized_phone = v_norm limit 1;
  if found then
    update public.customers set name = v_name
      where tenant_id = p_tenant and id = v_id and name is distinct from v_name;
    return v_id;
  end if;
  insert into public.customers(tenant_id, name, phone)
    values (p_tenant, v_name, v_norm) returning id into v_id;
  return v_id;
end;
$function$;
alter function orders_private.upsert_pos_customer(uuid, text, text) owner to online_writer;
revoke all on function orders_private.upsert_pos_customer(uuid, text, text) from public;
grant execute on function orders_private.upsert_pos_customer(uuid, text, text) to pos_sales_writer;
