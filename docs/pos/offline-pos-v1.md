# Offline POS V1 authority and ingestion

## Boundary

Phase 2I adds server/API/SDK support for offline cash sales. It does not add Electron key generation,
SQLite, a cashier UI, card tender, or a general replication framework. `POST /api/v1/pos/sales`
remains the connected, current-price/current-stock, fully human-authorized atomic checkout without any
weakened rule.

## Trust and enrollment

An authorized human enrolls a local installation at `POST /api/v1/pos/devices`. The device creates an
Ed25519 keypair and sends only its DER SPKI public key (`spki_der_base64`). The server binds the device
to one tenant and one register. A fingerprint cannot be enrolled twice. Credential rotation preserves
the old credential interval so an event signed before rotation remains verifiable; revocation closes
the current interval and blocks new grants. Private keys and real device keys are never fixtures,
server configuration, database data, logs, OpenAPI examples, or SDK artifacts.

Enrollment, rotation, revocation, and bootstrap require the complete existing connected-sale
permission set over the register branch and inventory location. The route resolves human identity via
Clerk as usual. Ingestion does not require that browser session: it resolves the persisted grant and
credential, verifies the device signature, then uses only grant-derived tenant/register/branch/location,
operator, currency, policy, and price facts.

## Policy, leases, and clock trust

`offline_pos_policies` is register-scoped. No row, or `enabled=false`, fails closed. A policy configures:

- operator and catalog/grant durations;
- maximum sale and cumulative exposure in the register currency's minor units;
- maximum quantity per line; and
- maximum pending offline sale ordinal.

There are no universal currency limits. The local development fixture uses a 12-hour operator lease,
a 24-hour catalog lease, 100000 minor units per sale, 500000 cumulative minor units, 20 units per line,
and 50 pending sales. These are fixture configuration, not schema defaults.

The server persists `issuedAt`, `operatorExpiresAt`, `catalogValidUntil`, and the effective
`acceptedUntil` (the earlier expiry). Only one active device may receive offline authority for an
inventory location at a time; issuance uses a transaction-scoped location lock. `acceptedAt` is a
device-observed time, not trusted wall-clock truth. It must fall in the grant window (with at most five
minutes of early skew) and cannot be more than five minutes ahead of server receipt. Expiry blocks new
local acceptance; it never invalidates a sale legitimately accepted inside the window and synchronized
later.

## Immutable grant and price authority

`POST /api/v1/pos/offline-bootstrap` returns and stores one immutable complete snapshot for the device
and register. It includes product/variant identity and status, SKU/options summary, exact authorized
minor-unit price, price record ID/version, and advisory inventory quantity/version/as-of. Inventory is
advisory; the price record in the grant is authoritative.

The client must sell only snapshot variants and copy `priceId` and `authorizedUnitPriceMinor` into the
signed command. Ingestion validates them against the stored grant, not the current catalog. Therefore a
sale accepted at 2599 remains 2599 after the active catalog price changes. This is deliberately separate
from connected `PRICE_CHANGED` behavior.

## Signing representation

The device signs the UTF-8 bytes returned by SDK `canonicalizeOfflineSaleCommand(command)` using
Ed25519. The representation is the Phase 2I safe-integer subset of RFC 8785 canonical JSON:

1. validate the exact `OfflineSaleCommand` schema (unknown properties are rejected);
2. retain array order;
3. sort every object key by Unicode code-unit lexical order;
4. serialize strings, booleans, null, and safe integers with ECMAScript `JSON.stringify`; and
5. emit no whitespace or trailing newline.

The command covers schema version, local sale ID, stable `syncCommandId`, grant/device/register,
accepted time, currency, ordered lines with exact grant price provenance, total, cash received, change,
offline ordinal, and cumulative exposure. `Idempotency-Key` must equal `syncCommandId`. The signature is
standard base64. Any payload change invalidates the signature.

## Ingestion and reconciliation

`POST /api/v1/pos/offline-sales` means “this cash sale was already accepted offline under issued
authority.” It is not checkout authorization. Within one transaction it always creates one canonical
POS Order and captured Cash Payment after authority validation.

- If locked authoritative balances cover every line, it also creates one full Fulfillment and one
  append-only inventory issue, returning `synced`.
- If stock is specifically insufficient, it creates no Fulfillment, never creates negative inventory,
  opens one `insufficient_stock_at_ingestion` reconciliation and history event, and returns
  `needs_reconciliation`.
- A correctly signed queued sale accepted before device revocation is not discarded. It creates the
  canonical Order and Payment but performs no inventory issue; it opens
  `device_revoked_at_ingestion` reconciliation for governed recovery.

Unexpected constraint or database errors roll the transaction back. Resolution actions are deferred;
the durable reconciliation row and append-only event prevent silent resolution.

## Replay retention and limits

The tenant/sync-command mapping, canonical command, SHA-256 fingerprint, signature, grant/price
provenance, and canonical entity IDs are durable and have no automatic deletion policy. The minimum
supported offline queue replay window is 365 days; current storage is indefinite. Exact replay returns
the same ingestion, Order, Payment, optional Fulfillment, reconciliation, and inventory effect. Same
identity with different intent returns `IDEMPOTENCY_CONFLICT`.

Enrollment, rotation, revocation, and grant issuance also persist their required header key and a
complete intent fingerprint. Exact retries return the original device/credential/grant; reuse with a
different intent is a conflict. Transaction-scoped advisory locks serialize concurrent same-key calls.

The server revalidates per-sale amount, line quantity, cumulative exposure, and sale ordinal. A POS
native process must maintain ordinal/exposure counters durably and expose signing only after enforcing
the same grant rules; renderer-only enforcement is not a trust boundary.

## Responsible files, testing, and limitations

- Contracts/canonicalization: `src/contracts/pos.ts`, `src/contracts/offline-signing.ts`
- Domain/repository: `src/pos/offline-*`, `src/pos/supabase-offline-pos-repository.ts`
- HTTP: `app/api/v1/pos/devices`, `offline-bootstrap`, and `offline-sales`
- Persistence/RLS: `supabase/migrations/20260906120000_create_offline_pos.sql`
- SDK: `packages/sdk`

Run `pnpm test:pos:offline:integration` for the real boundary, then the full repository matrix in
`docs/development/testing.md`.

Offline returns (ADR-041 Decision A; migration `20261112120000_offline_returns.sql`, routes
`offline-return-grants` + `offline-returns`) have two real-server suites, each on its own disposable
`rt-<hex>` stack via `scripts/test-offline-pos-http-isolated.mjs`:

- `pnpm test:pos:offline:http`: cases R0–R8 with commands built in this repo (grant freeze, PENDING
  refund with stock unchanged, idempotent replay + 409, binding/schema/quantity rejects, drift →
  reconciliation, tampered signature, RLS).
- `pnpm test:pos:offline:returns-client`: a **cross-repo** suite (`tests/pos-client-returns-http`) that
  loads the POS repo's compiled main-process modules (`clothing-commerce-pos/dist-electron/main/offline`,
  using the POS's own vendored SDK) and drives the real client lane: POS enrollment + bootstrap, a POS
  sale synced by the POS worker, a POS-fetched return grant, offline capture, sync to a PENDING refund
  with stock untouched, exact replay, concurrent-return drift → `needs_reconciliation`, and connected
  settlement afterwards. Prerequisite: a sibling POS checkout with `pnpm build:main` run (override the
  path with `POS_REPO_DIR`). For that run only, the runner grants `returns.create`, `returns.read` and
  `payments.refund` to the seeded POS role (the same grant as `phase_2m_returns.setup.sql`) so the
  connected steps are authorized; the default matrix's fixture is unchanged. It is excluded from
  `pnpm test` because it needs the harness environment. Troubleshoot `OFFLINE_DISABLED` by checking the register policy,
  lease conflicts by checking active unexpired grants at the location, signature failures by comparing
  the canonical UTF-8 bytes and credential ID, and reconciliation by inspecting its immutable ingestion
  and history event. V1 deliberately has no multi-terminal stock coordination, incremental catalog feed,
  remote clock attestation, or reconciliation resolution workflow.

## Offline operation intents with automatic server disposition (all-desks lane)

Migrations `20261114120000_offline_operation_intents.sql` (lane) and
`20261114130000_offline_intent_auto_adjudication.sql` (automatic disposition), route
`POST /api/v1/pos/offline-intents`, SDK **0.31.0** `ingestOfflineIntent` / `canonicalizeOfflineIntentCommand`.

- **Owner rule (2026-11-14): no human/admin/manager approval.** The superseded design stored every intent
  `pending_review` for a person. There is now no pending state and no approval queue, endpoint or screen.
- **What happens on sync:** `offline_pos_private.record_offline_intent` performs the authority checks below,
  then calls the typed dispatcher `adjudicate_intent` and inserts the immutable command **together with its
  final machine disposition** in one transaction:
  - `applied` (`OIA_*`): a typed handler committed the business effect through the existing hardened domain
    function (stock via `inventory_private.record_operation`, idempotency key `offline-intent:<syncCommandId>`;
    self-revocation via `offline_pos_private.revoke_device`);
  - `rejected` (`OIX_OVER_LIMIT`, `OIX_SCOPE_DENIED`, `OIX_UNKNOWN_VARIANT`, `OIX_NO_LOCATION_SCOPE`,
    `OIX_KIND_RETIRED`): never applied;
  - `needs_reconciliation` (`OIX_INSUFFICIENT_STOCK`, `OIX_STALE_BASE`, `OIX_NO_BASE_VERSION`,
    `OIX_VARIANCE_OVER_LIMIT`, `OIX_DEPENDENCY_NOT_APPLIED`, `OIX_DEVICE_REVOKED`, `OIX_LEDGER_REFUSED`):
    conflict with canonical state; no side effect (ledger writes run in a rolled-back subtransaction);
    evidence kept for operator reconciliation at the till;
  - `blocked_policy` (`OIP_POLICY_NOT_CONFIGURED`, `OIP_POLICY_INVALID`, `OIP_HANDLER_NOT_IMPLEMENTED`):
    fails closed; no side effect.
    Exact replay returns the original disposition (no second effect); a per-sync-id advisory lock serializes
    concurrent duplicates; competing tills serialize on the stock key (`lock_balance_for_offline_sale`).
- **Typed handlers:** `inventory.receive` (policy `maxQuantity`), `inventory.adjust` (`maxAbsDelta`; never
  below zero on-hand), `inventory.count` (`maxAbsVariance`; applies only when `baseVersion` equals the current
  `inventory_balances.version`, else `OIX_STALE_BASE`), `settings.device_revoke_request` (self only).
  `review.resolution_request` is retired (always `rejected`). All other kinds have no handler yet
  (`blocked_policy`). Client JSON never addresses a table; handlers read only schema-validated fields.
- **Policy:** `offline_pos_policies.offline_intent_operations` (transport opt-in, default `{}`; unlisted ⇒
  `OI403`, no row) and `offline_pos_policies.offline_intent_handler_policies` (default `{}`; per operation
  `{"version": "...", <limits>}`). Every limit must be supplied by the owner's policy; no migration ships a
  default limit, so nothing is applied anywhere until the owner configures it.
- **Authority checks (unchanged):** grant exists and binds device, register and operator; schema version;
  `acceptedAt` inside the grant window ± 5 min; credential valid at acceptance; register opt-in
  (`OI403` → 403); `dependsOnSyncCommandId` must already be received from the same device (`OI424` → 409,
  transient, retried); changed intent under the same key → `ID409` / 409. These transport failures store
  nothing.
- **Response:** `intent: { operation, disposition, code, policyVersion, decidedAt, detail }` — `detail` is an
  allowlisted set of safe evidence fields (ids, quantities, versions); never PII, keys or signatures.
- **Tests:** `pnpm test:pos:offline:http` cases I0–I10 and A1–A9 (apply, over-limit reject, no-oversell
  conflict, count apply/no-op, stale base, variance limit, non-applied dependency, retired kind, competing
  tills + duplicate delivery, self-revocation then fail-closed); `pnpm test:pos:offline:intents-client`
  (cross-repo, loads the POS's compiled modules, needs `pnpm build:main` in the POS checkout);
  `pnpm test:pos:offline:rls` (plan 11: 13 hardened writer-owned functions; internal handlers callable by
  nobody, not even `service_role`; disposition CHECK has no pending value). The HTTP runner configures
  per-run **test-only** handler policies and a never-stocked fixture variant on its disposable database.

## ADR-042 follow-up (2026-11-14): admin credentials v2, lease hard bound, retired intents

- **Override password verifier v2** (`20261114200000`): the server keeps only `scrypt(password, salt)`
  (N = 2^15); no ciphertext, no KEK involvement, plaintext unrecoverable. Bootstrap sends
  `HMAC-SHA256(verifier, "pos-override-v2" ‖ deviceId ‖ membershipId ‖ verifierVersion)` + salt + cost; the
  till recomputes it from the typed password in the main process. Code: `src/pos/override-password-crypto.ts`
  (must match POS `src/main/offline/override-roster.ts`). Rotation: v1 sealed rows were wiped and bumped;
  admins set their password again (PUT `/api/v1/pos/override-password`, PIN re-auth). Tests: phase_3d P1–P11,
  `tests/pos/offline-adr042-service.test.ts`, `pnpm test:pos:offline:adr042-client` O1–O4.
- **Lease hard bound** (`20261114210000`): every new offline grant is clamped (operator ≤ 24 h, catalog ≤
  operator, accepted ≤ both) by a trigger; `offline_pos_private.lease_policy_violations` lists policy rows
  outside the bounds. Settings rows are never rewritten by the migration; fix each row, then
  `VALIDATE CONSTRAINT offline_pos_policies_lease_bounds`.
- **Offline PIN v2** (`20261115170000`): KEK-sealed manager-set PINs are retired; staff enrol their own offline PIN per device while online. `OFFLINE_PIN_KEK` is no longer used. Full design, threat model and re-enrollment checklist: [offline-pin-v2.md](offline-pin-v2.md).
- **Cached-policy offline vouchers** (ADR-042 §13.6, `20261115160000_offline_voucher_cached_policy.sql`):
  - Purpose: let a till redeem an EXISTING voucher during an outage without reserving or splitting the shared limit.
  - Configuration: server env `POS_OFFLINE_CACHED_VOUCHERS` — **default off**; only the exact value `enabled` issues
    policies at bootstrap. Per voucher, a `pos` channel policy with `offlineEnabled: true` and
    `requiresAdminCredentials: false` (set through `PUT /api/v1/promotions/{id}/channel-policies/pos`). Vouchers with
    a brand restriction, automatic activation or non-%/fixed benefits are never issued (online-only).
  - Flow: bootstrap → `promotions_private.issue_offline_voucher_policies` (immutable
    `offline_voucher_policy_issuances`, once per lease) → till caches in `offline_voucher_policy` (v22) → offline sale
    echoes `policyIssuanceId` + `policyDigest` in the signed command → `record_offline_sale` →
    `promotions_private.redeem_offline_voucher_cached` → one ordinary redemption, or an `offline_voucher_exceptions`
    row (`VX_SNAPSHOT_INVALID | VX_EXPIRED | VX_DISCOUNT_MISMATCH | VX_CAP_EXCEEDED | VX_REVOKED | VX_POLICY_CHANGED
| VX_USAGE_EXHAUSTED`) + `voucher` conflict. The sale/tender never change.
  - Safe modification: any new term that changes the discount must be added to BOTH `offline_voucher_cached_terms` /
    `offline_voucher_policy_digest` (server) and the POS `ov1` formula (`voucher-discount.ts`), with a new
    calculation version; otherwise keep the voucher online-only.
  - Tests: `pnpm test:pos:offline:vouchers-client` (real HTTP, disposable `rt-` stack, V1–V9); POS
    `tests/offline/voucher-cached-policy.test.ts`; POS `pnpm acceptance:voucher-crash` (Electron runtime crash/restart).
  - Troubleshooting: no `voucherPolicies` in the bootstrap ⇒ flag off, or no voucher passes the gates above. Till
    `VOUCHER_LOCAL_LIMIT_REACHED` ⇒ this till's unsynced uses reached the last-known shared remaining; sync, then
    re-bootstrap. A `VX_SNAPSHOT_INVALID` conflict means the till sent a policy the server never issued to that lease.
  - Production: flag unset (off); not enabled anywhere.
- **Cross-repo acceptance**: `pnpm test:pos:offline:adr042-client` (stock grant + vouchers at an enforced
  location with the gate unlocked on its disposable DB only, offline new customer → installment, admin
  credentials). Requires `pnpm build:main` in the POS repo.
- Troubleshooting: a re-bootstrap refused with "offline sales for this grant are not all synchronized" means a
  sale ordinal never reached the server (e.g. a sale the till holds because its new customer was rejected —
  ADR-042 §12.1 Finding A).
