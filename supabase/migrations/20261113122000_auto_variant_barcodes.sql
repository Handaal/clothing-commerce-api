-- Numeric Code 128 labels are tenant-unique and never reused. Existing variants are backfilled.
create table public.variant_barcode_sequences (
  tenant_id uuid primary key references public.tenants(id) on delete restrict,
  last_value bigint not null check (last_value >= 999)
);
revoke all on public.variant_barcode_sequences from public, anon, authenticated, service_role;

insert into public.variant_barcode_sequences(tenant_id,last_value)
select tenant_id, greatest(999, max(value::bigint))
from public.variant_barcodes
where value ~ '^[0-9]{1,15}$'
group by tenant_id;

create function public.allocate_variant_barcode(p_tenant uuid, p_variant uuid)
returns text language plpgsql security definer set search_path = '' as $function$
declare
  v_number bigint;
  v_value text;
begin
  if p_tenant is null or p_variant is null then
    raise exception using errcode = '22023', message = 'Invalid variant barcode target';
  end if;
  loop
    insert into public.variant_barcode_sequences(tenant_id,last_value)
      values(p_tenant,1000)
      on conflict (tenant_id) do update
        set last_value = public.variant_barcode_sequences.last_value + 1
      returning last_value into v_number;
    v_value := v_number::text;
    insert into public.variant_barcodes(tenant_id,variant_id,value,barcode_type,is_primary)
      values(p_tenant,p_variant,v_value,'code128',true)
      on conflict (tenant_id,normalized_value) do nothing;
    if found then return v_value; end if;
  end loop;
end;
$function$;
revoke all on function public.allocate_variant_barcode(uuid,uuid) from public, anon, authenticated, service_role;

create function public.auto_variant_barcode() returns trigger
language plpgsql security definer set search_path = '' as $function$
begin
  perform public.allocate_variant_barcode(new.tenant_id,new.id);
  return new;
end;
$function$;
revoke all on function public.auto_variant_barcode() from public, anon, authenticated, service_role;
create trigger product_variant_auto_barcode
  after insert on public.product_variants
  for each row execute function public.auto_variant_barcode();

do $backfill$
declare v_variant record;
begin
  for v_variant in
    select pv.tenant_id, pv.id from public.product_variants pv
    where not exists (
      select 1 from public.variant_barcodes vb
      where vb.tenant_id = pv.tenant_id and vb.variant_id = pv.id
        and vb.is_primary and vb.status = 'active'
    )
    order by pv.tenant_id,pv.created_at,pv.id
  loop
    perform public.allocate_variant_barcode(v_variant.tenant_id,v_variant.id);
  end loop;
end;
$backfill$;
