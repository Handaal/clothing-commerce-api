# ADR-022: Opening-Stock One-Time Semantics

- Status: Accepted
- Date: 2026-08-22

## Context

"Opening stock" initializes a `Variant + InventoryLocation` key's first stock. It must be
distinguishable from a routine adjustment and must happen at most once per key. Checking "does a
balance row exist" is wrong: a zeroed balance (`+5` then `-5`) still has history, and a balance row
can exist at zero. Checking history in the application before calling the ledger is a time-of-check /
time-of-use race: two concurrent openings could both pass a lock-free check.

## Decision

- `setOpeningStock` requires a positive `quantity` and targets an active variant at an active
  location. A key that should start at zero simply has no opening; explicit zero is an adjustment.
- Add `inventory_private.record_opening(...)`, a hardened `SECURITY DEFINER` function that obtains the
  balance-row lock (creating the row race-safely if absent) and then, **under that lock**, rejects the
  opening if any prior movement exists for the key (`IN001`). Establishment is judged on **movement
  history**, not balance-row presence. The actual ledger write and idempotency are delegated to the
  audited `record_operation`.
- Because the history check happens under the same row lock every mutation takes, two concurrent
  openings serialize; the loser observes the winner's movement and is rejected. An idempotent replay
  of the same key is exempt from the `IN001` rejection and resolves to the original operation (the
  same-key concurrent case replays; a same-key different-payload case is `ID409`).
- The repository maps `IN001` → `OPENING_STOCK_ALREADY_EXISTS`.

## Alternatives rejected

- **Balance-row absence as the guard:** misclassifies zeroed-but-historical keys.
- **Application check-then-write:** race-prone across two RPCs with no shared transaction.
- **A partial unique index for "one opening per key":** operations do not carry variant/location
  (movements do), so the constraint cannot be expressed without denormalization.
- **Requiring opening to be reconstructable via adjustment only:** loses the explicit initialization
  audit semantic and the loud "already opened" signal.

## Consequences

Initialization is a distinct, race-safe, one-time event with historical truth as the guard, while
idempotent retries remain safe. The concurrency suite proves that two concurrent openings yield
exactly one initialization (or a replay for a shared key) and never duplicate history.
