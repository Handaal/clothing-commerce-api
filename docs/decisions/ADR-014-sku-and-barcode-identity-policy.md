# ADR-014: SKU and Barcode Identity Policy

- Status: Accepted
- Date: 2026-08-19

## Context

Variants need business identifiers for staff workflows and scanning. Reuse or ambiguous barcode
resolution would corrupt future inventory and sales references. One barcode per variant is too
restrictive for manufacturer, internal, and replacement identifiers.

## Decision

- UUID is internal identity; SKU is a required Variant attribute, never a primary key.
- SKU comparison lowercases and trims outer whitespace. It is Tenant-wide unique over every
  lifecycle state and is not reused after archive.
- Product may carry an optional, distinct tenant-unique `style_code` for clothing businesses.
- Barcode is a separate one-to-many Variant entity. Its normalized value is Tenant-wide unique over
  active and retired rows. At most one active barcode per Variant is primary.
- Future application rules may edit SKU only before commercial history or through an explicitly
  controlled workflow.

## Alternatives rejected

- Global uniqueness: unnecessarily couples independent Tenants.
- Product-level SKU/barcode: the concrete Variant is stocked and sold.
- Reusing archived/retired values: can reinterpret historical documents and old physical labels.
- Exactly one barcode column: cannot represent alternate or replacement identifiers.

## Consequences

The database prevents tenant-local ambiguity and retains identity history. Future transport
validation still owns barcode format/checksum validation and controlled identifier mutation.
