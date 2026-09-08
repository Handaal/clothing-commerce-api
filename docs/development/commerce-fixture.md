# Local development commerce fixture

## Purpose

The [development identity provisioning](./authentication-local.md#development-identity-provisioning)
creates and authorizes the `dev-local` tenant, but leaves it **empty**. With no products, the Admin
Mobile Products read slice can only ever render its empty state, and the future Inventory / Orders /
Fulfillment slices have nothing to show.

`pnpm dev:provision-commerce-fixture` seeds a small, deterministic, representative commerce graph into
the existing `dev-local` tenant so those read surfaces have real data to render. It **complements** the
identity provisioning and never replaces it: identity provisioning sets up _who can read_; this fixture
sets up _what there is to read_.

## Local-only safety

Identical safety standard to identity provisioning. It is **development-only** and **local-only**:

- It refuses to run without the explicit `COMMERCE_DEV_FIXTURES=1` opt-in.
- It only targets the local Supabase container (`supabase_db_clothing-commerce-api`); a non-local
  Supabase host is a hard failure with no override — it cannot reach a remote or production project.
- It never auto-seeds during an API request, adds **no** production database function (the SQL is an
  anonymous `DO` block plus the existing sanctioned domain functions), and grants **no** permission,
  role, membership, or scope. It only inserts domain records into the already-authorized tenant. For
  Connected POS it includes one active deterministic register whose trusted default location is the
  fulfillment-enabled stockroom and whose `selling_currency` is `USD`.
  It also adds an offline-enabled register policy (12-hour operator lease, 24-hour catalog grant,
  explicit fixture-only sale/exposure/quantity/pending limits). Device enrollment still uses the API;
  no private key, public key, or hardcoded Clerk subject is stored by this fixture.
- It is idempotent and transactionally atomic: the whole graph commits together or not at all, and a
  re-run changes nothing.

All inventory, order, and fulfillment rows are written **only** through the existing canonical domain
functions (`inventory_private.record_operation`, `orders_private.create_order`,
`fulfillments_private.record_fulfillment`) with stable idempotency keys — never by bypassing a
business rule. `service_role` is not used as authorization; the SQL is applied as the local
`supabase_admin` transport, exactly like identity provisioning.

## Prerequisites

1. The API-capable local Supabase stack is running with migrations applied (`pnpm supabase:reset`).
   The repository's minimal `pnpm supabase:start` command is database-only; use the command below so
   the provisioning guards can positively identify the local API URL.
2. The `dev-local` tenant already exists — run `pnpm dev:provision-identity` first. If it is missing,
   the fixture fails clearly and seeds nothing.

## Command

```powershell
# Windows PowerShell
pnpm exec supabase start --exclude realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
pnpm supabase:reset
$env:COMMERCE_DEV_PROVISIONING = "1"
pnpm dev:provision-identity -- --clerk-subject <REAL_CLERK_USER_ID>

$env:COMMERCE_DEV_FIXTURES = "1"
pnpm dev:provision-commerce-fixture
```

```cmd
:: Windows cmd
set COMMERCE_DEV_FIXTURES=1
pnpm dev:provision-commerce-fixture
```

```bash
# bash / zsh
COMMERCE_DEV_FIXTURES=1 pnpm dev:provision-commerce-fixture
```

It prints a concise summary of the seeded entities and their deterministic ids; it prints no secrets.
`pnpm dev:provision-commerce-fixture -- --help` shows usage.

## Expected fixture graph

All ids are **deterministic** (stable across runs), so tests and the Admin Mobile detail route can rely
on a known product id.

- **Brand** `Dev Threads` (`DEV-BRAND`, active), explicitly operated by the fixture branch so
  register-resolved POS sales pass the server's branch/brand eligibility check.
- **Branch** `Dev Flagship` (`DEV-BRANCH`, active) and one sellable, fulfillment-enabled **inventory
  location** `Dev Flagship Stockroom` (`DEV-LOC-1`, id `10ca7100-…-000000000001`).
- **Product 1 — active** `Dev Linen Shirt` (id `90000000-…-000000000001`, style `DEV-LS-001`):
  - option **Size** with values **M**, **L**;
  - two active variants `DEV-LS-001-M` (Medium) and `DEV-LS-001-L` (Large), each `USD 25.99`.
- **Product 2 — draft** `Dev Canvas Tote` (id `90000000-…-000000000002`, style `DEV-CT-001`): one
  optionless active variant `DEV-CT-001` at `USD 18.99` — present so **status rendering** (draft) is
  visible in the list.
- **Inventory** opening stock at the location: M = 25, L = 40, Tote = 12 (via `record_operation`).
- **Order** — one placed `online` order (total `USD 129.95`) with two lines (3 × M, 2 × L).
- **Fulfillment** — one partial fulfillment: line 1 fully (3/3), line 2 partially (1/2) → overall
  `partially_fulfilled`, which issues stock, leaving on-hand M = 22, L = 39, Tote = 12.

## How Admin Mobile uses it

After provisioning, sign into Admin Mobile as the provisioned Clerk user and open **Products**:

- `GET /api/v1/products` returns the two fixture products (active + draft) for the tenant-wide
  `catalog.read` grant.
- Selecting `Dev Linen Shirt` (`GET /api/v1/products/90000000-…-000000000001`) returns its variants,
  the Size option/values, and the two prices — exercising the Product Detail runtime path.

The draft product verifies status rendering; the inventory, order, and fulfillment records are seeded
now so the later Inventory / Orders / Fulfillment read slices have representative data without
re-seeding.

## Idempotency, reset, and recreate

Running it again reuses every row and deducts no further stock — catalog rows use deterministic ids with
`ON CONFLICT DO NOTHING` on natural keys, and the inventory/order/fulfillment writes replay to the same
records via stable idempotency keys. Any failure rolls the whole graph back, never leaving partial data.

To wipe and recreate from scratch:

```powershell
pnpm supabase:reset            # drops all local data, re-applies migrations
$env:COMMERCE_DEV_PROVISIONING = "1"
pnpm dev:provision-identity -- --clerk-subject <REAL_CLERK_USER_ID>
$env:COMMERCE_DEV_FIXTURES = "1"
pnpm dev:provision-commerce-fixture
```

`pnpm supabase:stop` discards the disposable local stack entirely.

## Troubleshooting

- **`COMMERCE_DEV_FIXTURES=1` error:** the opt-in env var is unset; export it for the session.
- **`dev-local not found`:** run `pnpm dev:provision-identity` first to create the tenant.
- **Non-local host refusal:** `supabase status` points at a non-local host; this command only seeds the
  local stack by design.
- **Container/API not running:** start the API-capable local stack with the command in
  [Command](#command), then run `pnpm supabase:reset`.
