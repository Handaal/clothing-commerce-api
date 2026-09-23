# ADR-037: Promotion Accounting and Immutable Adjustment Semantics

- Status: Accepted
- Date: 2026-09-24
- Supersedes the deferral in [ADR-026](ADR-026-immutable-pricing-snapshots-and-totals.md)
  ("discount/tax components are added by their future domains, which will define the accounting
  identity then").

## Context

Phase 2P introduces vouchers/discounts/promotions. The order model has a hard invariant:
`order_lines.line_total_minor = quantity * unit_price_minor` (CHECK
`order_lines_line_total_identity`), and the offline POS grant authorizes each variant's list
`unit_price_minor`. A discount therefore **cannot** be folded into `unit_price_minor` without breaking
the line identity and offline price authorization. Returns (Phase 2M) derive the refundable basis from
`order_lines.unit_price_minor` and cap at `least(payment.amount, orders.total_minor)`, so an
order-level discount that is not allocated to lines would make partial returns over- or under-refund.

## Decision

### Order accounting identity (now defined)

Three quantities on `orders`, all `bigint` minor units in `orders.currency`:

- `gross_subtotal_minor = Σ order_lines.line_total_minor` (pre-discount; `unit_price_minor` unchanged).
- `discount_total_minor ≥ 0` — the single applied promotion's discount.
- `total_minor = gross_subtotal_minor − discount_total_minor` — the **payable net**; `payment.amount`
  equals this.

Enforced by CHECKs: `discount_total_minor ≥ 0`, `discount_total_minor ≤ gross_subtotal_minor`,
`total_minor = gross_subtotal_minor − discount_total_minor`. `create_order` records
`gross_subtotal_minor = total_minor` with `discount_total_minor = 0`; only the sanctioned
`orders_private.apply_order_discount` (owned by `orders_writer`) moves discount above zero.

**Backward compatibility:** existing orders backfill `gross_subtotal_minor = total_minor`,
`discount_total_minor = 0`. `total_minor` is unchanged for them, so `payment.amount = total_minor` and
every Returns ceiling continue to hold. No fake historical adjustment rows are created.

### Immutable adjustment snapshots

- `order_adjustments` — one immutable row per discounted order: promotion + optional code reference,
  **name/benefit/target/code snapshots**, gross subtotal, eligible basis, and discount total. Enough
  self-contained evidence to explain the order after the live Promotion is edited, deactivated, or its
  code deleted. Never reconstructed from live config.
- `order_line_adjustments` — immutable per-line discount allocation. **Returns read these**, never the
  live Promotion.
- `promotion_redemptions` — immutable successful-consumption fact, one per order. V1 never reverses it.

All three are append-only (trigger `promotions_private.forbid_history_mutation`).

### Discount allocation

Order-level discounts are allocated across the eligible gross lines with **deterministic
largest-remainder integer arithmetic** (base = `floor(discount * line_total / basis)`; the leftover
minor units go to the largest remainders, ties broken by ascending line order). Invariant:
`Σ order_line_adjustments.discount_minor = order_adjustments.discount_total_minor`. Fixed discounts are
clamped to the eligible basis and the whole gross subtotal, so the net order can never go negative.

### Returns net basis (the "2P cannot break 2M" fix)

The only authoritative Returns change: the refundable basis per line becomes
`net_line_minor = line_total_minor − allocated_discount_minor`, spread over units by the same
largest-remainder rule used at sale time:

```
base_net_unit = floor(net_line_minor / quantity)
remainder     = net_line_minor % quantity
refund(units already..already+n) = base_net_unit*n + (least(already+n, remainder) − least(already, remainder))
```

For undiscounted orders `allocated = 0`, so `net = gross`, `remainder = 0`, and the refund is
`unit_price_minor * n` — **byte-identical to prior behavior**. Refund never reads the mutable live
Promotion.

## Alternatives rejected

- **Discount inside `unit_price_minor`:** breaks the line identity CHECK and offline grant price
  authorization.
- **Redefine `total_minor` as gross and add a separate net column:** would break the existing
  `payment.amount = orders.total_minor` identity that Returns depends on for all historical orders.
- **Recompute discounts from the live Promotion at return time:** breaks historical correctness the
  moment a promotion is edited/deactivated.
- **Floating point allocation:** loses cents; integer largest-remainder is exact and deterministic.
