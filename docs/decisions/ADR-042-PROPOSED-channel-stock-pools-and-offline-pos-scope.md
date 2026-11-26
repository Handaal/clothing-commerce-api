# ADR-042 (PROPOSED): Website/POS stock channel pools, POS voucher quotas, till credential check, and the final offline POS scope

> **SUPERSEDED IN PART — owner direction of 2026-11-14 (night): online-first POS with bounded emergency
> offline operation and post-sync conflict reporting.** Read **§13 first**; it is the current decision.
> The owner does **not** want stock divided between the Website and the POS. §3 (channel stock pools),
> §4 (per-till stock grants), §5.2 (reserved POS voucher quota), §7 (offline returns) and the 2026-11-14
> "all desks" scope are **superseded** and must not be implemented further or activated. §1, §5.4 (sale
> stands at the price paid), §6.1 (lease), §6.2/§6.3 (credential storage, with the security finding in §13.6),
> §8 (customers) and the no-approval-queue rule remain in force as amended by §13.

- Status: **PROPOSED, owner decisions recorded 2026-11-14; partly superseded the same night (§13).** Written from the owner's final scope document
  (`final-offline-pos-scope-stock-vouchers-architecture-prompt.md`) and the owner's answers of
  2026-11-14 (§10). It supersedes ADR-041 Decision D (offline promotions OUT) and narrows the
  2026-11-14 "all desks" intent lane. No migration, contract, SDK or policy has been changed yet.
- Activation gate: **nothing in this ADR is switched on** (offline stock grants, offline vouchers,
  credential-gated actions, enforced channel stock) until fresh-database migrations, real HTTP +
  PostgreSQL acceptance, POS crash/restart tests and Website/POS isolation assertions all pass. Every
  piece is additive and behind a flag.
- Related: ADR-017/018/019 (inventory ledger, concurrency, idempotency), ADR-024/027 (order channel,
  order/inventory separation), ADR-026/037 (pricing snapshots, promotion accounting), ADR-041 (offline
  cashier expansion), `docs/pos/offline-pos-v1.md`, `docs/pos/pos-native-auth-v1.md`.

## 1. Baseline (inspected 2026-11-14, uncommitted working trees)

| Repo                           | Branch                            | HEAD      | Dirty paths                                      |
| ------------------------------ | --------------------------------- | --------- | ------------------------------------------------ |
| clothing-commerce-api          | `feat/pos-pin-provider`           | `0a747db` | 76                                               |
| clothing-commerce-pos          | `feat/pos-pin-login`              | `1a40f49` | 70 (2 prunable detached worktrees outside `Zee`) |
| clothing-commerce-storefront   | `feat/home-hero-redesign`         | `08a5b84` | 26                                               |
| clothing-commerce-admin-mobile | `feat/mobile-ui-refresh-sdk-0.19` | `2dc4234` | 96                                               |

| Area                                                            | Current implementation                                                                                                                                                                                                                                                                                                              | Gap against the owner scope                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Stock                                                           | One canonical `inventory_balances(tenant, variant, location).on_hand_quantity` (+ ledger, ADR-017). Storefront and POS (online and offline) read and decrement it. Offline sale ingestion locks the same row (`lock_balance_for_offline_sale`) and opens `insufficient_stock_at_ingestion` on shortfall. No reservations (ADR-027). | No channel partition: an offline POS sale reduces Website availability today. Needs channel pools (§3). |
| Offline stock authority                                         | Grant bounds money (`max_sale_amount_minor`, `max_cumulative_exposure_minor`), `max_quantity_per_line`, `max_pending_offline_sales`. No per-variant reserved quantity.                                                                                                                                                              | Signed per-variant POS stock grant lines reserved from the POS pool (§4).                               |
| Vouchers                                                        | `promotions.channel` ∈ {null = both, `pos`, `online`}; one shared `global_redemption_limit/redemption_count`; `promotion_codes.max_redemptions/redemption_count` shared across channels. Redemptions never reversed (ADR-037). Offline promotions fail closed (ADR-041 D).                                                          | Per-channel limits and counters, reserved POS quota grants, `requires_pos_admin_credentials` (§5).      |
| Returns                                                         | `offline_return_grants` + `record_offline_return`: eligibility frozen from the canonical engine, refund always `pending`, every line `non_restock`. `max_refundable_minor` defaults to the canonical eligibility ceiling (ADR-041 A-i still open).                                                                                  | Credential requirement + assertion (§6); later restock to POS only (§7).                                |
| Attendance                                                      | Signed offline clock events applied at ingestion. Optional **target membership** (team clock) allowed when the operator holds tenant-wide `attendance.manage`.                                                                                                                                                                      | Matches owner D-4; verify only.                                                                         |
| Customers                                                       | Offline sale may carry customer capture; `customers.create` exists only as an intent kind with no handler.                                                                                                                                                                                                                          | Typed name + phone command, duplicate flag, local purge (§8).                                           |
| Installments / payments                                         | Shipped; tender preserved, cashier-attested (ADR-041 B). Bounded by `max_offline_credit_exposure_minor`.                                                                                                                                                                                                                            | Verify only.                                                                                            |
| Intent lane (uncommitted 20261114120000/130000, never deployed) | Generic signed intents with automatic disposition; handlers for `inventory.*`, `settings.device_revoke_request`; slots for suppliers/staff/settings/customers.                                                                                                                                                                      | Out of scope; retired (§9).                                                                             |
| Lease                                                           | Per-register `operator_lease_seconds`, `catalog_grant_seconds`; grant `accepted_until = least(both)`. Dev fixture 12 h / 24 h. **No production policy row.**                                                                                                                                                                        | Production values per §6.1.                                                                             |
| POS credentials                                                 | POS accounts sign in with **username + PIN** (`pos_pin` provider, ADR-040 draft). The PIN _is_ the POS account credential; there is no separate POS password. Offline bootstrap provisions a device-bound scrypt verifier `scrypt(pin, salt ‖ deviceId)` per roster member, sealed with Electron `safeStorage`.                     | Add a separate override password with the same sealing/verifier pattern (§6.3, D-6).                    |

## 2. Final offline scope

| Operation                                       | Offline                                                                                                                 | Server disposition on sync                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Sale                                            | Yes, only against the local POS stock grant                                                                             | accepted / rejected / conflict; consumes POS pool + grant line atomically              |
| Installment sale / customer paydown             | Yes (existing)                                                                                                          | existing typed RPC; tender preserved, never "settled"                                  |
| Clock in / out                                  | Yes: the till operator clocks any active staff member if they hold `attendance.manage`, otherwise only themselves (D-4) | applied / blocking error                                                               |
| Attendance correction, payroll                  | No                                                                                                                      | —                                                                                      |
| Return capture                                  | Yes, against signed return grant; credential check if the return policy requires it                                     | accepted (refund `pending`, no restock) / reconciliation                               |
| Refund settlement                               | **No**                                                                                                                  | —                                                                                      |
| Voucher redemption                              | Yes, POS-enabled voucher with a reserved POS quota grant; credential check if configured                                | accepted / accepted-with-exception (§5.4) / rejected-before-sale is impossible offline |
| New customer (name + phone)                     | Yes                                                                                                                     | accepted, duplicate flagged; never merged                                              |
| Edit / merge existing customer                  | No                                                                                                                      | —                                                                                      |
| Orders                                          | Cached, read-only                                                                                                       | —                                                                                      |
| Suppliers                                       | **Section disabled**                                                                                                    | —                                                                                      |
| Inventory receive / adjust / count / allocation | No                                                                                                                      | —                                                                                      |
| Staff, settings, devices, reports               | No                                                                                                                      | —                                                                                      |

There is **no approval queue**. Nothing waits for a person. Every synced command is decided automatically
(accepted / rejected / conflict / blocked). An admin credential, where required, is entered at the till
during the transaction and checked there and then.

## 3. Stock channel pools

### 3.1 Model

- Canonical truth stays `inventory_balances.on_hand_quantity` (ADR-017). Channels partition it.
- `inventory_channel_balances(tenant_id, inventory_location_id, variant_id, channel ∈ {website, pos,
unallocated}, on_hand_qty ≥ 0, reserved_qty ≥ 0, reserved_qty ≤ on_hand_qty, version, last_ledger_seq,
updated_at)`, unique `(tenant_id, inventory_location_id, variant_id, channel)`.
- `inventory_channel_ledger` (append-only, immutable trigger): event id, key, channel, `event_type`,
  `quantity_delta`, optional `from_channel/to_channel`, source document/line, POS command id, grant id,
  device/register/operator, event/recorded time, policy version, unique idempotency key.
- `inventory_allocation_runs`: actor, reason, before/after per variant, canonical version read, status.
- Per-location `inventory_locations.channel_stock_mode ∈ {legacy, shadow, enforced}` (default `legacy`).

### 3.2 Reconciliation invariant (the rule everything else is tested against)

For every `(tenant, location, variant)` at a location in `shadow` or `enforced` mode, at every commit:

```
website.on_hand + pos.on_hand + unallocated.on_hand  =  inventory_balances.on_hand_quantity
0 ≤ reserved_qty ≤ on_hand_qty                         (each channel row)
pos.reserved_qty = Σ unconsumed active stock-grant lines for that key   (0 until §4 ships)
website reserved  = Σ active public.stock_reservations (quantity − consumed) for that key
                    (derived live, never stored twice; website.reserved_qty stays 0)
website available = website.on_hand − website reserved
```

Implemented (uncommitted) in `supabase/migrations/20261114140000_inventory_channel_stock_pools.sql`:

- Modes per location: `legacy` (default, triggers do nothing), `shadow` (buckets maintained, never refuses;
  an overdraw or unattributable movement is logged in `inventory_channel_divergences`, and the next admin
  split re-derives `unallocated` and heals the key), `enforced` (invariant checked at commit, overdraw
  refused with `CH409`, unattributable movement with `CH422`, mismatch with `CH500`).
- `enforced` is locked deployment-wide by `inventory_private.channel_feature_gate` until the storefront read
  path, POS grants and acceptance evidence exist. Entering it also requires zero mismatches and an explicit
  split for every stocked variant.
- Attribution runs in a deferred constraint trigger on `inventory_movements`, so it sees the fulfilment or
  return row written later in the same transaction.
- Global lock order: balance rows (by variant) → location row → channel rows.
- Proof: `pnpm test:inventory:channels:persistence` (disposable Postgres, all migrations, real POS sale,
  real website checkout + fulfilment, real POS return, committed transactions).

- Enforced by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on both `inventory_balances` and
  `inventory_channel_balances`, so a transaction that breaks it cannot commit.
- Every canonical ledger write at a non-`legacy` location writes the matching channel movement in the
  **same transaction**; there is no asynchronous catch-up.
- A nightly/on-demand reconciliation view lists any key that violates the invariant (must be empty
  before `shadow → enforced`).

### 3.3 Channel semantics of each write (enforced mode)

| Write                                                    | Channel effect                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| POS sale (online or offline)                             | `pos.on_hand −= q` (and `pos.reserved −= q` if it consumes a grant line). Website untouched.                               |
| Storefront order fulfilment                              | `website.on_hand −= q`. POS untouched.                                                                                     |
| Admin allocation                                         | Transfer between buckets; conservation in one transaction; refused if the source's `on_hand − reserved` would go negative. |
| Receipt, opening stock, positive adjustment              | **`unallocated += q`** (owner D-1).                                                                                        |
| Negative adjustment / count correction                   | Admin names the bucket; refused if it would breach `reserved_qty`.                                                         |
| Accepted return of a POS sale, sellable disposition      | `pos += q` only. Damaged/quarantined: no sellable bucket.                                                                  |
| Accepted return of a website order, sellable disposition | `unallocated += q` (no owner rule for website returns; safe default).                                                      |
| Inter-location transfer                                  | From a named bucket; lands in destination `unallocated`.                                                                   |

Website availability = `website.on_hand − website.reserved`. POS availability =
`pos.on_hand − pos.reserved` (+ the till's own grant remainder offline).

### 3.4 Lock order

`inventory_balances` row → channel rows (`pos`, `unallocated`, `website`) → stock grant line → promotion
channel policy → promotion code channel limit → voucher grant. Every writer uses this order.

### 3.5 Backfill and cut-over

Backfill moves all existing on-hand into `unallocated` with an `opening_allocation` ledger entry; no
guessed split. An `unallocated`-only variant cannot be granted to the till. `legacy → shadow` once rows
exist; `shadow → enforced` only when every active SKU at the location has an explicit allocation run and
the reconciliation view is empty.

## 4. Offline POS stock grants

- `offline_pos_stock_grants(tenant, location, device, register, issued_at, expires_at ≤ accepted_until,
schema/policy version, key id, signed payload, status ∈ {active, closed, expired, revoked})`.
- `offline_pos_stock_grant_lines(grant_id, variant_id, granted_qty, consumed_qty, released_qty,
version)`, `consumed + released ≤ granted`, unique `(grant_id, variant_id)`.
- Issuance (online) reserves from `pos` (`pos.reserved += granted`). Total unconsumed reservations never
  exceed `pos.on_hand`. One active grant per register. Multi-till later receives disjoint slices; the
  same quantity is never in two grants (enforced by the `pos.reserved ≤ pos.on_hand` check).
- Till: one SQLite transaction validates grant + line remaining, decrements local remaining, writes the
  sale and outbox row. No line, exhausted line or expired grant ⇒ item not sellable offline.
- Sync: existing checks (binding, schema, device signature, credential-at-acceptance, `acceptedAt`
  within grant authority, device sequence) plus `consumed + q ≤ granted`. Accept posts sale,
  `pos.on_hand −= q`, `pos.reserved −= q`, `line.consumed += q` atomically. Replay returns the original.
- Release: unconsumed remainder is released only when the till closes the grant at a final sync with its
  sequence high-water mark, or after `expires_at + 5 min skew` with no sequence gap. Until then the
  reservation stands, so an unreported offline sale can never oversell.
- Clock trust: `eventAt` alone never proves ordering; reuse device sequence + `accepted_until` + skew.

## 5. Voucher channel policy and reserved POS quota

### 5.1 Policy

- `promotion_channel_policies(promotion_id, channel ∈ {pos, website}, enabled, usage_limit,
redeemed_count, reserved_count, expires_at, requires_admin_credentials)`, unique `(promotion_id,
channel)`; `requires_admin_credentials` only when `channel = 'pos'`;
  `redeemed_count + reserved_count ≤ usage_limit` when the limit is set.
- Same split for codes: `promotion_code_channel_limits(code_id, channel, usage_limit, redeemed_count,
reserved_count)`.
- Usage = one redemption transaction (ADR-037). Website and POS counters are independent.
- Compatibility: a promotion with no channel-policy rows behaves exactly as today (shared counter,
  offline fail-closed). Existing vouchers are never auto-enabled offline. Offline grants require a
  finite POS `usage_limit`.

### 5.2 Quota reservation

- `offline_pos_voucher_grants(promotion_id, code_id, device, register, issued_at, expires_at ≤
accepted_until, allowed_count, consumed_count, released_count, policy version, calculation version,
key id, signed payload, status)`.
- Issuance moves quota from available to reserved in the same transaction:
  `reserved_count += allowed_count` on both the channel policy and the code channel limit.
- An online POS redemption or another till can use only `usage_limit − redeemed − reserved`. So
  ordinary quota contention **cannot** invalidate a redemption already authorised by a grant.
- Sync consumes exactly one reserved unit: `reserved −= 1, redeemed += 1, grant.consumed += 1`. Website
  counters never change. Release follows the stock-grant rule (§4).

### 5.3 Till behaviour

Checks signed terms, expiry in store timezone, grant remainder, eligibility, the existing one-code /
no-stacking rule, and the credential flag; decrements the local count in the sale transaction; computes
the discount with the canonical evaluator version carried in the grant; labels it provisional.

### 5.4 Rejected after the sale (owner D-2)

Rejection can still happen for reasons a reservation does not cover (voucher revoked, grant revoked,
tampered or replayed command, policy version withdrawn). Then:

- The sale and receipt stand at the price paid. No later charge. No receipt change.
- The redemption row is written with state `exception` and a deterministic code (e.g.
  `VX_REVOKED`, `VX_POLICY_WITHDRAWN`, `VX_GRANT_INVALID`) plus the discount amount.
- It appears in an "offline discount exceptions" report. It creates no task and no approval.
- No quota is consumed for an exception; the reservation is released.

## 6. Production lease and till credential check

### 6.1 Production lease (owner D-5)

- Recommended production values: `operator_lease_seconds = 43200` (12 h),
  `catalog_grant_seconds ≤ operator_lease_seconds`.
- New check constraint: `operator_lease_seconds ≤ 86400` and
  `catalog_grant_seconds ≤ operator_lease_seconds`. (The dev fixture's 24 h catalog window must drop to
  ≤ 12 h when the fixture is updated.)
- Stock grants, voucher grants, return grants and the credential verifier all expire at or before the
  grant's `accepted_until`.
- Production offline stays disabled until a policy row is configured and validated by the gate above.
- Existing approved money limits are kept. Amount limits that are **missing** and must be set by the
  owner before the operation is enabled:
  - offline voucher discount: maximum discount per redemption and cumulative per grant;
  - offline returns: per-grant refund budget (ADR-041 A-i; today defaults to the eligibility ceiling).

### 6.2 Who qualifies (existing permissions, no hard-coded role)

- Voucher credential check: the admin must hold `promotions.manage` at tenant scope or at the till's
  branch.
- Return credential check: the admin must hold `payments.refund` at tenant scope or at the till's branch.
- Evaluated online at bootstrap from the live role assignments; the till receives only qualifying
  members' verifiers, tagged with the permission they satisfy.

### 6.3 Verification and security model

- Credential: the admin's **POS username + a separate POS override password** (owner D-6). It is not
  the sign-in PIN and not the Clerk password.
  - Only accounts that hold `promotions.manage` or `payments.refund` can set one. The account holder
    sets or changes it **online** in the POS (re-authenticated with their PIN first). An admin can clear
    another account's override password but never read or set it.
  - Policy (proposed): at least 10 characters, not equal to or containing the username or PIN, and
    checked against a small built-in deny list of common passwords.
  - **Server storage — verifier v2 (revised 2026-11-14 after security review).** The first build copied
    the PIN pattern (a KEK-sealed AES-256-GCM copy decrypted at every bootstrap). That lets anyone with the
    KEK and a database copy recover every admin's plaintext, which the owner rule forbids, so it was
    replaced before any activation by `20261114200000_pos_override_password_verifier_v2.sql`: the server
    stores only `V = scrypt(password, salt)` (N = 2^15, r = 8, p = 1, 32 bytes, 16-byte salt; CHECK forbids
    any ciphertext column and any weaker work factor). There is no key that yields plaintext; a database
    dump allows only an offline guessing attack at one scrypt per guess. Every v1 sealed credential was
    wiped and its `verifierVersion` bumped (no conversion path exists without decrypting); qualifying
    admins re-enter their password once. Changing or clearing bumps `verifierVersion`.
- At online bootstrap the server sends, per qualifying admin, salt + cost and a device-, admin- and
  version-bound tag `HMAC-SHA256(V, "pos-override-v2" ‖ deviceId ‖ membershipId ‖ verifierVersion)` with
  `membershipId`, permission tag and `expiresAt = accepted_until` — never `V` itself. The till recomputes
  the tag from the typed password (`src/pos/override-password-crypto.ts` ↔ POS `override-roster.ts`,
  byte-identical, proven over real HTTP). The roster is sealed with Electron `safeStorage` (OS key store)
  in the main process; any non-v2 entry is dropped (fail closed). Never in SQLite, renderer state, logs,
  outbox or API commands. No plaintext anywhere.
- The sign-in PIN (ADR-040) still uses the KEK-sealed pattern; it is out of this ADR's scope but has the
  same recoverability property and should get the same treatment before production (owner decision).
- Main process verifies; the renderer only sends the typed username/secret over IPC and receives
  pass/fail. 5 failures per username ⇒ 5-minute lockout, persisted across restart.
- On success the main process signs a one-use assertion `{assertionId, commandId, adminMembershipId,
permission, verifierVersion, policyVersion, deviceId, deviceSequence}` with the device key. The
  command carries only this assertion.
- Server checks device signature, single use of `assertionId`, binding to the command, that the
  verifier version and permission tag were issued to this device for this admin in the referenced
  bootstrap, and expiry.
- Disclosed limit: a credential change or permission removal made while the till is offline is not seen
  until its next online bootstrap; exposure is capped by `accepted_until` (≤ 12 h recommended). This is
  weaker than online authentication.
- No valid verifier for a qualifying admin ⇒ the gated redemption/return is unavailable (fail closed).

## 7. Returns

Bounded by original POS sale line quantity minus prior accepted returns (canonical engine, frozen in the
grant). `offline_return_grants.requires_pos_admin_credentials` copied from the return policy; assertion
per §6.3 when set. Refunds settle online. Later connected disposition credits `pos` only when sellable.

## 8. Customers

Typed `customer.create` (name, phone, local UUID). Server normalises the phone; a match flags
`duplicateOf` and **does not merge**. After the till records acceptance, the next successful sync deletes
the local profile; sale/receipt snapshots keep name and phone.

## 9. Retirement of out-of-scope intent kinds

`inventory.*`, `suppliers.*`, `staff.*`, `settings.*`, `customers.update`, `review.*` leave the till's
offerable list and are disposed `rejected / OIX_KIND_OUT_OF_SCOPE` if received. Forward migration narrows
the constraint (the two intent migrations were never deployed). `customers.create` moves to §8.

## 10. Owner decisions (2026-11-14)

| #   | Decision                                                                                                                                                                                                                                                                                            | Status                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D-1 | Received stock goes to `unallocated` until explicitly split.                                                                                                                                                                                                                                        | **Decided**                                                                                                      |
| D-2 | Voucher rejected after sale: sale/receipt stand at paid price, deterministic exception, no later charge; grants reserve quota.                                                                                                                                                                      | **Decided**                                                                                                      |
| D-3 | Qualifying admins come from existing permissions (`promotions.manage`, `payments.refund`), not a hard-coded role.                                                                                                                                                                                   | **Decided** (permission mapping proposed in §6.2)                                                                |
| D-4 | Offline attendance: the signed-in till operator clocks all staff in and out. Staff do not clock themselves. The authority comes from `attendance.manage`, which an admin grants to specific accounts; an operator without it can clock only their own account. Corrections and payroll stay online. | **Decided** (matches current code)                                                                               |
| D-5 | Production lease 12 h, never > 24 h, catalog ≤ lease; offline off until configured and validated.                                                                                                                                                                                                   | **Decided**                                                                                                      |
| D-6 | Till credential = POS username + a **separate override password** per qualifying account (not the PIN).                                                                                                                                                                                             | **Decided** (storage and policy in §6.3)                                                                         |
| D-7 | Missing amount limits: voucher discount per redemption + per grant; return refund budget per grant.                                                                                                                                                                                                 | **Built as required owner fields** (no defaults). Offline vouchers/returns stay off until the owner enters them. |

## 11. Rollout and rollback

Forward-only, additive migrations. Per location `legacy → shadow → enforced`, gated on the empty
reconciliation view and every active SKU allocated. Offline stock/voucher operation remains off until the
activation gate at the top passes. Rollback is a read flag while in `shadow`; once `enforced`, rollback is
a forward reconciliation (the canonical balance is already the truth, so buckets are simply dropped from
reads). No legacy column is dropped.

## 12. Implementation status (2026-11-14, uncommitted)

Everything below is additive and gated. Enforced channel mode stays locked by
`inventory_private.channel_feature_gate`; production offline stays off until a validated policy row exists.

| Section                      | Server (clothing-commerce-api)                                                                                                                                                                              | Till (clothing-commerce-pos)                                                                                                   | Tests                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| §3 storefront read path      | `20261114150000_channel_storefront_read_path.sql`: projection reads the website bucket when enforced; reservation guard on `stock_reservations`                                                             | —                                                                                                                              | `phase_3a` SF1–SF8; online HTTP suite 19/19    |
| §4 stock grants              | `20261114160000_offline_pos_stock_grants.sql` (issue / consume / close / expire; shortfall evidence); bootstrap `stockGrant`, `closePreviousGrant`                                                          | grant install, enforced per-line limit derived from sale rows, previous-grant close                                            | `phase_3c`; till `adr042-offline-scope`        |
| §5 vouchers                  | `20261114170000_promotion_channel_policies_offline_vouchers.sql`: channel policies + code limits, quoting filter, quota grants, `ov1` discount, D-2 exceptions; channel-policy + exception-report endpoints | voucher preview + apply, quota/cap checks, approval; POS voucher detail "POS limit and offline use"                            | `phase_3d`; till tests                         |
| §6 override password + lease | `20261114165000_pos_override_passwords.sql` (sealed credential, roster, issuance record, one-use assertions, lease bound `NOT VALID`); `PUT /pos/override-password`, `DELETE /staff/{id}/override-password` | OS-sealed roster file, 5-failure / 5-minute lockout persisted, assertion bound to the command; Settings "My override password" | `phase_3d` P1–P7, L1–L2; API + till unit tests |
| §7 returns                   | `20261114180000_offline_return_credentials_and_budget.sql`: required per-grant refund budget, credential flag, cumulative budget at ingestion                                                               | approval fields on offline return; Settings refund budget + approval toggle                                                    | `phase_3e`; HTTP returns suites                |
| §8 customers                 | `20261114190000_offline_customers_and_intent_scope.sql`: `record_offline_customer` (duplicate flagged, never merged); `POST /pos/offline-customers`                                                         | new-customer form, customer outbox (delivered first, local profile deleted on acceptance)                                      | `phase_3f`; HTTP C1–C3; till tests             |
| §9 retirement                | same migration: generic intents disposed `rejected / OIX_KIND_OUT_OF_SCOPE`; registers cannot opt in                                                                                                        | intent panels removed; Suppliers disabled offline; Orders cached read-only                                                     | `phase_3f` IS1–IS4; HTTP R0–R4                 |

SDK 0.33.0 is vendored into the storefront and admin-mobile; the POS vendors **0.34.0** (2026-11-14: override
verifier v2 roster shape — the only contract change; storefront/admin-mobile do not consume it).

### 12.1 Follow-up program (2026-11-14) — evidence and findings

| Item                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Override password security review       | **v1 FAILED** (server-recoverable plaintext). Replaced by verifier v2 (§6.3); phase_3d P1–P11 on fresh Postgres; API unit (one-way, no KEK needed, device/admin/version binding); POS roster tests; real HTTP O1–O4 (one-way storage, server-minted tag verified by the till, one-use assertion consumed by the server, lockout across restart).                                                                     |
| UI wording                              | "Manager approval" removed (EN/AR); "Admin credentials required", immediate check at the till, limitation disclosed. Error codes `ADMIN_CREDENTIALS_*`.                                                                                                                                                                                                                                                              |
| Lease (D-5)                             | `20261114210000_offline_grant_lease_hard_bound.sql`: every new grant clamped to operator ≤ 24 h, catalog ≤ operator, authority ≤ both; `offline_pos_private.lease_policy_violations` lists non-compliant rows. No settings row rewritten. phase_3d L3–L11.                                                                                                                                                           |
| Offline new customer → installment      | POS local schema v19 dependency (sale/paydown wait for the customer; rejected ⇒ held, never relinked). Real HTTP N1–N3; Electron crash/restart acceptance.                                                                                                                                                                                                                                                           |
| Stock grant + vouchers over real HTTP   | S1–S5 at an enforced location (gate unlocked on the disposable DB only, test-only caps).                                                                                                                                                                                                                                                                                                                             |
| **Finding: held sale vs. stock grant**  | A sale the till holds (its new customer was rejected) is an ordinal that never reaches the server, so `close_offline_stock_grant` / the expiry sweep never release the grant and the next bootstrap is refused (N4). Needs an owner/design decision (see the program report): e.g. a signed "abandoned ordinal" report, or server-side `needs_reconciliation` ingestion of an installment whose customer is missing. |
| **Finding: offline card tender status** | Offline non-cash tenders are stored as `payments.status = 'captured'` (cashier-attested). The domain has no "recorded / not externally confirmed" status; the owner rule asks to distinguish them. Needs a payments-domain decision.                                                                                                                                                                                 |

Still required before activation (unchanged gate): fresh-database migration run on a real Supabase stack,
POS crash/restart acceptance against a live server, the owner's D-7 values, unlocking the enforced gate by a
reviewed migration, and a production policy row within the D-5 bounds. Known limits: an offline-created
customer cannot carry an installment until it has synced; a mode change to enforced is seen by a till at its
next bootstrap.

### 12.2 Blocker program (2026-11-14, evening) — Findings A/B/C fixed; evidence

All three findings of §12.1 now have a forward-only fix (uncommitted; nothing applied to shared dev; nothing
enabled). SDK **0.35.0** (`artifacts/shifted-clothing-commerce-sdk-0.35.0.tgz`, sha256
`3d88537196bdd8fc9cb98eb4c7adb688ff376a358fe858b45637c72c2c1ccc3c`, deterministic on repack) vendored
byte-identically into POS and admin-mobile; storefront stays on 0.33.0 (consumes none of the changed shapes).

| Item                                      | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — held sale × stock grant** (§4.6)    | `20261115120000_offline_sale_reconciliation_holds.sql` + `POST /api/v1/pos/offline-sale-holds`. The till signs a HOLD naming the ORIGINAL signed sale's SHA-256; the server verifies both device signatures, binding, grant window, ordinal unused and that the customer genuinely does not exist, then writes ONE immutable `held_for_reconciliation` record per ordinal (sale not applied, not voided; units moved to `held_qty`, still reserved). `stock_grant_ordinals_complete` counts ingested ∪ held; a trigger refuses any later ingestion of a held/used ordinal (same advisory lock). Exact replay ⇒ original receipt; different hold ⇒ 409. POS local schema **v20** `sale_hold_outbox` enqueued in the SAME transaction as the rejection, signed once (immutable), and `previousGrantClose` offers the close only after the server acknowledges. | phase_3g (P1–P7, W1, H1–H9, A1–A7, O1–O4, R1–R10) on fresh Postgres; real HTTP N4 (wedge reproduced → hold → replay → 409 conflicts → re-bootstrap closes the old grant, `held_qty` retained); POS vitest `sale-hold.test.ts` 4/4; Electron `acceptance:sale-hold` (crash before send, lost response after commit, byte-identical replay) PASS. |
| Resolution of a hold                      | **Not implemented (owner decision O-A1).** The hold stands; held units stay reserved and are listed by `inventory_private.offline_stock_grants_awaiting_close`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                               |
| **B — offline card/wallet tender** (§4.7) | `20261115130000_offline_tender_awaiting_confirmation.sql`: an offline (`offline-payment:%`) card / instapay / wallet payment is inserted `pending` with `captured_at` NULL; cash unchanged (`captured`). Only the existing sanctioned `transition_payment` (provider-confirmed) may capture. Response schema `OfflinePosPayment` (`status: captured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | pending`, `confirmation: received_cash                                                                                                                                                                                                                                                                                                          | awaiting_provider_confirmation | legacy_captured_unverified`). Historic rows untouched; `payments_private.offline_tender_confirmation_report`tells legacy rows apart. Returns already refuse`PAYMENT_NOT_CAPTURED`. POS receipt lists non-cash tenders as "recorded offline, awaiting confirmation (not settled)". | real HTTP N1 + offline HTTP case 4/6 assert DB `status='pending'`, `captured_at IS NULL` for card, `captured` for the cash leg; POS receipt asserted in the Electron run. |
| **C — concurrent stock split** (§3.5)     | `20261115140000_channel_allocation_versions.sql`: per-(location, variant) `allocation_version`; `allocate_channel_stock_v2` requires `expectedBalanceVersion` AND `expectedAllocationVersion` on every line, serializes on the balance row locks, re-reads and returns 409 with CURRENT values (error `details`) for stale lines; all-or-nothing per request; replay of the same key returns the original run, different content ⇒ `ID409`. The unguarded function is no longer callable by `service_role`.                                                                                                                                                                                                                                                                                                                                                  | inventory write integration 20/20 on disposable Supabase incl. "four admins from the same versions: exactly one 200, three 409, final = winner" and "splits racing receipts: receipts always land, ≤1 split wins, conserved"; unit + admin-mobile tests.                                                                                        |
| Expiry release without proof              | `stock_grant_ordinals_complete(…, NULL)` now answers false: expired stock **and voucher** grants are RETAINED until the till reports its final ordinal (a sale accepted before expiry may sync later).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | phase_3c X2–X9 (retained, surfaced, late sale consumes it, till close ends it).                                                                                                                                                                                                                                                                 |
| Catalog barcode fixture                   | Root cause verified: `20261113122000` adds an AFTER INSERT trigger that gives every variant a canonical primary code128; the fixtures inserted a second primary. Fixtures now insert secondary barcodes and assert the canonical primary; uniqueness rules unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `test:catalog:persistence` PASS twice from empty schema; `test:catalog:rls` 43/43.                                                                                                                                                                                                                                                              |

Open owner decisions: O-A1 (what resolves a held sale: convert to a cash sale / new customer / return to
stock), O-B1 (provider/terminal confirmation source for offline card/wallet), D-7 caps, PIN verifier hardening
(see roadmap §24.5), assertion password-proof (§24.5), shared-dev policy row (catalog 24 h > lease 12 h).

## 13. Owner direction 2026-11-14 (night) — online-first POS, bounded emergency offline, post-sync conflict reporting (CURRENT)

This section supersedes §2, §3, §4, §5.2/§5.3, §7, §9's "all desks" premise and the stock-related parts of
§11/§12. Where §1–§12 disagree with this section, this section wins.

### 13.1 Product direction

- The whole connected system normally operates **online**. The POS is online-first.
- During a **temporary** outage only the operations in §13.2 may continue, from last-synced local data,
  bounded by the offline lease (§13.7). Nothing here is "fully offline".
- The Website keeps selling while a till is offline. Shared-stock and shared-voucher conflicts are therefore
  **possible** and are represented honestly after sync (§13.5), never prevented by partitioning stock.
- **One shared canonical stock pool**, as before ADR-042: `inventory_balances` + the append-only ledger
  (ADR-017). No Website/POS/unallocated buckets for operational use, no per-till stock grants or
  reservations, no admin stock-split workflow.
- **No approval queue.** The server automatically accepts, rejects, records a conflict or records a blocked
  policy result. The conflict section is a report, not an inbox.

### 13.2 Offline scope

| Operation                                                                                                              | Offline                                                                                                                                                                | On sync                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cashier sale (incl. split tender)                                                                                      | Yes: cached catalog/price/tax + local **estimate** of shared stock (advisory snapshot minus this till's unsynced lines)                                                | Sale recorded once (idempotent). If canonical stock is short, the sale still stands and a structured `stock_shortfall` conflict is written in the same transaction (§13.4) |
| New customer (name + phone only)                                                                                       | Yes, stable local UUID                                                                                                                                                 | Accepted; a phone match is flagged `customer_duplicate` and **never merged**; local profile purged after acceptance, minimal sale/receipt snapshot kept                    |
| Installment sale / customer paydown                                                                                    | Yes (cached debt is information only)                                                                                                                                  | Applied idempotently; a paydown above the server's outstanding debt is **preserved as signed evidence** with a `customer_debt` conflict instead of being dropped (§13.5)   |
| Existing voucher redemption                                                                                            | Yes, **only** from the lease's cached policy when `POS_OFFLINE_CACHED_VOUCHERS=enabled` and the voucher is opted in (§13.6); credential-gated vouchers are online-only | Sale stands at the cashier price; one ordinary redemption if still valid and shared capacity remains, else a `voucher` conflict (§13.6)                                    |
| Attendance clock in/out                                                                                                | Yes (`attendance.manage` operator may clock staff; others only themselves)                                                                                             | Applied; a duplicate/unmatched/stale-roster event is preserved as signed evidence with an `attendance` conflict                                                            |
| Returns / refunds                                                                                                      | **No**: UI disabled, fail-closed in the POS main process and at the API (`OFFLINE_RETURNS_DISABLED`, no side effect)                                                   | —                                                                                                                                                                          |
| Edit customer, voucher create/edit, suppliers, inventory receive/count/adjust/transfer, order changes, settings, staff | **No** (online-only; orders cached read-only; Suppliers section disabled)                                                                                              | —                                                                                                                                                                          |

### 13.3 Tender semantics (no payment gateway)

The POS has no payment-provider integration. Cash, card/Visa, InstaPay and wallet are cashier-entered
records of a transaction the cashier handled physically. Offline the receipt says the tender was **recorded
by the cashier on this till (not yet synced)**; after sync it is recorded in the server ledger exactly as a
connected POS tender is (`payments.status = 'captured'` here means "recorded in the ledger", not "captured by
a gateway"). Method, amount, currency, cashier, sale/payment reference and idempotency identity are
preserved. There is no "awaiting provider confirmation" state: the pending-tender migration `20261115130000`
(never applied anywhere) is withdrawn to `supabase/migrations-superseded/`.

### 13.4 Stock: shared pool, local estimate, post-sync shortfall

- Till: one SQLite transaction checks product, lease, snapshot freshness and `estimate = advisory on_hand −
this till's unsynced sold quantity ≥ requested`, then writes the immutable sale + outbox row. The estimate
  is **not** authoritative and **not** a reservation.
- Server (`record_offline_sale`, pre-ADR-042 behaviour at `legacy` locations): the sale's order, payment(s)
  and debt are always written exactly once. If any line exceeds canonical on-hand at ingestion (or the device
  was revoked), **no stock movement is posted for that sale**, its order stays unfulfilled, and
  `offline_reconciliations` records the reason. The canonical balance is never driven below zero or rewritten.
- New (forward-only `20261115150000_online_first_sync_conflicts.sql`): an AFTER INSERT trigger on
  `offline_reconciliations` writes, in the same transaction, one `pos_sync_conflicts` row per short SKU with
  requested quantity, canonical on-hand at ingestion, shortfall, the till's cached advisory quantity/version/
  as-of from the grant snapshot, the intervening ledger movements since that snapshot (operation type, delta,
  operation id — Website orders appear as `sale` operations), every line of the sale (all unposted), and the
  offline sale/order/payment references.
- **Fix 2026-11-15 (`20261115180000_offline_sale_respects_online_commitments.sql`):** sufficiency is judged on
  AVAILABLE = on-hand − active Website reservations at the location, not on-hand alone. Before, a Website COD
  checkout (which reserves without reducing on-hand until fulfilment) followed by a stale offline sale of the same
  units made ingestion try to post the sale; `online_private.protect_committed_stock` then aborted the whole
  ingestion and the completed POS sale was refused and stuck on the till. Now that sale is recorded once as
  `needs_reconciliation` with a `stock_shortfall` conflict whose server evidence adds `committedToOnlineAtSync`,
  `availableAtSync`, `activeOnlineReservations` (Website order ids) and `serverCheckedAt`; the Website hold is
  untouched and the Website order is fulfilled normally later. Proven over real HTTP:
  `pnpm test:pos:offline:shortfall-client`.
- **What is canonical:** `inventory_balances` stays exactly what the ledger says (it already reflects the
  Website sale). The offline sale's units are **not** posted; the conflict row is the record of the physical
  oversell. Correcting stock and fulfilling or otherwise settling the order happen through the normal online
  inventory/order workflows, which can reference the conflict id. Known limit: the non-short lines of a
  conflicted sale are also left unposted (existing whole-sale behaviour); they are listed in the conflict
  evidence so they can be fulfilled online.

### 13.5 Conflict model (`pos_sync_conflicts`)

Stable id, tenant, branch, location, device, register, grant, `kind` (`stock_shortfall`, `voucher`,
`customer_duplicate`, `customer_debt`, `attendance`, `dependency`, `sync_integrity`), deterministic
`reason_code`, source table/id, sync command id, local reference, order/payment/customer/promotion/membership/
variant references, quantity and amount where meaningful, local evidence (what the till knew), server
evidence (what the server found), local event time, detection time and `status` (`open` | `informational`).
Rows are written only server-side, in the transaction that detects the conflict; evidence is immutable;
replay never duplicates a row (unique `dedupe_key`). No customer name or phone is stored in a conflict row.
Exposed read-only through `GET /api/v1/pos/sync-conflicts` and rendered by the POS **Sync conflicts** section
and the admin-mobile **Sync conflicts** screen. Nothing in the conflict surface mutates, reprices, approves or
overrides the original record; resolution happens in the normal online workflows.

Paydown and attendance conflicts: when the signed, binding-checked command is refused by business state
(`CA409` paydown above outstanding; `AT409` already clocked in; `AT404` no matching clock-in / staff not
active), the API records the original signed command once in `offline_conflict_ingestions` with a conflict
row and answers `syncOutcome: "conflict_recorded"`; the till marks it synced-with-conflict (not retryable,
not lost). The AR ledger and the attendance timeline are **not** changed by such a command.

### 13.6 Vouchers and credentials

The reserved-quota voucher grants of §5.2 stay superseded and are never issued. Emergency offline redemption of
an **existing** voucher uses a **cached policy** instead (forward-only `20261115160000_offline_voucher_cached_policy.sql`,
SDK 0.37.0, POS local schema v22). It reserves nothing, partitions nothing and is not a per-till quota.

**Gates (all required, otherwise the voucher is online-only):** server flag `POS_OFFLINE_CACHED_VOUCHERS=enabled`
(default **off**: unset or any other value issues nothing); a `pos` channel policy with `offlineEnabled = true` and
`requiresAdminCredentials = false`; code-activated, active, started, not ended; channel null/`pos`; branch
null/the lease's branch; **brand null** (the `ov1` till formula has no brand input); benefit `percentage` or
`fixed_amount` (fixed in the lease currency); code active; shared remaining usage observed now > 0 or unlimited.
Voucher creation/editing/limits/expiry/policy stay online-only.

**Snapshot (bootstrap, per lease):** `promotions_private.issue_offline_voucher_policies` records one immutable
`offline_voucher_policy_issuances` row per eligible code — canonical `ov1` terms (no raw code), `code_fingerprint =
sha256hex(tenantId:NORMALIZED_CODE)`, channel-policy version, `policy_digest` (SHA-256 of the jsonb text of the
terms + start/channel/branch/brand/statuses + channel-policy version/offline flag/credential flag/per-redemption
cap), shared `observed_remaining` (least of promotion global limit, code max, POS channel policy, POS code channel
limit; null = unlimited), `fetched_at`, `expires_at = least(lease accepted_until, ends_at)`. Bound to tenant,
lease (offline grant), device and register. The till receives the same values in `voucherPolicies`.

**Integrity model (honest):** the till cannot verify a server signature offline; it does not need to. The server
keeps the authoritative issued copy and the till echoes `policyIssuanceId` + `policyDigest` inside its
**device-signed** sale command, so a till that alters its cache is detected at sync (`VX_SNAPSHOT_INVALID`). Locally
the till stores `integrity_sha256` over the installed row (immutable-row trigger + check at every use) to detect
corruption/tampering at rest and refuse before selling; a fully compromised till can recompute that local hash,
which is why the server-side check is the authority.

**Till (one real-SQLite transaction):** look up by code fingerprint → integrity check → refuse if expired (policy,
lease or `endsAt`) → local ceiling: this till's uses of the code not yet counted by the server at fetch time
(accepted after `fetched_at`, or not acknowledged before it — derived from `local_sale` in the same transaction,
conservative) must be below `observed_remaining` (`VOUCHER_LOCAL_LIMIT_REACHED`) → `ov1` discount must be > 0 and
below the gross → per-redemption cap. The sale, lines, tender, voucher columns (`voucher_policy_issuance_id`,
`voucher_code_id`, discount, label) and the signed outbox row commit together; the outbox command is byte-identical
on every retry. The cashier sees the cache time, last-known remaining uses and "provisional until synced".

**Server (`record_offline_sale` → `redeem_offline_voucher_cached`):** after the usual lease/device/signature/
idempotency checks, in order: issuance exists for this lease/promotion/code with the same digest
(`VX_SNAPSHOT_INVALID`) → accepted within the snapshot window (`VX_EXPIRED`) → discount equals `ov1` on the issued
terms (`VX_DISCOUNT_MISMATCH`) → per-redemption cap (`VX_CAP_EXCEEDED`) → under row locks (promotion, code, channel
policy): promotion/code active (`VX_REVOKED`), live window contains the acceptance time (`VX_EXPIRED`), live digest
equals the issued digest (`VX_POLICY_CHANGED`), shared remaining ≥ 1 (`VX_USAGE_EXHAUSTED`). Accepted → exactly one
ordinary `promotion_redemptions` row (channel `pos`, through the normal capacity guard), counters + adjustments
attributed to the promotion. Otherwise → one immutable `offline_voucher_exceptions` row with evidence (observed vs
server remaining, local vs server digest and channel-policy version, snapshot fetch/expiry, redemptions since fetch
by channel, live statuses) and its `voucher` conflict. **In every case the sale, its order total and its tender stay
exactly as the cashier recorded them**; no later charge, no reprice, no approval task.

**Reporting of a contested discount:** it is applied to the order total (order = tender) but is **not** a
redemption, **not** attributed to the promotion (no `order_adjustments`/`promotion_redemptions` row, no counter
move) and appears only as an `offline_voucher_exceptions` row / `voucher` conflict. Promotion usage reports
therefore never count it.

**Credentials (unchanged, HIGH):** the v2 admin assertion is signed with the device key after a local check, so the
server cannot verify that the admin's password was known or bound to this transaction. Credential-gated vouchers are
**never issued** for offline use (the till also refuses any cached row flagged credential-gated, and the server
treats any unissued policy as `VX_SNAPSHOT_INVALID`). The override roster is not sent at bootstrap. The sign-in PIN
verifier was KEK-recoverable (§6.3); **superseded 2026-11-15 by offline PIN v2** (`20261115170000`, device-local OS-sealed verifiers, no server PIN material, KEK retired) — see `docs/pos/offline-pin-v2.md`.

### 13.7 Lease

12 h operator lease, hard maximum 24 h; catalog/voucher/attendance/customer reference data never outlive the
lease (`20261114210000` clamps every new grant: operator ≤ 24 h, catalog ≤ operator, accepted_until ≤ both).
Shared dev (inspected read-only 2026-11-14 night): one enabled register policy, operator 12 h, catalog
**24 h — non-compliant** (grant `accepted_until` is already `least(...)` = 12 h; the clamp is not applied to
shared dev). Production was **not inspected**. Production offline stays disabled until a separately
authorised configuration and acceptance pass.

### 13.8 Disposition of prior work

| Item                                                                     | Shared dev | Disposition                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261114140000` channel pools, `20261114150000` storefront read path    | applied    | **Dormant**: every location `legacy`, enforced gate locked; `20261115150000` forbids leaving `legacy` and revokes `service_role` execute on initialize/allocate                                                                              |
| `20261114160000` stock grants                                            | applied    | **Dormant**: never issued at `legacy`; bootstrap no longer calls issuance; execute revoked                                                                                                                                                   |
| `20261114170000` voucher channel policies/grants                         | applied    | **Dormant**: bootstrap no longer issues voucher grants; execute on issuance revoked; its exception table feeds `voucher` conflicts                                                                                                           |
| `20261112120000` / `20261114180000` offline returns                      | applied    | **Retired**: API answers `OFFLINE_RETURNS_DISABLED` (409) before any DB call; execute on `issue_return_grant` / `record_offline_return` revoked                                                                                              |
| `20261114165000` override passwords v1                                   | applied    | Superseded by v2 storage (pending); offline credential use disabled                                                                                                                                                                          |
| `20261114190000` offline customers + intent scope                        | applied    | **Retained**                                                                                                                                                                                                                                 |
| `20261114200000` override verifier v2                                    | pending    | **Retained** (one-way storage; strictly safer than v1)                                                                                                                                                                                       |
| `20261114210000` lease clamp                                             | pending    | **Retained**                                                                                                                                                                                                                                 |
| `20261115120000` sale reconciliation holds                               | pending    | **Retained** as dependency terminalization (signed sale kept as server evidence + `dependency` conflict); closing a stock grant is no longer a precondition of any bootstrap                                                                 |
| `20261115130000` pending tender                                          | pending    | **Withdrawn** to `supabase/migrations-superseded/` (§13.3)                                                                                                                                                                                   |
| `20261115140000` allocation versions                                     | pending    | **Withdrawn** to `supabase/migrations-superseded/` (stock split only)                                                                                                                                                                        |
| Channel/allocation API, admin-mobile "Stock channels" screen             | —          | API answers `CHANNEL_STOCK_SUPERSEDED` (409) on read, initialise and allocate, before any DB call; the admin-mobile route redirects to Stock and the "split" entry point is gone (the dormant `ChannelSplitScreen` source stays unreachable) |
| POS stock-grant enforcement, voucher-channel panel, offline return panel | —          | Removed from reachable paths (POS local `offline_stock_grant` tables stay, unused)                                                                                                                                                           |

### 13.9 Implementation status and evidence (2026-11-15, uncommitted, nothing applied to shared dev)

| Area              | Change                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration         | `20261115150000_online_first_sync_conflicts.sql` (Part A retire, Part B `pos_sync_conflicts` + detectors, Part C `offline_conflict_ingestions` + `record_offline_conflict`)                                                                                                                                                                                      | `pnpm test:pos:offline:conflicts:persistence` — disposable Postgres, every migration from empty, real commits: **PASS** `ALL_ONLINE_FIRST_SYNC_CONFLICT_ASSERTIONS_PASSED` (P1–P8, R1–R8, L1–L3, I1–I2, D1–D9, T1–T5, C1–C4, S0–S20, O1–O3, V1, M1–M2)                                                                                                                         |
| Critical scenario | shared stock 2 → till bootstraps (snapshot 2) → Website checkout + fulfilment of 2 → stale offline 2-unit sale syncs                                                                                                                                                                                                                                             | S5–S20: sale/order/payment recorded once (`needs_reconciliation`), balance 0 (never negative) = ledger sum, Website order fulfilled once, one `stock_shortfall` conflict (SKU, requested 2, cached 2, canonical 0, short 2, Website order id + `-2` movement), replay returns the original and writes nothing, tampered replay `ID409`; no stock grant / channel bucket exists |
| API               | bootstrap issues no stock/voucher grant or override roster; offline returns `OFFLINE_RETURNS_DISABLED`; channel service `CHANNEL_STOCK_SUPERSEDED`; tender `confirmation: cashier_recorded`; paydown/attendance `syncStatus: conflict_recorded`; `GET /api/v1/pos/sync-conflicts`                                                                                | typecheck 0 errors; unit **450/450** (39 files); OpenAPI drift + structure PASS; real HTTP + packed SDK on isolated `rt-` Supabase: **31/31** incl. X1–X2 (returns refused, no side effect), K1 (paydown preserved, replay identical, AR untouched), K2 (register view, ordering, no PII), K3 (RLS)                                                                            |
| SDK               | **0.36.0** `artifacts/shifted-clothing-commerce-sdk-0.36.0.tgz` sha256 `88d0d7a1cc8bc9b64c2e73a0e3a7b29810fe9787506fc50cf6c22f0c58fe65b0`; `listPosSyncConflicts`; union responses                                                                                                                                                                               | vendored byte-identically in POS and admin-mobile; storefront stays on 0.33.0 (consumes none of the changed shapes; 165/165)                                                                                                                                                                                                                                                   |
| POS               | local schema **v21** `server_sync_conflict_receipt`; stock-grant check/install and close precondition removed; returns refused in the main process + UI action disabled; tender lines "recorded by the cashier on this till (not yet synced)" / "… in the server ledger"; **Sync conflicts** section (server report + connection/pending) above the local review | typecheck/lint/format clean; vitest **317 passed / 4 skipped** (real SQLite) incl. `online-first-conflicts.test.ts`, `ServerSyncConflicts.test.tsx`, local depletion test                                                                                                                                                                                                      |
| Admin-mobile      | **Sync conflicts** screen under Insights (tenant-wide `orders.read`); split route retired                                                                                                                                                                                                                                                                        | typecheck/lint/format clean; vitest **871/871**                                                                                                                                                                                                                                                                                                                                |

**2026-11-15 (later) — §13.6 cached-policy offline vouchers (uncommitted, nothing applied to shared dev, flag off everywhere):**
migration `20261115160000_offline_voucher_cached_policy.sql`; SDK **0.37.0** sha256
`e5a8cb3f0a66c80609686149e36bc5ffc38e5b96daa804eb9a1909a0bf99eab2` (vendored in POS + admin-mobile; storefront unchanged
on 0.33.0); POS local schema **v22**. Evidence: `pnpm test:pos:offline:vouchers-client` real HTTP + packed SDK (POS side) +
disposable `rt-639654c279e345dba04f0c3748f9e01d`: **9/9 PASS** (V1–V9); POS `acceptance:voucher-crash` (Electron 43 runtime,
real SQLite, OS safeStorage): **PASS**; regressions on fresh `rt-` stacks: offline-sale HTTP matrix 31/31, online-first
conflicts SQL PASS, promotions persistence PASS (twice from empty), online checkout 19/19; unit API 452/452, POS 326 (+4
skipped), admin-mobile 872/872. Known gap: adding a cap where none existed does not bump the channel-policy version
(pre-existing `upsert_channel_policy` rule); reconciliation uses the digest, which does detect it.

NOT RUN in this pass: packaged Electron crash/restart against a live server, storefront-to-POS end-to-end UI run,
voucher conflict over HTTP (the D-2 exception table is dormant because no voucher grants are issued; its trigger is
proven in SQL V1), production configuration (not inspected).

### 13.10 Completion pass (2026-11-15 evening, uncommitted, nothing applied to shared dev, nothing enabled)

**Reconciliation.** The pasted brief said offline voucher redemption was "not built"; the code shows it was built in
§13.6 (migration `20261115160000`, POS v22, flag off). This pass hardened and re-proved it rather than rebuilding it.
Shared dev (read-only, `begin read only … rollback`): migration head `20261114190000`; the one enabled register policy
is lease **43200 s / catalog 43200 s** (compliant, unchanged); `staff_offline_pin_credentials` has **0 rows** (purged
earlier with owner approval), while the retired v1 functions `set_offline_pin` / `offline_sell_roster` still exist there
because `20261115170000` is pending. Production was **not inspected**.

| Area                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vouchers (§13.6)                | The till's local integrity hash now binds each cached policy row to its snapshot + lease (`ovp2`); a row copied from another till/lease/business is refused before selling (`VOUCHER_SNAPSHOT_INVALID`). Server reconciliation unchanged.                                                                                                                                                                                                                                                | POS real-SQLite wrong-binding + wrong-tenant tests; HTTP `vouchers-client` **9/9 PASS** (V1–V9, V7 now simulates a compromised till that recomputes the bound hash); Electron `acceptance:voucher-crash` **PASS**                                                                                                                                                                                                                    |
| Credential-gated vouchers       | Unchanged: **BLOCKED**, never issued for offline use                                                                                                                                                                                                                                                                                                                                                                                                                                     | V1, V7                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Offline PIN enrollment          | Till screen **My offline PIN** (every operator); server-verified **step-up** (current sign-in PIN, same lockout, must resolve to the caller) in the enrollment request — token age is not trusted; weak / same-as-sign-in PINs refused in the main process; lockout mirrored into the OS-sealed file; server flag **`POS_OFFLINE_PIN_V2` default off** (enrollment `409 OFFLINE_PIN_DISABLED`, bootstrap lists no authorizations); SDK **0.39.0** (`enrollOfflinePin` requires `stepUp`) | HTTP `pin-v2-client` **9/9** (K1–K9 incl. wrong PIN, foreign credential, missing proof, weak PIN, sealed lockout); Electron `acceptance:offline-pin` **PASS** (real DPAPI: crash between server record and seal leaves nothing usable, weak/same PIN refused before any server call, unlock + lockout across processes, SQLite row deletion does not reset the lock, no PIN in any profile file); API unit + POS unit/renderer tests |
| Grade                           | **PARTIAL** — same-Windows-user malware can unseal the verifier and brute-force a 6–8 digit PIN; offline PIN stays gated off pending an owner decision (options in `docs/pos/offline-pin-v2.md`)                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Retired KEK                     | `readOfflinePinConfiguration` removed: nothing parses `OFFLINE_PIN_KEK` any more (a malformed value can no longer break startup); harness no longer provisions one. Not recreated anywhere                                                                                                                                                                                                                                                                                               | API typecheck/unit; every HTTP suite ran without it                                                                                                                                                                                                                                                                                                                                                                                  |
| v1 PIN cleanup on existing rows | New staged suite plants live v1 ciphertext BEFORE `20261115170000`, then applies it                                                                                                                                                                                                                                                                                                                                                                                                      | `test:pos:offline:pin-v1-cleanup:persistence` **PASS** (C1–C9)                                                                                                                                                                                                                                                                                                                                                                       |
| **Bug fixed** `20261115190000`  | `staff_private.pos_login_record` raised 42702 (ambiguous `failed_count`) on every FAILED connected sign-in, so wrong PINs answered 500 and **the connected sign-in lockout never engaged**. Qualified the column references; behaviour otherwise identical. Same defective body is on shared dev (read-only check) — pending                                                                                                                                                             | SQL S1–S3 in `lease-pin:persistence` **PASS**; HTTP K8                                                                                                                                                                                                                                                                                                                                                                               |
| Lease/catalog bounds            | Unchanged; re-proved                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `lease-pin:persistence` L1–L9, E1–E4 (exact boundary, ±5 min skew), P1–P10                                                                                                                                                                                                                                                                                                                                                           |
| Stock shortfall                 | Re-run; plus F1 (enrollment refused with the flag off)                                                                                                                                                                                                                                                                                                                                                                                                                                   | `shortfall-client` **11/11 PASS**; fulfilment of the Website order still has **no HTTP route, worker or webhook** (`FulfillmentService.createFulfillment` is not wired to any transport) — step 7b exercises `fulfillments_private.record_fulfillment` directly and is **NOT an HTTP claim**                                                                                                                                         |
| Regressions                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | conflicts persistence **PASS**; offline-sale HTTP matrix **31/31**; API unit 454/454; POS 338 (+4 skipped); admin-mobile 872/872; storefront 165/165. `adr042-client` FAILS at harness setup (it seeds the superseded stock split that `20261115150000` forbids) — obsolete suite, pre-existing                                                                                                                                      |

Pending for a separately authorised shared-dev migration window (in order): `20261114200000` … `20261115190000`. The
shared-dev v1 PIN rows are already gone; applying `20261115170000` there only retires the two v1 functions and adds the
v2 enrollment table. `20261115190000` fixes the sign-in lockout and should go in the same window.

### 13.11 Offline PIN: owner decisions and same-PIN model (2026-11-15, later; uncommitted, not activated)

The owner made three decisions:

- **Accept the residual risk ("Accept risk, harden OS").** Malware running as the till's Windows user could read
  or brute-force the locally stored verifier. The feature is not blocked on TPM availability.
- **Login specification = shifted-cafe-v2, as is.** Roster → PIN pad (or keyboard) → sign in; one PIN per
  person (4–8 digits). Offline, the same screen and the **same PIN** open the till.
- **No activation** in production or any shared environment without separate explicit authorization.

What changed:

- **Separate offline PIN removed.** The 6–8-digit separate offline PIN, its "My offline PIN" screen and the
  renderer IPC `offline:enroll-offline-pin` are gone. After each successful online sign-in, the POS main process
  enrols the device-bound verifier of the sign-in PIN. It reuses the server step-up from §13.10 with the
  credential the server just accepted, and skips when the sealed verifier already matches. The lockout, lease
  bound, sealed storage and main-process-only verification are unchanged.
- **Threat model documented accurately** in `docs/pos/offline-pin-v2.md`: the design is not resistant to
  same-user malware. Because the offline PIN is the sign-in PIN, recovering it also reveals the online sign-in
  PIN (still subject to the server lockout fixed by `20261115190000`). Required operating safeguards and incident
  response are listed there.

Evidence (all PASS):

- HTTP `pin-v2-client` 9/9 (K1–K9 rewritten for the same-PIN model);
- Electron `acceptance:offline-pin` (real DPAPI): enrol once, a repeat sign-in does not re-enrol, a crash before
  sealing leaves nothing usable, the same PIN unlocks offline, lockout and tamper hold, no PIN on disk;
- POS 336 passed / 4 skipped, incl. `tests/main/pos-session-manager.test.ts` and the IPC allowlist with no
  enrollment channel;
- API contract and SDK unchanged from §13.10 (0.39.0).

`POS_OFFLINE_PIN_V2` remains unset everywhere except disposable `rt-` test stacks.
