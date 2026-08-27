# ADR-026: Immutable Pricing Snapshots and Totals

- Status: Accepted
- Date: 2026-08-25

## Context

`variant_prices` is current merchandising data. A historical order must not recompute its value from a
price that can change or disappear after the sale, and callers must never supply authoritative prices.
Promotions and tax engines do not yet exist.

## Decision

- The application resolves the **single active `variant_prices` row** for `(tenant, variant, order
currency)` at NEW-command time and persists `unit_price_minor` as the immutable, server-authorized
  charged unit price. Missing price → `PRICE_NOT_FOUND`. No caller-supplied price; no FX.
- Lines also snapshot `product_name`, `variant_name`, `sku`, and a deterministic `option_summary`
  (`"Size: M / Color: Black"`), so historical display survives catalog edits/archival. All catalog FKs
  are `ON DELETE RESTRICT`. No arbitrary catalog JSON is stored.
- **Totals are stored, computed atomically in `create_order`:** `line_total_minor = quantity *
unit_price_minor` and `orders.total_minor = Σ line_total_minor`. A single `total_minor` (not a
  subtotal/grand-total split) is stored while they would be identical; discount/tax components are
  added by their future domains, which will define the accounting identity then.
- Money is `bigint` minor units end to end; the application uses BigInt for `quantity * unit_price` and
  range-checks to a JS safe integer before persisting; `create_order` uses `numeric` and rejects
  out-of-range values (`22003` → `AMOUNT_OUT_OF_RANGE`). Currency is on the order only (single-currency
  invariant), not repeated per line.

## Alternatives rejected

- **Recompute from current catalog on read:** breaks historical correctness.
- **Trust client prices:** a security and integrity hole; deferred manual-override is a future,
  separately-authorized extension.
- **Store subtotal + grand_total now:** speculative duplication while identical; a single `total_minor`
  is the smallest coherent model.
- **discount/tax/service columns now:** no producer exists; adding fake fields invites drift. Re-adding
  later is additive.
