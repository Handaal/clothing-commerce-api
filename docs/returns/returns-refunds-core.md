# Canonical returns and refunds (Phase 2M)

One Return domain serves original POS and ONLINE orders. A create-return command means the operator
has received and accepted the specified merchandise, selected its disposition, and initiated the
corresponding refund. It does not rewrite the original Order, its commercial snapshots, Fulfillment,
or captured Payment. There is no separate channel-specific return table or client-owned calculation.

## Boundary and lifecycle

`app/api/v1/*` validates transport, `src/returns/service.ts` authorizes operations,
`src/returns/repository.ts` requires an issued authorization proof and invokes narrow RPCs, and
`20260919180000_create_returns_refunds.sql` serializes and commits commercial integrity.
Zod contracts in `src/contracts/management/returns.ts` generate OpenAPI and SDK 0.8.0.

The accepted Return and ReturnLines are immutable. They preserve tenant, original order/line, original
channel, operator-reported client source, server-verified actor, quantity, reason, disposition,
server-derived amount/currency and timestamp. The Return links to its canonical stock receipt when
one exists. Its policy snapshot records the settings used at acceptance. Source is audit metadata,
never an authorization credential.

Each accepted Return has exactly one Refund referencing that Return and its original Payment, with
composite tenant/order foreign keys. `pending` means settlement is still owed; `succeeded` means
settlement has been recorded. `failed` is reserved for verified future provider outcomes and still
reserves the amount. There is no hard delete or withdrawal API that could free quantities for replay.

## Eligibility and immutable economics

The original order must exist in the tenant, remain placed, and have a captured payment. Only
physically fulfilled units can be returned. A line must belong to that exact order; quantities must
be positive safe integers and duplicate lines are rejected. Per-line eligibility is:

`min(purchased quantity, fulfilled quantity) - cumulative accepted return quantity`

Every refund amount is the sum of original `unit_price_minor * returned quantity`, using the immutable
OrderLine snapshot. Current catalog prices, client prices, submitted totals, actor IDs and payment
IDs cannot override it. This matches the current no-discount/no-tax allocation contract; a future
discount or tax engine must extend the original pricing allocation before extending this formula.

The payment ceiling is `min(original captured payment amount, original order total) - all committed
refund amounts`. Pending and failed refunds count too: they cannot release money for another refund
while returned merchandise is already recorded. Quantity and monetary ceilings are checked separately
inside the same serialized transaction. No rounding, percentage refund or price override is invented.

Unfulfilled ONLINE orders and unpaid/pending COD cannot produce refunds. Use the existing cancellation
domain where eligible. Captured, fulfilled COD works identically to captured POS cash. This phase does
not introduce a COD collection endpoint or invent collection from fulfillment. Accepting unpaid
merchandise without a monetary refund and netting a still-payable COD obligation remain a separate
business decision, not an implicit side effect here.

## Configurable policy

`return_settings` is tenant-owned, deployment-managed and denies client/service direct writes. No row,
or `enabled=false`, disables new returns. Migrations enable no tenant. Integrity checks above always
apply and cannot be disabled by policy.

| Setting                   | Meaning                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `enabled`                 | Explicit tenant opt-in; default false.                                   |
| `window_days`             | Optional age limit from placement; null adds no policy limit.            |
| `allowed_reasons`         | Optional exact allowed reason strings; null permits any nonblank reason. |
| `manual_refunds_enabled`  | Explicit permission to record manual cash/COD settlement; default false. |
| `max_manual_refund_minor` | Optional per-refund manual settlement ceiling; null adds no limit.       |

The disposable test fixture opts into a 30-day window and manual settlement solely to exercise the
technical behavior. It is not a recommended production policy. Final return windows, reasons,
condition/inspection rules, cross-branch receiving, approval thresholds and dual approval, evidence
retention, exchanges, fees, and unpaid COD handling require business decisions. An amount above the
manual threshold can remain pending; it is not silently approved or settled. Settings do not add an
approval workflow or a public policy-administration endpoint.

## Inventory disposition

Every line explicitly chooses `restock` or `non_restock`. The latter includes damaged or written-off
merchandise: the required reason records the explanation and sellable inventory does not increase.
This phase does not create an unsellable warehouse inventory subledger.

At least one restock line requires a same-tenant active sellable inventory location and separate
`inventory.receive` permission for it. When all lines are non-restock, a stock location is forbidden.
All restock quantities enter one canonical `inventory_private.record_operation(..., 'receipt', ...)`
operation. The return writer has no direct inventory-balance mutation privilege. The original
fulfillment location and POS branch are not assumed to be the return destination.

## Atomicity, idempotency and settlement

The return command requires a stable `Idempotency-Key`. A tenant/key advisory lock precedes the shared
original-order execution lock. All accepted quantities and monetary ceilings are read under that
order lock. Location lifecycle and inventory balance locks follow the existing order; stock balance
keys use the ledger's canonical ordering. Return, lines, receipt and refund are one database
transaction. An error at the final refund insert rolls back the receipt and all other artifacts.

The full normalized command (ordered lines/reasons/dispositions, location, refund mode and settlement
reference) is persisted as intent. Exact replay returns the same Return, receipt and Refund IDs;
changed intent returns `409 IDEMPOTENCY_CONFLICT`. Authorization is rechecked on every replay.
Policy and current catalog changes do not invalidate an already accepted exact replay. The response
is current refund state, so a later settled refund may appear settled on create replay.

Default `refundMode: pending` commits an unpaid refund obligation. For cash or captured COD,
`manual_confirmed` explicitly attests that an authorized operator actually handed back the cash and
requires a nonblank settlement reference. It records the completed refund in the same transaction;
the server cannot itself move physical cash. Never send this mode before performing that real action.

A previously pending cash/COD refund can be settled through the dedicated command. It requires its
own stable key and settlement reference. Exact key/reference replay succeeds; changed evidence
conflicts; a second different key cannot settle an already completed refund. The original payment
stays captured: refund totals/state are separate durable financial facts.

Electronic returns can create only a pending Refund. No route can mark an electronic refund paid.
`PaymentProvider.refund` is the future server-only adapter seam. The pending Refund is the durable
intent and reserves its ceiling: commit it first, then call the provider outside the transaction with
the Refund ID as the stable provider idempotency key. A later integration must add worker claiming,
attempt/event records, signature-verified amount/currency-matched reconciliation, recovery from
timeouts and deduplicated webhook settlement. Do not hold database locks across network calls or
treat a provider's accepted request as settlement. No production provider, worker or fake gateway
success is implemented in this phase.

## HTTP, SDK and authorization

All routes require Clerk authentication and `X-Tenant-Id`. Writes require `Idempotency-Key`.

| Route                                             | SDK operation          | Permission                                                                 |
| ------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `GET /api/v1/orders/{orderId}/return-eligibility` | `getReturnEligibility` | `returns.read`                                                             |
| `GET /api/v1/orders/{orderId}/returns`            | `listReturns`          | `returns.read`                                                             |
| `POST /api/v1/orders/{orderId}/returns`           | `createReturn`         | `returns.create` + `payments.refund`, plus `inventory.receive` for restock |
| `GET /api/v1/returns/{returnId}`                  | `getReturn`            | `returns.read`                                                             |
| `POST /api/v1/returns/{returnId}/refund`          | `settleRefund`         | `payments.refund`                                                          |

Permissions use the immutable original POS branch or ONLINE brand resource, never role names or the
client source header. Receiving authorization is separately checked against the requested location.
Return-detail routing is tenant-filtered before authorization. No public shopper return API is added.

Order detail optionally includes `returns.lines[].returnedQuantity`, `pendingRefundMinor` and
`refundedMinor` only when the caller also has return-read scope. Dedicated history includes per-return
refund state, reason and disposition. History uses ascending stable UUID cursor order, defaults to 25
items and caps at 100. It is not a report or a globally complete first page.

Expected errors include `RETURN_NOT_FOUND` (404), `INVALID_RETURN` (400),
`RETURN_QUANTITY_EXCEEDED`, `REFUND_CONFLICT`, `IDEMPOTENCY_CONFLICT` (409), and explicit policy,
payment, line-containment and location errors (422). Existing permission/scope errors remain 403.
Raw SQL messages, credentials and customer data never appear in errors.

## Development and verification

No new secret environment variables are required. Migration deployment must include exposure of
`returns_private` to the server's PostgREST, matching `supabase/config.toml`; exposure is not a grant.
The non-login `returns_writer` owns the new tables and hardened functions. RLS denies public roles;
service-role transport can read and invoke sanctioned functions but cannot mutate tables directly.
Never grant this writer role to a client or service role.

```bash
pnpm test:returns:persistence
pnpm test:returns:integration
pnpm test:returns:rls  # RLS-only variant of the isolated runner
pnpm test:openapi
pnpm test:sdk
pnpm build
```

The integration runner copies the current API/migrations into a temporary workspace, creates a unique
Supabase project with a fresh UUID and free API/DB/Next.js ports. It passes a locally signed
test session through the real Clerk verifier. It owns only those temporary processes/containers and
removes them after proving run ownership. Cleanup cannot select the regular development project;
see the [safety closeout](../development/phase-2m-test-isolation.md) for guards and regression proof.
Persistence uses a separate disposable PostgreSQL 17 container. No cloud identity is required.

When changing this domain, preserve original-order locking and add real database tests for ceilings,
replay and rollback; mock tests cannot establish these invariants. Append future migrations rather
than editing deployed history. Unknown 500 errors require server-side investigation; do not expose DB
diagnostics. A policy rejection is not a transport retry, and an ambiguous timeout must reuse the same
key. See [validation](../development/phase-2m-validation.md) for executed tests and operational notes.
