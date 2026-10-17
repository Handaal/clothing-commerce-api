# Supplier money extension

This additive extension turns the existing supplier-attributed receipt into an atomic, priced
supplier purchase and adds tenant-wide accounts-payable operations for the POS Suppliers desk.

## Accounting boundary

- Money is stored and transported as safe integer minor units in the tenant's `default_currency`.
- A purchase records immutable quantity, unit-cost and line-total facts and one initial paid amount.
- Purchase cost is an AP/history fact only. It does not value inventory, create FIFO/weighted cost
  layers, calculate COGS, or introduce purchase orders or supplier invoices.
- The first supplier purchase locks `default_currency`, preventing mixed-currency dues.
- Outstanding dues are server-computed as purchase totals minus initial purchase payments minus
  standalone supplier payments. A standalone payment is rejected when nothing is owed or when it
  exceeds the current due.
- Standalone payments remain supplier-level facts. Purchase reads display them oldest-first for
  operator comprehension, but no payment-to-invoice allocation is persisted.

## Atomicity and replay

`suppliers_private.record_supplier_purchase` validates the active supplier, active variants and
receiving-enabled destination, invokes the canonical multi-line inventory receipt, stores the
purchase and cost snapshots, and persists its replay response in one PostgreSQL transaction. Failure
rolls back both money and stock. `suppliers.manage` plus `inventory.receive` on the destination are
required.

All purchase, payment and reminder mutations require `Idempotency-Key`. The private
`supplier_money_commands` table stores command kind, normalized key, canonical JSON fingerprint and
original response under an advisory transaction lock. Exact replay returns the original response;
changed intent returns `IDEMPOTENCY_CONFLICT`. Authorization is rechecked before every repository
call, including replay.

## Reminders

Reminders store a tenant-local due date, optional amount, lead days, notification preference and
pending/done status. The API computes `isDue` and `isOverdue` using the tenant timezone. `dueOnly=true`
returns pending reminders whose lead window has opened. `notify` is retained for clients and future
delivery infrastructure; this extension does not add a background notification provider.

## Surface and responsible files

- Migration: `supabase/migrations/20261009120000_supplier_money.sql`
- Contracts: `src/contracts/management/suppliers.ts`
- Service/repository: `src/suppliers`
- Routes: `app/api/v1/suppliers/purchases`, `dues`, `reminders`, and supplier `payments`
- OpenAPI: `src/openapi/document.ts` and generated `openapi/openapi.json`
- SDK `0.19.0`: purchase, purchase-item, payment, dues and reminder methods on
  `TenantCommerceClient`

The packed artifact is `artifacts/shifted-clothing-commerce-sdk-0.19.0.tgz`, SHA-256
`78ca20340b19364ccba6936c048492e05fc2d7d6c444a2ee0ef52380e38f3c30`.

Apply the migration before deploying API/SDK `0.19.0`. `suppliers_private` is already exposed to
PostgREST by the supplier foundation; direct client table access remains revoked and RLS remains
deny-by-default. No new environment variable or server secret is introduced.

## Validation

Run `pnpm typecheck`, `pnpm test`, `pnpm test:openapi`, `pnpm test:sdk`, and the supplier persistence,
RLS and integration gates. The local persistence gates require Docker Desktop and their isolated,
ownership-checked Supabase runner; never reset or stop the normal development project to run them.
