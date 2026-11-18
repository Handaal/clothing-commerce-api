# Website / POS stock channels (ADR-042 §3)

Status: **database layer + admin split API, not activated.** Every location is in `legacy` mode until an
admin initializes it, and the `enforced` mode is locked deployment-wide. No storefront read or POS screen
uses channels yet, so customer-facing stock is unchanged.

## Purpose

The owner splits each item's stock explicitly between the website and the POS. A POS sale (online or
offline) must reduce only the POS share, and a website order only the website share. The design and
decisions are in [ADR-042](../decisions/ADR-042-PROPOSED-channel-stock-pools-and-offline-pos-scope.md);
this page is the operating guide.

## How it works

- Physical truth stays `inventory_balances.on_hand_quantity` (ADR-017). `inventory_channel_balances`
  partitions it into `website`, `pos` and `unallocated` buckets per (tenant, location, variant). The
  buckets always add up to the canonical number at an `enforced` location.
- Every canonical ledger movement at a non-legacy location is attributed to one bucket by a deferred
  trigger on `inventory_movements`:
  - POS order fulfilment → `pos`; website order fulfilment → `website`;
  - accepted return of a POS sale → `pos`; of a website order → `unallocated`;
  - receipts, opening stock and other increases → `unallocated`;
  - other decreases → `unallocated` if it has enough, otherwise refused (enforced) or logged (shadow).
- Website reservations are read live from `stock_reservations`; they are not copied into the bucket table.
- Admin splits set absolute website/POS quantities; `unallocated` is the remainder. A split cannot exceed
  on-hand, cannot push website below open website reservations, and cannot push POS below reserved POS
  stock.

## Files

| File                                                                       | Role                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `supabase/migrations/20261114140000_inventory_channel_stock_pools.sql`     | Tables, triggers, functions, privileges                     |
| `supabase/tests/phase_3a_inventory_channels_persistence.sql`               | Invariant, isolation, shadow/enforced, privilege assertions |
| `scripts/test-inventory-channels-persistence.mjs`                          | Disposable-container runner                                 |
| `src/contracts/management/inventory-channels.ts`                           | Zod transport contracts (OpenAPI + SDK source)              |
| `src/inventory/channel-service.ts`                                         | Authorization + validation (application service)            |
| `src/inventory/supabase-inventory-channel-repository.ts`                   | RPC adapter, SQLSTATE → stable error mapping                |
| `app/api/v1/inventory/channels/**`                                         | Route handlers                                              |
| `tests/inventory/channel-service.test.ts`                                  | Unit tests                                                  |
| `tests/inventory-write-integration/inventory-channels.integration.test.ts` | HTTP boundary against a real isolated database              |

## HTTP API (management)

| Method + path                                         | Permission         | Notes                                                                                  |
| ----------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `GET /api/v1/inventory/channels?inventoryLocationId=` | `inventory.read`   | Mode + buckets per variant; `items` is empty while `legacy`                            |
| `POST /api/v1/inventory/channels/initialize`          | `inventory.adjust` | `{inventoryLocationId}`; repeat returns `initialized: false`; Idempotency-Key required |
| `POST /api/v1/inventory/channels/allocations`         | `inventory.adjust` | `{inventoryLocationId, reason, lines[]}`; Idempotency-Key required; exact replay safe  |

Permissions are checked against the target inventory location (tenant-wide or an explicit scope that
covers it). `inventory.adjust` was chosen because whoever may recount stock at a location may also decide
how it is shared between channels; no new permission had to be provisioned. Errors:

| Code                         | HTTP | Cause                                                               |
| ---------------------------- | ---- | ------------------------------------------------------------------- |
| `CHANNELS_NOT_INITIALIZED`   | 409  | Split on a `legacy` location                                        |
| `CHANNEL_ALLOCATION_INVALID` | 422  | Over on-hand, below open website reservations, or below POS reserve |
| `CONCURRENT_MODIFICATION`    | 409  | `expectedBalanceVersion` no longer matches (stock moved)            |
| `IDEMPOTENCY_CONFLICT`       | 409  | Same Idempotency-Key with a different body                          |
| `VARIANT_NOT_FOUND`          | 404  | Unknown variant in a line                                           |
| `LOCATION_NOT_FOUND`         | 404  | Unknown location                                                    |

SDK: `getInventoryChannels({ inventoryLocationId })`, `initializeInventoryChannels({ inventoryLocationId,
idempotencyKey })`, `allocateInventoryChannels({ inventoryLocationId, reason, lines, idempotencyKey })`.
A typical admin screen reads `listInventory` (names, SKU, `version`) plus `getInventoryChannels`, and sends
each line's `version` as `expectedBalanceVersion`.

## Database entry points (service role only)

| Function                                                                                           | Use                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `inventory_private.initialize_channel_stock(tenant, location, actor)`                              | `legacy → shadow`; all stock to `unallocated`                                                                |
| `inventory_private.allocate_channel_stock(tenant, location, actor, reason, idempotencyKey, lines)` | Admin split; lines `[{variantId, websiteQuantity, posQuantity, expectedBalanceVersion?}]`; exact replay safe |
| `inventory_private.set_channel_stock_mode(tenant, location, mode, actor, reason)`                  | `shadow ↔ enforced` (enforced is locked)                                                                     |
| `inventory_private.channel_reconciliation(tenant, location)`                                       | Per-variant buckets, mismatch, explicit-split flag                                                           |
| `inventory_private.channel_availability(tenant, location)`                                         | Website/POS on-hand, reserved, available                                                                     |

Error codes: `CH404` not found, `CH409` stale read / insufficient bucket / does not reconcile, `CH412` not
initialized, `CH422` invalid split or unattributable movement, `CH423` enforced mode locked, `CH500`
invariant violated, `ID409` idempotency key reused with a different payload.

## Test

```bash
pnpm test:inventory:channels:persistence   # database: invariant, isolation, privileges
pnpm test:inventory:write:integration      # HTTP boundary + real RPCs on an isolated rt-<hex> stack
pnpm vitest run tests/inventory/channel-service.test.ts
```

Needs Docker. Uses its own throwaway `postgres:17.6-alpine` container (tmpfs, no published port), applies
every migration, loads the POS, online and returns fixtures, runs the assertions with real commits, and
removes the container.

## Troubleshooting

- **Mismatch in shadow mode:** look at `inventory_channel_divergences` for the key. Running a new split for
  the variant re-derives `unallocated` and heals the key.
- **`CH423` when enforcing:** expected. Unlocking needs a reviewed migration once the storefront read path,
  POS stock grants and acceptance evidence exist.
- **`CH409 stocked variants without an explicit Website/POS split`:** every variant with stock at the
  location must appear in at least one admin split first.

## Security

Tables are owned by the non-login `inventory_writer`, have RLS enabled, and are not readable by `anon` or
`authenticated`. The server can read them and call only the entry points above; it cannot update buckets
directly. All functions are `SECURITY DEFINER` with an empty `search_path`. Ledger, runs and divergences are
append-only.

## Known limitations

- No admin screen (admin-mobile) or storefront read path yet; the SDK with these methods is not re-vendored
  into the client repos yet.
- `initialize` is idempotent by state, not by key: a same-key/different-body request is not detected (the
  body is only the location id, and a repeat is a no-op).
- `GET` returns every variant with a balance at the location in one response (no pagination).
- POS stock grants (`reserved_qty`) arrive with ADR-042 §4; until then POS `reserved_qty` is 0.
- Negative adjustments cannot yet name a source bucket; they draw from `unallocated`.
- Website returns land in `unallocated` until the owner sets a rule.

## Verification and known limits (2026-11-14 follow-up)

- Website return: an accepted sellable return of an online order credits `unallocated` only (ledger
  `return_restock_unallocated`); proven in `phase_3a` T3–T5 (shadow mode).
- Concurrency: parallel splits and receipts complete without deadlock and keep `website + pos + unallocated =
canonical` (`tests/inventory-write-integration` concurrency case).
- **Known limit (Finding C):** `expectedBalanceVersion` guards the canonical balance only. Two admins splitting
  the same variant at once are last-writer-wins on intent (conservation and reservations still hold). A
  channel-state version in the split contract would make a stale split fail; that is a contract change for the
  API, SDK and admin-mobile (owner decision).
- Enforcement stays locked deployment-wide (`inventory_private.channel_feature_gate`). Tests that need it unlock
  it on their own disposable database only.

### Per-location cut-over checklist

1. `initialize` (all on-hand → `unallocated`, mode `shadow`). 2. Explicit split for every stocked active SKU
   (admin-mobile Channel split screen). 3. Run in `shadow` until `inventory_private.channel_reconciliation` shows
   zero mismatches and `inventory_channel_divergences` stops growing. 4. POS grants issued and consumed in
   `shadow` at least one full lease cycle. 5. A reviewed migration unlocks the gate. 6. `set_channel_stock_mode
('enforced')` per location (refused while any mismatch or unsplit SKU exists). Rollback: back to `shadow`.
