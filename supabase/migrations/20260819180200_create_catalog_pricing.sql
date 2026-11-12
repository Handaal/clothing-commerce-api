-- Phase 2A: minimal variant-level base-price persistence.

create table public.variant_prices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  variant_id uuid not null,
  currency text not null,
  amount_minor bigint not null,
  status text not null default 'active',
  archived_at timestamptz,
  archive_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint variant_prices_tenant_fk
    foreign key (tenant_id) references public.tenants (id) on delete restrict,
  constraint variant_prices_variant_tenant_fk
    foreign key (tenant_id, variant_id)
    references public.product_variants (tenant_id, id)
    on delete restrict,
  constraint variant_prices_currency_valid check (currency ~ '^[A-Z]{3}$'),
  constraint variant_prices_amount_nonnegative check (amount_minor >= 0),
  constraint variant_prices_status_valid check (status in ('active', 'archived')),
  constraint variant_prices_archive_state_consistent check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint variant_prices_updated_after_created check (updated_at >= created_at),
  constraint variant_prices_tenant_id_unique unique (tenant_id, id)
);

comment on table public.variant_prices is
  'Variant/currency base-price history in minor units. Channel, branch, promotion, tax, and compare-at pricing are deferred.';

create unique index variant_prices_one_active_currency_idx
  on public.variant_prices (tenant_id, variant_id, currency)
  where status = 'active';

create index variant_prices_variant_history_idx
  on public.variant_prices (tenant_id, variant_id, currency, created_at desc);
