# @shifted/clothing-commerce-sdk 0.5.0

TypeScript-first, fetch-based SDK for browsers, Electron renderers, and Expo/React Native. Create a
client with a configurable API base URL and optional `type`/`version` metadata, then call
`getHealth()`. Responses are validated and failures use exported typed error classes.

The package is built and released only from `clothing-commerce-api`. It contains no Node-only
runtime dependency.

Version 0.5.0 preserves `client.withTenant(tenantId).getPosContext()` and
`createPosSale({ idempotencyKey, registerId, expectedTotalMinor, cashReceivedMinor, lines })`.
The SDK supplies `X-Tenant-Id`, calls the configured `getToken`, and sends the key only as the
`Idempotency-Key` header. See `docs/pos/connected-pos-sale-v1.md` in the API repository for atomicity,
cash-only tender, price-change, tax, and authorization semantics.

It additionally exposes `enrollPosDevice`, `rotatePosDeviceCredential`, `revokePosDevice`,
`createOfflineBootstrap`, `ingestOfflineSale`, the associated strict types, and
`canonicalizeOfflineSaleCommand`. The POS generates and retains its Ed25519 private key locally. Sign
the exact UTF-8 canonical string and send the standard-base64 signature; the SDK never receives a
private key. See `docs/pos/offline-pos-v1.md` for grant, expiry, replay, historical-price, revocation,
and reconciliation semantics.
