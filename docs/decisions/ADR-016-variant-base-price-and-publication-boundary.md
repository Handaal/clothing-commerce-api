# ADR-016: Variant Base Price and Publication Boundary

- Status: Accepted
- Date: 2026-08-19

## Context

Variants can legitimately differ in price, persisted money must not use floating point, and future
multi-currency data must remain self-describing. A full price/publication engine would prematurely
couple channels, promotions, taxes, and scheduling.

## Decision

- Base price belongs to ProductVariant and stores explicit currency plus nonnegative `bigint`
  minor units. `bigint` is the authoritative persistence representation; integer minor units avoid
  floating-point monetary storage, and currencies are not assumed to all have two decimal places.
- At most one active base price exists per Tenant, Variant, and currency. Zero active prices is a
  valid state (draft, incomplete, or temporarily unpriced variants); price presence may become a
  future activation/sellability requirement rather than a database `NOT NULL`-style guarantee. Price
  replacement archives the prior row so history remains.
- Product/Variant `active` means internally eligible, not published or sellable. Storefront and POS
  consume one catalog; future publication controls are separate.
- Price lists, compare-at price, effective scheduling, tax, FX, branch/channel overrides, and
  promotions are deferred.
- Media persistence is also deferred. A future ordered metadata model may attach to Product and
  optionally Variant without embedding storage/upload behavior in catalog rows.

## Alternatives rejected

- Product-level price: cannot support variant price differences.
- Floating-point amount: cannot preserve exact monetary value.
- Implicit Tenant currency: makes historical rows ambiguous if defaults change.
- Full pricing/publication/media subsystems: exceed Phase 2A and encode unreviewed behavior.

## Consequences

Application code must convert monetary input without floating-point authority and validate actual
supported currencies. Because a JavaScript `Number` is only exact to `2^53 - 1`, future
HTTP/OpenAPI/SDK transport must not blindly map arbitrary `int8` monetary values into a JS `Number`;
it must choose an explicit safe representation (for example a decimal string of minor units, or a
deliberately bounded safe-integer contract). No public pricing serialization is implemented in this
phase. Active catalog state alone never authorizes a sale or public display. Later pricing and
publication work can extend from stable Variant and currency keys.
