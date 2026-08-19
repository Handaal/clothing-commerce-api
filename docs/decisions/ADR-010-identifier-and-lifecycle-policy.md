# ADR-010: Identifier and Lifecycle Policy

- Status: Proposed
- Date: 2026-08-19

## Context

The platform needs stable public references, future distributed/offline creation, operator-friendly
codes, and preservation of financial and inventory history. Sequential IDs and reusable codes make
enumeration and historical interpretation risky; routine hard deletes destroy audit context.

## Decision

- **RECOMMENDED:** Use UUIDv7 for internal primary identity, generated at the authoritative creation
  boundary and validated when supplied by an approved future offline workflow.
- **CONFIRMED:** Human slugs/codes are separate from internal identity and follow explicit global,
  tenant, or parent uniqueness boundaries.
- **RECOMMENDED:** Reserve business codes and Tenant slugs across all lifecycle states; do not reuse
  them after archive. Slug mutation is controlled/audited and never changes tenant identity.
- **RECOMMENDED:** Use explicit domain status plus archive/revoke metadata. Hard deletion is not a
  normal operation after dependent or audit history exists.
- **CONFIRMED:** Once financial or inventory history exists, lifecycle changes must preserve
  references and auditability.
- **RECOMMENDED:** Future offline commands use distinct idempotency/command IDs in addition to record
  identity.

## Alternatives rejected

- Sequential bigint as platform identity: centralized allocation, enumeration, and poor offline
  creation fit outweigh compactness.
- UUIDv4 as default: distributed but loses UUIDv7 index locality and time ordering.
- Business code as primary key: codes are scoped, formatted, and potentially renamed.
- Universal soft-delete flag: does not express suspended, inactive, archived, revoked, or invited
  domain behavior.
- Reusing archived codes: makes historical documents and external references ambiguous.

## Consequences

UUID generation libraries/database capability must be selected and compatibility-tested in Phase
1C. UUID timestamp bits are not an audit clock or authorization input. Archive workflows must
validate dependencies rather than cascade-delete. Exceptional legal/privacy erasure requires a
separate governed process.
