# Promotions Core (Phase 2P-A)

Tenant-owned promotions with immutable, server-authoritative sale-time discount adjustments. Phase 2P-A
delivers the validated **money core** (schema, the shared evaluation engine, allocation, redemption, and
the Returns net-refund basis) **and** the client-facing API surface (Storefront/POS quote, checkout/POS
promotion intent, Admin management endpoints, SDK `0.12.0`) — see [API surface](#client-facing-api-surface)
and [SDK](#sdk) below.

See [ADR-037](../decisions/ADR-037-promotion-accounting-and-adjustment-semantics.md) for the accounting
identity and immutability rationale, and [ADR-026](../decisions/ADR-026-immutable-pricing-snapshots-and-totals.md)
for the pre-existing pricing snapshot model this extends.

## Frozen product contract (V1)

- **Stacking:** exactly one promotion per order. Automatic promotions and one entered code are all
  evaluated; the server applies the **greatest eligible saving**. An entered code does not
  automatically beat a better automatic. Deterministic tie-break: greater discount → code over
  automatic → earlier `created_at` → smaller `id`. No stacking.
- **Redemption limits:** unlimited, global cap, or single-use voucher (`max_redemptions = 1`). No
  per-customer limits, first-order-only, or customer-specific vouchers in V1. Identity is never
  inferred from email/phone.
- **Offline POS:** no promotions offline; the offline grant/replay path is unchanged.
- **Benefits:** percentage (basis points) or fixed amount. **Targets:** whole order or selected
  product/variant scope. **Activation:** automatic or code-required. **Optional qualification:**
  minimum basket subtotal, maximum discount cap, start/end window, channel (`pos`/`online`), brand,
  branch, global redemption cap.

## Schema (`supabase/migrations/20260924180000_create_promotions.sql`)

| Table                    | Ownership                         | Mutability                                                                                               |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `promotions`             | `promotions_writer`, tenant-owned | config mutable until a redemption exists; economics freeze thereafter (enforced in the sanctioned path)  |
| `promotion_targets`      | `promotions_writer`               | selected product/variant scope for `variant_scope`                                                       |
| `promotion_codes`        | `promotions_writer`               | reusable code; `max_redemptions = 1` is a voucher; canonical form `upper(btrim(code))` over `[A-Z0-9_-]` |
| `order_adjustments`      | `promotions_writer`               | **immutable** sale-time summary, one per order                                                           |
| `order_line_adjustments` | `promotions_writer`               | **immutable** per-line allocation; Returns read these                                                    |
| `promotion_redemptions`  | `promotions_writer`               | **immutable** consumption fact, one per order                                                            |

`orders` gains `gross_subtotal_minor` and `discount_total_minor`; `total_minor` becomes the payable net
(`gross − discount`). Existing orders backfill `gross = total`, `discount = 0` (see ADR-037). RLS is
deny-by-default; `service_role` gets SELECT + the non-consuming `evaluate` RPC only.

Persisted lifecycle is only `active`/`inactive`. **Scheduled / expired / exhausted are derived** from
window and redemption counts, never stored.

## Engine (`supabase/migrations/20260924180100_create_promotion_evaluation.sql`)

- `promotions_private.evaluate(tenant, channel, currency, brand, branch, lines, code) → jsonb` —
  **non-consuming, deterministic.** Scores every eligible automatic promotion plus the entered code's
  promotion, selects the greatest eligible saving with the frozen tie-break, and returns the winner
  snapshot, gross/basis/discount, and per-line allocation. Used by **both** the quote preview and
  placement. `service_role` may call it (previews); it never mutates.
- `promotions_private.allocate(...)` — largest-remainder integer allocation; `Σ = discount`.
- `orders_private.apply_order_discount(tenant, order, discount)` — the sole sanctioned net-total writer
  (owned by `orders_writer`).
- `promotions_private.redeem(tenant, order, code) → jsonb` — the **consuming** placement step. Re-derives
  everything from the immutable committed `order_lines` + live config under promotion/code row locks,
  re-checks capacity, increments counts, writes the immutable `order_adjustments` /
  `order_line_adjustments` / `promotion_redemptions`, and applies the net total. Server-authoritative:
  any client figure is ignored. Grants exist for `online_writer` and `pos_sales_writer` so the two
  channels reuse the **same** engine.

### Concurrency / idempotency

`redeem` runs inside the successful, idempotent sale transaction and is never called on replay (the
channel's own idempotency — `checkout_operations` / `pos_sales` — short-circuits first). Capacity races
serialize on the promotion/code row locks: the final voucher has exactly one winner; a concurrent
redemption that just exhausted a promotion surfaces `PR409` so the client re-quotes. Any failure in the
placement transaction rolls back the redemption — no orphan.

## Returns net basis (`supabase/migrations/20260924180200_returns_net_refund_basis.sql`)

`returns_private.accept_return` now refunds the **net** per-unit amount
(`line_total_minor − allocated_discount`) using the same largest-remainder unit ordering (see ADR-037).
Undiscounted orders are byte-identical to prior behavior. The order ceiling
(`least(payment.amount, total_minor)`) is automatically correct because `total_minor` is net. No other
Returns behavior changed.

## Validation

`pnpm test:promotions:persistence` (`scripts/test-promotions-persistence.mjs`,
`supabase/tests/phase_2p_promotions_persistence.sql`) applies every migration **twice** from an empty
schema and runs 39 money invariants: percentage floor, fixed clamp, max cap, minimum basket,
channel/brand/window gates, variant scope, largest-remainder allocation, best-eligible-saving selection,
both tie-breaks, redemption accounting identity, adjustment immutability, global/voucher exhaustion, the
net refundable basis, and tenant isolation. The new `promotions_private` schema is registered in all
seven two-cycle persistence reset lists; `phase_2a_catalog_persistence.sql` now asserts the promotions
table exists.

## Client-facing API surface

All endpoints reuse the same DB engine; money is server-authoritative.

| Endpoint                                        | Auth                          | Purpose                                                                                                                             |
| ----------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/storefront/quote`                 | public                        | Non-consuming Storefront pricing quote (`quote_checkout`).                                                                          |
| `POST /api/v1/storefront/checkout`              | public + Idempotency-Key      | Checkout now accepts optional `promotionCode`; redeems in the placement transaction; validates the client's expected **net** total. |
| `POST /api/v1/pos/quote`                        | tenant                        | Non-consuming connected-POS pricing quote.                                                                                          |
| `POST /api/v1/pos/sales`                        | tenant + Idempotency-Key      | Sale now accepts optional `promotionCode`; redeems transactionally; the server re-derives the net total. Offline POS unchanged.     |
| `GET/POST /api/v1/promotions`                   | `promotions.read` / `.manage` | List / create promotions (idempotent create).                                                                                       |
| `GET/PATCH /api/v1/promotions/{id}`             | `promotions.read` / `.manage` | Detail / edit (economics frozen after first redemption → 409).                                                                      |
| `POST /api/v1/promotions/{id}/status`           | `promotions.manage`           | Activate / deactivate.                                                                                                              |
| `POST /api/v1/promotions/{id}/codes`            | `promotions.manage`           | Create a code / voucher.                                                                                                            |
| `POST /api/v1/promotions/codes/{codeId}/status` | `promotions.manage`           | Enable / disable a code.                                                                                                            |

Shared `PricingBreakdown` (`currency`, `grossSubtotalMinor`, `discountTotalMinor`, `totalMinor`,
`codeStatus`, `promotion`) is returned by both quote endpoints. Checkout/quote surface a small, actionable
outcome set: `PRICE_CHANGED` (re-quote), `PROMOTION_UNAVAILABLE` (invalid/exhausted code — re-quote),
`CURRENCY_CHANGED`, `INSUFFICIENT_STOCK`, `IDEMPOTENCY_CONFLICT`. Exact idempotent checkout/POS replay
returns the original placement **without** a second redemption.

**Compatibility:** the checkout result gains additive `grossSubtotalMinor` / `discountTotalMinor` /
`promotion` fields (non-strict consumers ignore them); the existing POS sale and Returns response shapes
are unchanged (new pricing detail is a separate `PricingBreakdown` projection, not an expansion of a
strict object). Offline grant/bootstrap/outbox schemas are untouched, so queued offline sales still
ingest.

## SDK

`@shifted/clothing-commerce-sdk@0.12.0` (additive MINOR). New public method `quote`; new tenant methods
`posQuote`, `listPromotions`, `getPromotion`, `createPromotion`, `updatePromotion`,
`setPromotionStatus`, `createPromotionCode`, `setPromotionCodeStatus`; new types `PricingBreakdown`,
`AppliedPromotion`, `PromotionDetail`, `PromotionSummary`, `PromotionListResponse`, quote request/response
types. Verified by the deterministic pack + isolated ESM/CJS + strict (`skipLibCheck:false`) consumer
gates (`pnpm test:sdk`).
