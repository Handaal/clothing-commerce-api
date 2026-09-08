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
`docs/development/testing.md`. Troubleshoot `OFFLINE_DISABLED` by checking the register policy,
lease conflicts by checking active unexpired grants at the location, signature failures by comparing
the canonical UTF-8 bytes and credential ID, and reconciliation by inspecting its immutable ingestion
and history event. V1 deliberately has no multi-terminal stock coordination, incremental catalog feed,
remote clock attestation, or reconciliation resolution workflow.
