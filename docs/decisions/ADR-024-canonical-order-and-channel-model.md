# ADR-024: Canonical Order and Channel Model

- Status: Accepted
- Date: 2026-08-25

## Context

POS and ONLINE both produce sales. The platform's foundational rule is one commerce core with one
order domain (AGENTS.md #9). A naive design would fork POS and ONLINE into separate order tables, or add
a second `Sale` entity distinct from `Order`.

## Decision

- The **Order aggregate (`orders` + `order_lines`) is the sales record.** There is no separate `Sale`
  table; `channel` + lifecycle describe the single canonical model.
- `channel ∈ {pos, online}` records only where the order was initiated. A stable CHECK, extendable
  additively for future channels; `admin`/`marketplace`/`wholesale` are not implemented.
- An Order belongs to exactly **one Tenant, one Brand, one currency**, and has one or more lines.
- Single-brand is enforced **declaratively** (no trigger): lines carry `brand_id` + `product_id` and a
  composite FK chain ties each line's variant to the order's brand (requires additive
  `products(tenant_id,brand_id,id)` unique).
- POS orders carry `branch_id` (server-resolved from the register) and `register_id`; ONLINE orders
  carry neither. `branch_id` is the commercial/operational origin, **not** a fulfillment location —
  there is no `inventory_location_id` on the order. A CHECK and a `(tenant_id,branch_id,register_id)`
  composite FK enforce this.

## Alternatives rejected

- **Separate POSOrder/OnlineOrder tables:** forks the canonical domain and duplicates every downstream
  integration.
- **A separate `Sale` entity:** an Order already models the commercial transaction; a second table adds
  ambiguity with no benefit.
- **Cross-brand orders:** rejected for coherent receipts, branding, accounting, and returns; would
  require a later multi-brand-basket design with explicit tax/accounting cost.
- **`inventory_location_id` on the order:** over-constrains ONLINE (later split/multi-location
  fulfillment) and conflates commercial origin with physical fulfillment.
