# @shifted/clothing-commerce-sdk 0.30.0

Version 0.30.0 adds `createStaffWithoutLogin`, payroll-cycle settings/due/payment methods,
`getPosAvailability(registerId)`, optional team `membershipId` on signed offline attendance
commands, and the `applied` attendance response status. The packed artifact is produced by
`pnpm sdk:pack` and vendored into the POS. Register availability requires the same scoped selling
permissions as a POS sale; it does not require the cashier to hold management `inventory.read`.

Version 0.19.0 adds supplier purchase money, standalone due-settlement payments, server-computed
dues, and payment-reminder CRUD. `recordSupplierPurchase` atomically records one multi-line clothing
variant receipt plus immutable minor-unit supplier cost facts. Those costs are AP/history data only;
they do not establish inventory valuation, FIFO/weighted costing, or COGS. Purchases use the tenant
default currency, payments cannot create supplier credit, and purchase history presents standalone
payments oldest-first without canonically allocating a payment to an invoice.

Version 0.12.1 adds optional `getContext().access.promotions` UI guidance with independent
`{ canRead, canManage }` booleans derived from effective tenant-wide `promotions.read` and
`promotions.manage` grants. The guidance does not authorize an operation; Promotion endpoints still
enforce permissions and scope server-side. The field is optional so payloads from older API deployments
remain parseable.

Version 0.12.0 added Storefront/POS quote operations, optional promotion-code sale intent, and
tenant-scoped Promotion and code management methods. Pricing and eligibility remain server-authoritative.

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

Website/POS stock channels (ADR-042, SDK 0.32.0): `getInventoryChannels({ inventoryLocationId })`,
`initializeInventoryChannels({ inventoryLocationId, idempotencyKey })` and
`allocateInventoryChannels({ inventoryLocationId, reason, lines, idempotencyKey })`, where each line is
`{ variantId, websiteQuantity, posQuantity, expectedBalanceVersion? }`. Reads need `inventory.read` and
changes need `inventory.adjust` over the location. See `docs/inventory/inventory-channels.md`.
`getContext().access.suppliers` optionally exposes `{ canRead, canManage }` as UI guidance only.
The canonical API enforces every permission, scope, lifecycle rule and idempotency decision.

Offline POS scope (ADR-042, SDK 0.33.0):

- `createOfflineBootstrap` takes an optional `closePreviousGrant: { offlineGrantId, finalSaleOrdinal }` and
  returns `stockGrant` (null at a legacy location), `voucherGrants` and `overrideRoster`.
- Offline sale commands may carry `voucher` (with an optional one-use `adminAssertion`); offline return commands
  may carry `adminAssertion`; return grants report `requiresAdminCredentials`.
- `ingestOfflineCustomer` (`canonicalizeOfflineCustomerCommand` for signing): a new customer captured offline.
- `setPosOverridePassword` (self, re-enter username + PIN) and `clearStaffOverridePassword` (staff.manage).
- Voucher channel policies: `getPromotionChannelPolicies`, `upsertPromotionChannelPolicy`,
  `upsertPromotionCodeChannelLimit`, and the `listOfflineVoucherExceptions` report.

Offline PIN v2 (SDK 0.38.0): `enrollOfflinePin({ deviceId, registerId, idempotencyKey })` (no PIN is sent; the till
seals a device-bound verifier itself) and `revokeOfflinePinEnrollments({ membershipId?, deviceId?, reason,
idempotencyKey })`. Bootstraps carry `offlinePinAuthorizations`; `staffRoster` is retired and `setStaffOfflinePin` answers
`409 OFFLINE_PIN_REENROLLMENT_REQUIRED`. See `docs/pos/offline-pin-v2.md`.

SDK 0.39.0 (breaking for this one call): `enrollOfflinePin` requires `stepUp: { username, pin }` — the caller's
OWN POS sign-in credential, re-verified by the server in the same request (freshness does not rely on token age).
Same-PIN model: the POS calls it from its main process right after a successful sign-in, and the offline unlock
PIN is that sign-in PIN; nothing derived from it is stored server-side. The server answers `409 OFFLINE_PIN_DISABLED`
unless `POS_OFFLINE_PIN_V2=enabled`, and `401 OFFLINE_PIN_STEP_UP_FAILED` for a wrong or foreign credential.

SDK 0.41.0 (ADR-043 §5.1, additive): `OfflineSaleCommand` gains optional `unlockedByMembershipId` — the person
operating the till when the sale was accepted, stamped by the till's main process and covered by the device
signature. Omitted ⇒ canonical form unchanged. The server verifies it against that device's PIN enrollments at
acceptance time, records the attribution, and reports `OFFLINE_OPERATOR_UNVERIFIED` /
`OFFLINE_OPERATOR_CHANGED_BEFORE_SYNC` as `sync_integrity` sync conflicts. Deploy the server before tills send it.

SDK 0.45.0 (additive; needs migration `20261119130000_storefront_delivery_fees`): delivery fees per area.

- `getStorefrontDeliveryOptions({ tenantId, brandId })` (public) → active zones (`code`, `name`, `feeMinor`)
  and `freeDeliveryThresholdMinor`. Empty zones = free delivery, no zone needed.
- `quote` accepts `zoneCode`; the response gains `delivery` (`required`, `feeMinor` — null until a zone is
  chosen, `zone`, `freeDeliveryThresholdMinor`, `freeApplied`). `totalMinor` includes a known fee.
- `checkout`: `delivery.zoneCode` is required when the brand has zones (`DELIVERY_ZONE_UNAVAILABLE`
  otherwise); `expectedTotalMinor` includes the fee; the result adds `deliveryFeeMinor` and `deliveryZone`.
- Orders: list items gain `deliveryFeeMinor`; online order detail `commerce.deliveryFeeMinor` (the fee is included in `totalMinor`).
- Settings: `getStorefrontDeliverySettings(brandId)` / `updateStorefrontDeliverySettings({ brandId,
idempotencyKey, freeDeliveryThresholdMinor, zones })` (replace-all; settings.read / settings.manage).

SDK 0.44.0 (additive; needs migration `20261119120000_catalog_options_categories_storefront`): structured
product options and categories for the Storefront.

- Public products gain `options` (`[{ name, values: [{ value, swatchHex }] }]`, only values a listed variant
  uses), `categories` (`[{ id, slug, name }]`) and per-variant `optionValues` (`[{ name, value }]`). All
  optional in the schema, so older payloads still parse.
- `listStorefrontCategories({ tenantId })` → the public category tree (`parentId`, `productCount` including
  descendants); only active categories with visible products.
- Management: `createVariant({ ..., options })` creates a variant with its option values atomically;
  `setVariantOptions` replaces a variant's selection (`VARIANT_OPTIONS_CONFLICT` when another variant has
  it); `updateOptionValues` sets swatch colours (#rrggbb) and order.
- Categories: `listCategories`, `createCategory`, `updateCategory` (`CATEGORY_CYCLE` when moved under
  itself), `setCategoryStatus` (archiving hides the branch publicly), `setProductCategories`. All need
  `catalog.author` tenant-wide.
- `ProductDetailResponse` gains optional `categoryIds`, option-value `swatchHex`/`position` and per-variant
  `optionValues` (`{ optionId, valueId }`).

SDK 0.43.0 (additive; no migration): staff operations on **online** orders.

- `fulfillOrder({ orderId, idempotencyKey, lines: [{ lineNumber, quantity }] })` → refreshed
  `OrderDetailResponse`. Needs `orders.fulfill` (order brand) + `inventory.issue`. The server takes the stock
  from the location the order's reservations hold; the client never picks a location. POS orders →
  `ORDER_CHANNEL_UNSUPPORTED`.
- `cancelOrder({ orderId, idempotencyKey, reason? })` → refreshed detail. Needs `orders.cancel`; releases the
  reservations; refused with `ORDER_ALREADY_FULFILLED` once anything has shipped; re-cancelling replays.
- `MeContextResponse.access.orders` gains optional `canFulfill` / `canCancel` (UX guidance only).

SDK 0.42.0 (additive; needs migration `20261118140000_promotion_full_edit_and_delete`):

- `updatePromotion` accepts every setting at any time — `benefitType` (with the new type's fields),
  `benefitCurrency`, `buyQuantity`/`getQuantity`, `globalRedemptionLimit`, `activationType`, `targetType` and
  `targets` (replaces the selection). The edit-after-redemption lock is gone; past orders keep the discount they
  were granted. `economicsLocked` stays in the projection and now only means "has been redeemed".
- `deletePromotion(id)` → `{ promotionId, outcome: "deleted" | "archived" }`. Never-used promotions are removed
  with their codes/targets; used ones are archived (permanently inactive, codes disabled, hidden from management).
- `PromotionDetail.targets[]` gain optional `productName`, `variantName`, `sku`.
- Shared management form rules (`validatePromotionForm`, `buildCreatePromotionRequest`,
  `buildUpdatePromotionRequest`, `promotionToForm`, `validateSaleForm`, `validateContentForm`, parsers, …) used by
  Admin Mobile and the POS. Validators return language-neutral `FormIssue` codes; each app supplies the wording.

SDK 0.40.0 (ADR-043, wire-compatible): every POS PIN field (`posPinLogin`, `createPosLogin`, `setPosLoginPin`,
override-password re-auth, `enrollOfflinePin` step-up) follows one rule — ASCII digits only, at least 4, **no
maximum** (the retired 4–12 / 1–64 bounds are gone; nothing truncates). Credential-carrying POS routes refuse a
body over 16 KiB with `413 PAYLOAD_TOO_LARGE` (a transport ceiling, not a PIN rule). Demoting or deactivating the
tenant's last active POS admin answers `409 LAST_POS_ADMIN`, and a PIN reset revokes that member's offline-PIN
enrollments (re-enrolled at their next online sign-in). See `docs/decisions/ADR-043-*.md`.

Cached-policy offline vouchers (ADR-042 §13.6, SDK 0.37.0):

- `createOfflineBootstrap` may return `voucherPolicies: OfflineVoucherPolicy[]` — the cached policy of each existing
  voucher usable offline on that lease (only when the server runs with `POS_OFFLINE_CACHED_VOUCHERS=enabled`).
  It reserves nothing: `observedRemaining` is the SHARED remaining usage at fetch time (null = unlimited). No raw
  code is sent, only `codeFingerprint = sha256hex(tenantId + ":" + NORMALIZED_CODE)`.
- `OfflineSaleCommand.voucher` is a union: the cached form `{ policyIssuanceId, promotionId, codeId, policyDigest,
observedRemaining, discountTotalMinor }` or the superseded reserved-grant form (still accepted from older tills).
  The sale always stands at the cashier price; the server records one redemption or a `voucher` sync conflict.

TypeScript-first, fetch-based SDK for browsers, Electron renderers, and Expo/React Native. Create a
client with a configurable API base URL and optional `type`/`version` metadata, then call
`getHealth()`. Responses are validated and failures use exported typed error classes.

The package is built and released only from `clothing-commerce-api`. It contains no Node-only
runtime dependency.

Staff management in local 0.30.0 includes `updateStaffProfile` for tenant-scoped name, position,
and phone, with an idempotency key. It does not change the linked global login identity.

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

## Operational settings (0.14.0)

The tenant client exposes the operational-settings surface (tenant-wide; reads require
`settings.read`, writes `settings.manage`): `getBusinessSettings` / `updateBusinessSettings`;
`listBrands` / `getBrand` / `createBrand` / `updateBrand`; `listBranches` / `getBranch` /
`createBranch` / `updateBranch` / `setBranchBrands`; `listWarehouses` / `getWarehouse` /
`createWarehouse` / `updateWarehouse`; `listInventoryLocations` / `getInventoryLocation` /
`createInventoryLocation` / `updateInventoryLocation`; `listRegisters` / `getRegister` /
`createRegister` / `updateRegister`; `listStorefrontSettings` / `getStorefrontSettings` /
`upsertStorefrontSettings`; `getReturnSettings` / `updateReturnSettings`; and device governance
`listDevices` / `getDevice` / `revokeDevice` / `assignDevice`. `getContext().access.settings`
carries independent `{ canRead, canManage }` UI guidance.

The server enforces every mutation-safety rule: tenant `slug`/`status` are read-only and
`defaultCurrency` locks once orders exist; brand/branch/warehouse/register `code` and an inventory
location's parent + `locationType` are immutable after creation; register `sellingCurrency` and a
storefront's `currency` lock once the first POS / online order exists; deletion is lifecycle-only
(activate/deactivate/archive). Device private-key material is never exposed — enrollment and key
rotation stay device-side. The canonical POS context (`getPosContext`) now carries server-owned
`business.tenant` and per-register `branch` identity (incl. tax identifier and receipt footer) for
receipt rendering. See `docs/settings/operational-settings-core.md` in the API repository.

## Storefront merchandising (0.29.0)

Additive MINOR. Tenant client: catalog sales `listSales` / `getSale` / `createSale` / `updateSale` /
`setSaleStatus` / `deleteSale` (`promotions.read` / `promotions.manage`); home-page content
`getStorefrontContent` / `updateStorefrontContent` / `createStorefrontHeroImageIntent`
(`catalog.author`). Public client: `getPublicStorefrontContent({ tenantId, brandId? })`.

Contract changes: `PublicProductPrice.compareAtAmountMinor` (optional, original price while on sale;
`amountMinor` is the price actually charged online); `PublicProduct.offers` (optional live Buy-X-Get-Y
offers); `PromotionBenefitType` gains `"buy_x_get_y"` with `buyQuantity` / `getQuantity` on create and
detail (online-only). See [storefront merchandising](../../docs/catalog/storefront-merchandising.md).
