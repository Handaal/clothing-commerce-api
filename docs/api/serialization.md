# Management API serialization

## Money and quantities

Monetary amounts (minor units) and quantities are transported as **JSON numbers** constrained to the
JavaScript safe-integer range. The database stores `bigint`; the application boundary accepts only
`Number.isSafeInteger` values. A value outside the safe range **fails safely** (surfaces as a generic
internal error) rather than being silently truncated. No decimal-string conversion is used in Phase 2F.

## Time

External timestamps are **ISO 8601 UTC strings** with a trailing `Z`, preserving full sub-second
precision. The same normalized string is used both as the display value and as a keyset cursor boundary,
so pagination stays exact. No `Date` objects appear in external contracts.

## Identifiers

All resource identifiers are RFC 4122 UUIDs (validated with Zod). Note that non-RFC UUIDs (e.g.
zero-nibble version/variant) are rejected by the contract even though PostgreSQL would store them;
fixtures must use valid v4 UUIDs.

## What is never serialized

Raw DB rows, `version` counters, movement ledgers, `InventoryOperation`/`inventoryOperationId`,
idempotency keys, payload fingerprints, authorization proofs, assignment-graph internals, signed
movement deltas, private routing descriptors, and `service_role` details are never exposed.
