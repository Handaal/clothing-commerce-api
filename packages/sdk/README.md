# @shifted/clothing-commerce-sdk 0.11.0

Version 0.11.0 adds the tenant-scoped staff **assignment catalogs**:
`listAssignableStaffRoles()` and `listAssignableStaffScopes()`. These are the canonical source of the
`roleId` and `accessScopeId` values `assignStaffRole` accepts — do not derive selectable options from
assignments other staff already hold, which returns nothing on a fresh tenant and silently hides
valid-but-unused roles and scopes. Both require a tenant-wide `staff.manage` grant, are read-only
(they create and edit nothing), return the common `{ items, pageInfo }` envelope ordered by name, and
list only the caller's own tenant. The role catalog omits any role carrying a permission the caller
does not already hold tenant-wide; `assignStaffRole` still re-checks that server-side and remains
authoritative. Access scopes are not caller-filtered because a scope only narrows where a role's
permissions apply; explicit scopes carry their existing brand/branch/warehouse/inventory-location
targets with the display name read from the referenced record.

Version 0.10.0 added tenant-scoped `listStaff`, `findEligibleStaffIdentitiesByEmail`,
`getStaffMember`, `createStaff`, `updateStaffStatus`, `assignStaffRole` and `unassignStaffRole`.
Staff mutations take `idempotencyKey`. `findEligibleStaffIdentitiesByEmail({ email })` is an exact
email confirmation lookup, not a directory search, and returns an explicit `0..N` list: with more
than one item the client MUST require explicit selection and MUST NOT silently choose one.
`getContext().access.staff` optionally exposes `{ canRead, canManage }` as UI guidance only.

Version 0.9.0 added tenant-scoped `listSuppliers`, `getSupplier`, `createSupplier`, `updateSupplier`
and `listSupplierReceipts`. Supplier mutations take `idempotencyKey`; update also takes
`supplierId`. Use `updateSupplier({ supplierId, status: "inactive", idempotencyKey })` to deactivate
and `status: "active"` to reactivate. Receipt history also respects `inventory.read` scope.
`receiveInventory` accepts optional `supplierId` and `supplierReference`, preserving existing callers.
`getContext().access.suppliers` optionally exposes `{ canRead, canManage }` as UI guidance only.
The canonical API enforces every permission, scope, lifecycle rule and idempotency decision.

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

## Online checkout (0.7.0)

`client.checkout({ ...intent, idempotencyKey })` accepts typed `CheckoutRequest` guest cart/contact/
delivery intent and returns `CheckoutResult`. Preserve the key and exact intent across retries.
`ApiHttpError.code === "PRICE_CHANGED"` exposes the current total in `details[0].value`; obtain customer
acceptance before changing intent. The result is an immutable placement receipt, not live status.
COD payment stays pending. Management order detail adds optional `commerce` snapshots/payment/holds.
See the API repository `docs/orders/online-commerce-core.md` for deployment/payment boundaries.

## Returns and refunds (0.8.0)

The tenant client exposes `getReturnEligibility(orderId)`, `createReturn({ orderId, lines,
inventoryLocationId?, refundMode?, settlementReference?, idempotencyKey })`, `getReturn(returnId)`,
`listReturns(orderId, { limit?, cursor? })`, and `settleRefund({ returnId, settlementReference,
idempotencyKey })`. The SDK exports their input/response types plus `Refund` and `OrderReturnSummary`.
Order detail has an optional `returns` summary, present only with authorized return-read access.

Use original `orderLineId` values from eligibility. Supply quantities, reasons and explicit
`restock` / `non_restock` dispositions; the API derives every monetary amount. Preserve the exact
intent and key across retries. Default `refundMode` is `pending`; `manual_confirmed` records an
authorized attestation that cash was actually paid and requires a settlement reference. It never
settles an electronic payment. Both refund initiation and manual settlement require API permission.

Returns require fulfilled merchandise and captured payment; unpaid COD is rejected. For policy,
atomicity, staged electronic integration and error codes, see `docs/returns/returns-refunds-core.md`
in the API repository. No server secret, provider SDK or database client is bundled.
