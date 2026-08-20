# ADR-013: Product, Variant, and Option Model

- Status: Accepted
- Date: 2026-08-19

## Context

Clothing catalog styles have multiple size/color combinations, while inventory and transactions
need a stable stock-keeping identity. Hardcoded Size/Color columns cannot represent material or
future clothing dimensions, but a rules engine would exceed Phase 2A.

## Decision

- Product is the Tenant- and Brand-owned merchandising concept. ProductVariant is the stable
  stock-keeping and potentially sellable identity.
- Future inventory attaches to ProductVariant plus InventoryLocation. Products and variants are
  shared by POS and online consumers.
- ProductOption and ProductOptionValue define simple product-local dimensions and allowed values.
  VariantOptionValue selects at most one value per dimension.
- Composite Tenant/Product keys reject foreign tenant/product selections.
- A deferred database constraint validates a canonical value-UUID signature; Product/signature
  uniqueness rejects duplicate logical combinations.
- `UNIQUE (tenant_id, product_id, option_signature)` is deliberately lifecycle-wide, not partial on
  status. One Product plus one exact option combination is therefore one durable ProductVariant
  identity for its whole lifetime. An archived combination stays reserved: reintroducing it later
  must reactivate the original variant (a future lifecycle-service responsibility that validates
  business conditions), never mint a second variant UUID for the same logical combination. This
  keeps inventory, purchasing, order-line, return, and reporting identity stable.
- Selection integrity and option completeness are distinct. The database guarantees that each
  selected option belongs to the Product, each value belongs to its option, at most one value per
  option is chosen, and the signature matches the selections. It does not require a draft variant to
  select a value for every option; completeness is a future activation/sellability concern.
- Optionless products use one `default` variant. Variant existence is checked by a future activation
  service rather than a circular database constraint.

## Alternatives rejected

- One Product per size/color: conflates merchandising and stock identities.
- Fixed `size` and `color` columns: blocks other dimensions and makes optionless products awkward.
- Fully generic rules/configuration engine: adds unneeded complexity and ambiguous integrity.
- Display-name uniqueness: names are presentation, not a canonical combination.

## Consequences

Writers must change a variant signature and its selections in one transaction. Adding a new option
type needs data, not DDL. Activation, publication, inventory, and HTTP mutation services remain
future work.
