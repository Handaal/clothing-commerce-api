# ADR-028: Order Idempotency and Replay Authorization

- Status: Accepted
- Date: 2026-08-25

## Context

POS/offline/storefront retries require idempotent order creation. Two subtle hazards must be avoided:
(1) a retry after a catalog price change must **replay** the original order, not conflict or reprice;
(2) an idempotent replay must not depend on mutable current relationships (a reassigned register, an
archived variant) for authorization, yet must not let mere possession of a key bypass authorization.

## Decision

- **Client-intent fingerprint.** `orders_private.order_intent_fingerprint` hashes only tenant, channel,
  currency, register, and the ordered `(variant_id, quantity)` lines. It excludes resolved prices,
  snapshots, notes, actor, and derived brand/branch. One SQL definition is shared by the preflight and
  `create_order`, so they never drift.
- **Replay-safe flow.** createOrder computes the fingerprint and calls the narrow
  `resolve_idempotent_replay_target` preflight **before** any business authorization or catalog/register
  resolution: same key + matching intent → replay the original; same key + different intent →
  `IDEMPOTENCY_CONFLICT`; none → the NEW-command path (which alone resolves current
  price/variant/register state).
- **Persisted-resource replay authorization.** A NEW command authorizes against current resources; a
  replay authorizes against the **immutable persisted** resource of the existing order (POS:
  `order.branch_id`; ONLINE: `order.brand_id`). Register reassignment, catalog mutation, and register
  disabling therefore never block or misroute a replay. Possession of a key never bypasses
  authorization — every replay still authorizes.
- **Authoritative enforcement in the database.** `create_order` re-enforces idempotency (unique
  `(tenant, normalized_key)`, matching-intent replay, `ID409` on conflict, concurrent-first-create
  race via the `BEGIN … EXCEPTION` savepoint). The preflight is an optimization/correctness path, never
  the sole guard.
- **Preflight non-leak.** The preflight returns only routing metadata and only on a fingerprint match;
  a conflict returns identifiers `NULL`; a missing/foreign-tenant key returns no rows (no cross-tenant
  existence disclosure).

## Alternatives rejected

- **Fingerprint over resolved prices/snapshots:** a post-price-change retry would conflict instead of
  replaying.
- **Authorize replay against current re-derived register/catalog:** a reassigned register or archived
  variant would wrongly deny or misroute a legitimate replay.
- **Skip authorization on replay when the key matches:** possession of a key is not authorization.
