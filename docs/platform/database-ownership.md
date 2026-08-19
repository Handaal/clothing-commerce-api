# Database Ownership

Only `clothing-commerce-api/supabase` may contain future Supabase schema, migrations, and seed
tooling. POS, storefront, and admin mobile contain no database migration directories and must not
query privileged business tables.

Future migrations are append-only and auditable. Tenant-owned records require explicit tenant
isolation with deny-by-default protection. Inventory quantities are authoritative only in the
commerce core and eventually change through an append-only movement ledger.
