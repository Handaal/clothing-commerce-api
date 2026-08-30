# ADR-035: External Serialization and Error Contract

- Status: Accepted
- Date: 2026-08-30

## Context

The management API needs a single, frozen wire contract for numbers, time, pagination, cursors, errors,
and HTTP status so external consumers (starting with admin-mobile) can depend on it across versions
without leaking internal representation or unsafe values.

## Decision

- **Money and quantities are JSON numbers constrained to the safe-integer range.** The database stores
  `bigint`; the application boundary accepts only `Number.isSafeInteger` values. A value outside the safe
  range fails safely (surfaces as a generic internal error) rather than being silently truncated. No
  decimal-string conversion is introduced in Phase 2F.
- **Time is ISO 8601 UTC strings.** External timestamps are normalized to a trailing `Z` while
  preserving full sub-second precision (so the same string is exact both as the display value and as a
  keyset cursor boundary). No `Date` objects appear in external contracts.
- **Common pagination envelope.** Lists return `{ items, pageInfo: { nextCursor, hasMore } }`. `limit`
  defaults to 25, bounded to `[1, 100]`; `hasMore` is derived with `LIMIT + 1`.
- **Opaque, unsigned cursors.** A cursor is `base64url(JSON)` of `{ v:1, sort:"<literal>", k:{…} }` with
  per-resource sort literals (`created_at_desc`, `location_variant_asc`, `placed_at_desc`) and keyset
  values. It is validated with Zod; a malformed token, wrong version, wrong sort, or wrong keys is
  `400 INVALID_CURSOR`. Cursors are never signed or encrypted and carry NO authorization — every query
  re-applies tenant + visibility, so a cursor can never widen scope or cross a tenant.
- **Frozen error envelope.** Every non-2xx response is
  `{ error: { code, message, requestId, details? } }`. `details` is validation-only. SQLSTATE,
  PostgreSQL text, stack traces, constraint names, and `service_role` details never appear; stable
  Order/Fulfillment codes pass through only where intentionally mapped.
- **HTTP status contract.** 400 request/validation/cursor/limit/UUID; 401 unauthenticated; 403
  permission/scope/membership/tenant-status denial; 404 not found / safely invisible / tenant-contained
  filter miss; 409 state/idempotency conflict; 422 well-shaped domain-semantic rejection where the
  domain already uses 422; 500 safe unexpected internal error. The OpenAPI document does not contradict
  this.
- **Server-generated request id.** A fresh UUID is generated server-side for every management request,
  returned as `X-Request-Id`, and echoed in `error.requestId`. Inbound `X-Request-Id` is never trusted.

## Consequences

- Consumers get precise, safe, versionable types and a single error shape to program against.
- Numeric and temporal edge cases fail closed instead of corrupting data.
- Pagination is stable and tamper-evident without ever becoming an authorization channel.
