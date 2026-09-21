# Complete V1 Scope Backlog (corrected)

This is the durable, authoritative backlog for the **nearly-complete, client-ready V1** of the
Clothing Commerce Platform. It exists to prevent scope loss across parallel Codex/Claude batches. It
is not an MVP-reduction list: every "required" item below is an agreed client requirement and must be
built before formal client acceptance testing, even if no repository currently represents it.

A prior read-only audit omitted several agreed modules (Suppliers, Staff management, Vouchers). Those
omissions are corrected here and must remain visible in every future planning pass.

## Authoritative platform framing

- Clothing-brands commerce platform; **multi-brand, multi-branch, one shared database**.
- POS and Storefront **share the same physical inventory truth** (one `InventoryLocation` model). No
  channel-private stock.
- **Storefront is a real online sales channel**, not a marketing/catalog site. It must eventually
  support the full online-commerce journey (browse â†’ cart â†’ checkout â†’ payment â†’ order â†’ status).
- **Admin Mobile is management-only** for the business owner / authorized managers. It is not a
  cashier/selling/POS app and not a Shifted platform super-admin. It manages/monitors the business,
  **including the website catalog**. It does **not** edit the Storefront's visual design/layout.

## Frozen architectural invariants (unchanged)

One commerce core Â· Product/Variant shared across channels Â· inventory belongs to physical
`InventoryLocation` Â· Order is the canonical sale Â· POS and ONLINE are channels Â· Tenant != Brand Â·
Branch != Warehouse Â· Register != InventoryLocation Â· Device != Register Â· UserIdentity != Membership
Â· Role != Permission != Scope Â· `service_role` is DB transport only Â· server is authoritative for
authorization Â· clients consume the packed SDK (never API source) Â· API owns OpenAPI + SDK Â· no
role-name authorization bypasses Â· no mocks hiding failures Â· single-brand tenants are not forced
through brand-switcher UX.

## Status legend

Complete Â· Partial Â· Foundation-only Â· Missing. "Foundation exists" never means "feature works
end-to-end."

## Backlog

### Done / backend-ready (context only â€” not this batch)

- Auth, tenant bootstrap/context, memberships/roles/permissions/scopes (backend), device trust.
- Organization model + management reads.
- Catalog **read** + full catalog **schema** (products/variants/options/SKU/pricing/categories/collections).
- Inventory ledger + receive/adjust/transfer/issue + read; advisory offline snapshots.
- Canonical Orders (placed/cancelled), channel model, fulfillment, POS connected + offline authority.
- POS offline durability (POS repo, Codex PR2) and offline sync (Codex PR3, in progress â€” **not ours**).

### Completed catalog foundation (Phase 2J â€” Catalog management + Storefront publication, API + SDK)

- Catalog **write**: product create/update/lifecycle (draftâ†’activeâ†’archived), variant create/update,
  option/value management, SKU integrity, price set/change.
- **Storefront publication boundary**: distinguish internal catalog state from publicly sellable.
- **Product media**: image metadata + object-storage reference (not binaries in Postgres).
- **Public (Storefront-safe) catalog read**: published products/variants/price/media/taxonomy only.
- OpenAPI + SDK `0.6.0`.

### Current API vertical (Phase 2L)

Guest Customer/address and immutable delivery snapshots, canonical online checkout, shared ATS
reservations, pending COD Payment behind explicit server enablement, management order visibility,
OpenAPI and SDK 0.7.0. See [online commerce core](../orders/online-commerce-core.md).
Storefront catalog/product detail/variant selection/persistent cart, Admin catalog, and POS connected
and offline/sync are completed client work; this phase does not modify those repositories.

### Required for V1, not yet built (future batches â€” DO NOT LOSE)

| Domain                                                                | State                         | Notes / unresolved decisions to freeze later                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Customers**                                                         | Core implemented              | Guest checkout core implemented; verified accounts, customer management, order history and POS attach remain.                                                         |
| **Storefront online sales** (cart/checkout/order/confirmation/status) | Core implemented              | API checkout core implemented; Storefront checkout UI, payment integration and safe public tracking remain.                                                           |
| **Online payment**                                                    | Adapter boundary              | _Decision: provider + capture semantics (auth-then-capture vs capture-on-order). Not yet chosen â€” do not assume one._                                               |
| **Returns / Refunds**                                                 | API core implemented          | Shared eligibility, returns, restock/non-restock, cash settlement and pending electronic refunds in Phase 2M; client UI and final policy/provider integration remain. |
| **Suppliers**                                                         | API core implemented          | Phase 2N tenant-owned suppliers, lifecycle, optional canonical receiving linkage and history. Procurement/PO and unit cost deferred; Admin SDK integration remains.   |
| **Vouchers / promotions / discounts**                                 | Missing                       | Where the pricing/order model permits. _Decision: exact voucher/discount semantics; affects immutable order pricing snapshot â€” integrity-sensitive._                |
| **Staff management / administration**                                 | Missing (backend perms exist) | Membership/role admin UI + lifecycle. _Decision: staff-management depth._                                                                                             |
| **Reports / Analytics**                                               | Missing                       | Sales/orders/inventory/channel/period + owner dashboard + exports. _Decision: exact report/export list._                                                              |
| **POS Settings**                                                      | Missing                       | Register/receipt/cash-drawer/session configuration (POS repo).                                                                                                        |
| **Admin/business settings**                                           | Missing                       | Tenant/brand/branch/tax/currency/business configuration.                                                                                                              |
| **Delivery / fulfillment (online)**                                   | Partial                       | Delivery snapshots and reservation consumption implemented; shipping/carrier workflow remains.                                                                        |
| **Multi-brand / multi-branch workflows**                              | Partial                       | Data model + scoping exist; single-brand UX + brand switcher + branch selectors in clients.                                                                           |
| **Org management writes**                                             | Missing                       | Create/edit branch, warehouse, inventory location, register, device.                                                                                                  |

### Explicitly out of this batch

Returns/refunds client UI, Supplier client integration, Staff management, Vouchers, Reporting and Settings remain
required complete-V1 backlog items. Phase 2M implements the returns/refunds API core only; see
[returns and refunds](../returns/returns-refunds-core.md) for the remaining policy/provider decisions.

## Preserved unresolved business decisions (do not silently invent)

- Online payment provider and capture semantics.
- Guest checkout is supported; verified customer account linkage remains future work.
- Detailed return-policy rules.
- Exact voucher/discount semantics.
- Supplier V1 depth is management plus canonical receiving; procurement and acquisition-cost modeling are deferred. See [Supplier core](../suppliers/supplier-management-core.md).
- Staff-management depth.
- Reporting/export list.
