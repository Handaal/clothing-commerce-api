-- Connected POS Sale V1: a Register is the trusted source of checkout currency.
alter table public.registers
  add column selling_currency text not null default 'USD',
  add constraint registers_selling_currency_valid check (selling_currency ~ '^[A-Z]{3}$');

comment on column public.registers.selling_currency is
  'Trusted three-character selling currency used to resolve authoritative catalog prices for POS sales. Clients cannot override it.';
