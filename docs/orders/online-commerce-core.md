# Online commerce core (Phase 2L)

`POST /api/v1/storefront/checkout` turns guest purchase intent into one canonical `online` Order,
Customer, saved address, stock reservation per line, and pending Payment. It uses the shared catalog,
inventory ledger, order and fulfillment domains. The SDK operation is `client.checkout(...)` in
`@shifted/clothing-commerce-sdk@0.7.0`. Existing lowercase channel values remain compatible with V1.

## Request and result

Send the configured public `tenantId` and `brandId`, `lines` of `variantId`/positive integer `quantity`,
`customer` (name, international phone, nullable email), `delivery` (recipient name/phone, line1,
nullable line2, city, nullable region/postalCode, ISO countryCode, nullable notes), `paymentMethod`,
`expectedTotalMinor` and `expectedCurrency`. One stable `Idempotency-Key` header is required. Use a
random UUID per checkout attempt and preserve it with the unchanged intent until an outcome is known.
The SDK takes that header as an explicit `idempotencyKey` input. Unknown request fields are rejected.
The client cannot select a stock location, price, customer ID, settled amount or trusted quantity.

Zod schemas in `src/contracts/storefront/checkout.ts` generate OpenAPI. The thin route validates inputs
and outputs and calls `src/checkout/checkout-service.ts`; the repository invokes the atomic PostgreSQL
application boundary. Database exceptions map to safe typed API codes, without leaking SQL or PII.

The response contains an operational `orderReference`, channel, placement status, merchandise total,
currency, payment summary and unfulfilled status. It omits customer IDs, addresses, internal routing
and idempotency state. **It is an immutable placement receipt, not a live status response.** Exact
replay after cancellation still returns that original receipt. There is no public order lookup by
number or UUID. Future status lookup must require an opaque access token or verified customer login.

`POST /api/v1/storefront/quote` uses the same locked routing, catalog, currency, and Promotion
evaluation path as checkout but is commercially non-consuming: it creates no Customer, Order,
reservation, Payment, adjustment, or redemption. Repeating a quote is safe. Its PostgreSQL function is
classified `VOLATILE` because the shared validation helpers legitimately use `SELECT ... FOR SHARE`;
this selects a read-write transaction mode through PostgREST and does not imply business-state
mutation. Do not remove those locks or change it back to `STABLE`.

## Customer identity and snapshots

Customers are tenant-owned commerce entities, separate from UserIdentity and Membership. Names and
display contact values are preserved; lowercase trimmed email and punctuation-stripped international
phone support tenant-scoped lookup indexes. No country or mailbox-provider heuristics are used.

An unverified guest checkout **never reuses another checkout's Customer merely because email, phone,
name or address matches**. Only exact checkout idempotency replay reuses a guest Customer. This avoids
unverified impersonation/merging and accepts duplicate guest profiles. A nullable `user_identity_id`
and tenant/identity unique index reserve a future verified account-linking path; no public request can
set it. Customer administration, verified linking, order-history access and POS customer attachment
remain future work. There is no public customer search endpoint.

`customer_addresses` holds mutable saved addresses. The Order independently stores immutable
`customer_snapshot` and `delivery_snapshot` JSON with the validated contact, recipient, address and
notes as purchased. Product, variant, SKU, option and price snapshots remain canonical OrderLines.
Subsequent profile, address and catalog changes do not rewrite history.

## Pricing and routing

The server resolves an API-managed `storefront_checkout_settings` row for the public tenant/brand
pair, checks active Tenant/Brand and active sellable, fulfillment-enabled InventoryLocation, and locks
the routing and catalog rows. Each variant must belong to that exact tenant/brand, have an active
parent and variant, a published parent, and an active price in the configured currency.

The checked sum of current unit prices times quantities must equal the required expected total.
`409 PRICE_CHANGED` includes the authoritative total in `error.details[0].value` before Customer,
Order, Payment or reservation writes. `CURRENCY_CHANGED` requires reloading the cart. A customer must
review the changed intent; once a key has successfully placed an order it cannot represent new intent.
Totals are safe JavaScript integers in minor units. This phase has no shipping-fee/tax engine,
promotions or discount overrides: the merchandise price is the final configured checkout amount.
Do not invent tax/fiscal breakdowns. Operational references are not fiscal invoices.

Routing is intentionally one location and currency per tenant/brand and is managed through the
authorized Settings API. The underlying shape is:

```sql
insert into public.storefront_checkout_settings
  (tenant_id, brand_id, inventory_location_id, currency, cod_enabled)
values (:tenant, :brand, :location, :currency, false);
```

`cod_enabled` defaults to false. Enable it only after COD is an approved business payment mode; no
migration enables it for a live tenant. The fixture explicitly enables COD in the disposable test
database. Arbitrary client tenant/brand combinations cannot bypass this mapping or composite FKs.
Domain/host resolution remains the existing future Storefront context concern.

The Settings write boundary rejects enabling COD unless this exact runtime topology is operational,
and prevents later Settings mutations from deactivating the Brand/location or removing sellable or
fulfillment capability while the Storefront remains enabled. Disable or reroute the Storefront first.

## Stock commitments and lifecycle

The append-only ledger and `inventory_balances.on_hand_quantity` remain physical stock truth.
`stock_reservations` records tenant, order/line, variant, location, quantity, consumed quantity,
creation/update time, optional expiry and `active | consumed | released | expired` state.

ATS = physical on-hand minus the sum of `(quantity - consumed_quantity)` for **all active holds**.
Checkout locks balance rows in the same variant/location order as the ledger, checks ATS, then writes
holds in the placement transaction. An absent balance means zero available stock. A shared balance
trigger rejects every physical reduction below outstanding commitments, including POS, transfer,
manual issue and count adjustment. Operators must resolve commitments before reducing held stock;
the physical ledger is never silently overwritten to make a reservation fit.

Canonical fulfillment holds the existing order execution lock, locks balances in canonical order,
consumes the relevant hold, then performs the existing inventory issue and Fulfillment writes in its
savepoint. Partial fulfillment increments consumed quantity; the final portion marks it consumed.
Wrong-location, expired or insufficient holds reject fulfillment. Failure rolls consumption and issue
back together. Cancellation uses the existing OrderService/cancel function and order lock, releases
holds and cancels a pending Payment atomically. Existing refusal to cancel any fulfilled order remains.
A captured/authorized gateway payment needing an external void/refund requires future orchestration;
this phase never reports a fake successful refund.

COD holds have no automatic expiry: a placed COD order remains a commitment until operationally
fulfilled or cancelled. The service-only `online_private.expire_reservations(tenant, order)` primitive
supports future timed holds: it locks the order, checks a due active hold, cancels an unfulfilled order
and marks its holds expired atomically. Overdue active holds **still count against ATS until this
transaction commits**. This deliberately avoids selling stock from a still-live order. No expiry
scheduler or public renewal endpoint is introduced. Partially fulfilled orders cannot auto-expire.

The existing public `inStock` projection subtracts active commitments. Once routing is configured it
uses that location; otherwise it preserves the catalog's existing location aggregation. Availability
is advisory and checkout always revalidates it. Exact ATS and physical quantities remain private.

## Payments and atomicity

The canonical Payment table now supports pending, authorized, captured, failed, cancelled and refunded
states, with distinct method/provider/reference fields. Existing POS cash stays captured and immutable.
COD creates **pending**, never captured, payment for the authoritative Order amount. Payment collection
and electronic checkout are not inferred from delivery or a browser redirect.

`src/payments/provider.ts` is the server-only authorization/webhook/void adapter boundary. No gateway is
implemented and no electronic method is accepted by public checkout. The internal transition function
guards pending/authorized transitions and rejects terminal rewrites; refunded is reserved for the
later refund domain. It is not granted to service_role or clients. There is no collection endpoint in
this phase; a later authorized operational command must record real COD collection, not fake capture.

Placement allocates the canonical order before taking balance locks, matching POS
(order-number lock before stock locks) and preventing an online/POS lock inversion.
The entire local placement is a single database RPC/transaction, including customer resolution,
number allocation, snapshots, holds, Payment and idempotency record. Same tenant/key serializes on an
advisory lock. Exact canonical JSON intent comparison covers all customer and delivery fields, ordered
cart lines and expectations. A different intent returns `IDEMPOTENCY_CONFLICT`. Transaction failure
leaves no commercial artifacts or consumed number. There is no external network call in this boundary.

Before enabling an electronic provider, implement a durable attempt/outbox in a short transaction,
perform provider authorization outside the transaction using a stable attempt key, and reconcile
signature-verified, amount/currency-checked, deduplicated webhook events in subsequent transactions.
Timeouts must remain retryable, not assumed failed or captured. Implement void/expiry reconciliation
before activating a gateway. The interface alone does not claim that saga or webhook ingestion exists.

## Security and management

New customer, address, routing, reservation and checkout tables enable RLS and deny anon/authenticated
table access. The service role can read them, but has no direct mutation privileges. Dedicated
non-login `online_writer` functions own mutations; narrow inventory/order/payment helpers preserve
their existing writer boundaries. Internal helpers have fixed empty search paths, schema-qualified
references and revoked PUBLIC execute. Supabase exposes `online_private` for RPC transport but grants
service_role only placement and expiry execution; schema exposure grants no client authority.

The existing authenticated `GET /api/v1/orders` includes online orders through brand visibility.
Detail authorizes the canonical Order first, then adds optional-compatible `commerce` with customer
link, historical contact/delivery, Payment and reservations. Existing fulfillment progress stays in
the same response. There is no duplicate management read model. Customer PII never appears in the
public placement result or error messages. Production public checkout rate limiting and bot controls
remain required hardening before exposing broadly; there is no new public database capability.

## Development, validation and safe changes

No new secret environment variables are needed. Public checkout requires server-only `SUPABASE_URL`
and `SUPABASE_SERVICE_ROLE_KEY`; management retains existing Clerk configuration. Do not place these
in SDK/client code. Four append-only migrations `20260918180000` through `20260918180300` introduce the
schema, transactional functions, fulfillment integration and ATS projection. Never edit applied
history. Changes to stock writes must continue to share balance locking and the commitment guard.

Run `pnpm test:online:persistence` for a disposable PostgreSQL placement/constraint proof,
`pnpm test:online:rls` for 20 online security assertions plus the existing foundational/catalog/
inventory/order/fulfillment RLS suites, and `pnpm test:online:integration` with Docker available. The runner owns the disposable local Supabase
start/reset/fixtures/stop lifecycle and a real Next.js API on loopback port 3139. It generates a local
RSA key/session for the actual Clerk verifier, requires no cloud identity or credentials, and tests
real HTTP routes, PostgREST, PostgreSQL, role denials, snapshots, prices, rollback, concurrent last-unit
contention and replay, cancellation, expiry, partial/full fulfillment and management visibility.
Do not run it alongside another repository Supabase runner or with manual data you need to preserve.

Run the standard install/format/lint/typecheck/unit/build gates plus persistence, existing RLS/POS and
fulfillment regression suites, OpenAPI and isolated packed SDK consumption. The [validation record](../development/phase-2l-validation.md) records
the deterministic SDK tarball SHA-256 and executed checks. `artifacts/*.log` contains ignored local verification output.
The health handlers accept the required Request argument, matching Next.js generated development
route types as well as production types. If checkout returns unavailable, verify tenant/brand lifecycle and routing/COD enablement. For stock
conflicts inspect active holds plus physical balance. For 500s check server logs and migration grants;
never expose raw database diagnostics publicly. Expired holds remain conservative until expiry commits.

Production deployment uses reviewed migrations and explicit routing provisioning. Test resets and
local signed identities must never target production. Provider selection/capture policy, COD approval,
shipping charges, public order tracking, verified accounts, rate limits and later collection operations
remain explicit business/operational decisions, not hidden defaults.
