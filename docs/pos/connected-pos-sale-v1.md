# Connected POS Sale V1

Connected POS Sale V1 exposes two authenticated, tenant-scoped operations:

- `GET /api/v1/pos/context` lists only active registers for which the caller has every selling
  capability.
- `POST /api/v1/pos/sales` creates one canonical POS Order, one captured cash Payment, one full
  Fulfillment, and the resulting inventory issue as one database transaction.

## Trusted selling context

The checkout request supplies `registerId`, `expectedTotalMinor`, `cashReceivedMinor`, and ordered
`variantId`/`quantity` lines. The server resolves Register → Branch → default InventoryLocation and
the Register's normalized three-character `selling_currency`. The client cannot submit branch,
fulfillment location, currency, unit price, or a separate settled amount.

An active register is usable only when its branch and default location are active, the location is
fulfillment-enabled, and authorization succeeds for `orders.create`, `orders.fulfill`, `orders.read`,
and `payments.capture` on the branch plus `inventory.issue` on the location. There is no role-name or
device bypass. Device enrollment, device credentials, revocation runtime, offline trust, sync,
outbox, and offline storage are deferred to the later POS Offline / Sync phase.

## Pricing, cash, and tax boundary

The service resolves each current active catalog price in the Register currency. The active catalog
price is the final gross merchandise amount charged; the order total is the checked sum of immutable
server-resolved line totals. If it differs from `expectedTotalMinor`, the API returns
`409 PRICE_CHANGED` with `details[0].value` containing the new authoritative total. This happens
before any Order, Payment, Fulfillment, or inventory mutation.

V1 supports exactly `method=cash` and `status=captured`. The Payment references the canonical Order,
uses its currency and total as `amountMinor`, records the capturing Membership, and computes
`changeMinor = cashReceivedMinor - amountMinor`. Cash below the total is rejected before mutation.
Card processors, split tender, wallets, gift cards, refunds, voids, returns, promotions, and loyalty
are not implemented.

No tax engine or tax breakdown exists in this phase, and receipts must not invent a tax line or make
a tax-inclusive, tax-exclusive, VAT, or jurisdiction claim. Production fiscal/tax compliance is out
of Phase 2H scope and must be completed before any production deployment where required. Operational
order numbers are not fiscal invoice numbers.

## Atomicity and idempotency

`pos_sales_private.record_sale` is the sole mutation boundary. It rechecks trusted register/catalog
state, calls the sanctioned Order creation, cash capture, and Fulfillment/inventory functions in the
same PostgreSQL transaction, then writes the immutable composition record. An error rolls everything
back, including the order-number increment and inventory movement.

One required `Idempotency-Key` fingerprints the full logical request: register, expected total,
received cash, and ordered variant/quantity lines. Same key and intent returns the same Order,
Payment, and Fulfillment without another issue. A changed intent returns
`409 IDEMPOTENCY_CONFLICT`. Compact child identifiers are internal implementation details and are
never client-visible idempotency boundaries.

All five permissions are authorized before the mutation starts, including `orders.read`; the response
therefore does not cross a new post-commit authorization boundary after inventory depletion.

## Files, testing, and safe changes

Transport schemas live in `src/contracts/pos.ts`, application rules in `src/pos`, thin routes under
`app/api/v1/pos`, and append-only schema/functions in the `2026090418*.sql` migrations. Keep client
input narrow and add future payment methods by extending the Payment entity and sanctioned payment
functions, not by replacing Payment or adding tender SQL to routes.

Run `pnpm test:pos:sale:integration` for the reset-database HTTP acceptance suite. It covers success,
replay/conflict, rollback, stale prices, cash arithmetic, authorization scopes, context, CORS, and
management read visibility. `COMMERCE_CORS_ALLOWED_ORIGINS` is a comma-separated exact origin
allowlist; omitted or disallowed origins receive no `Access-Control-Allow-Origin`. Never configure `*`.

For local runtime, run the existing real-Clerk identity provisioner and commerce fixture. They create
the separate exact `Dev POS Cashier` role/assignment, active register, USD price, and starting stock;
both tools remain local-only, explicitly opted in, deterministic, idempotent, and safe to rerun.

SDK `0.4.0` adds typed `getPosContext()` and `createPosSale()` methods on a tenant-bound client. The
SDK continues to own `X-Tenant-Id`, calls the supplied `getToken`, and takes the sale idempotency key
as an explicit method input.
