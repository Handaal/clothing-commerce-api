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
  support the full online-commerce journey (browse → cart → checkout → payment → order → status).
- **Admin Mobile is management-only** for the business owner / authorized managers. It is not a
  cashier/selling/POS app and not a Shifted platform super-admin. It manages/monitors the business,
  **including the website catalog**. It does **not** edit the Storefront's visual design/layout.

## Frozen architectural invariants (unchanged)

One commerce core · Product/Variant shared across channels · inventory belongs to physical
`InventoryLocation` · Order is the canonical sale · POS and ONLINE are channels · Tenant != Brand ·
Branch != Warehouse · Register != InventoryLocation · Device != Register · UserIdentity != Membership
· Role != Permission != Scope · `service_role` is DB transport only · server is authoritative for
authorization · clients consume the packed SDK (never API source) · API owns OpenAPI + SDK · no
role-name authorization bypasses · no mocks hiding failures · single-brand tenants are not forced
through brand-switcher UX.

## Status legend

Complete · Partial · Foundation-only · Missing. "Foundation exists" never means "feature works
end-to-end."

## Backlog

### Done / backend-ready (context only — not this batch)
- Auth, tenant bootstrap/context, memberships/roles/permissions/scopes (backend), device trust.
- Organization model + management reads.
- Catalog **read** + full catalog **schema** (products/variants/options/SKU/pricing/categories/collections).
- Inventory ledger + receive/adjust/transfer/issue + read; advisory offline snapshots.
- Canonical Orders (placed/cancelled), channel model, fulfillment, POS connected + offline authority.
- POS offline durability (POS repo, Codex PR2) and offline sync (Codex PR3, in progress — **not ours**).

### This batch (Phase 2J — Catalog management + Storefront publication, API + SDK)
- Catalog **write**: product create/update/lifecycle (draft→active→archived), variant create/update,
  option/value management, SKU integrity, price set/change.
- **Storefront publication boundary**: distinguish internal catalog state from publicly sellable.
- **Product media**: image metadata + object-storage reference (not binaries in Postgres).
- **Public (Storefront-safe) catalog read**: published products/variants/price/media/taxonomy only.
- OpenAPI + SDK `0.6.0`.

### Required for V1, not yet built (future batches — DO NOT LOSE)
| Domain | State | Notes / unresolved decisions to freeze later |
| --- | --- | --- |
| **Customers** | Missing | Entity/profile, lookup, order history, POS attach. *Decision: guest vs registered login policy.* |
| **Storefront online sales** (cart/checkout/order/confirmation/status) | Missing | Public order-orchestration layer + online payment. |
| **Online payment** | Missing | *Decision: provider + capture semantics (auth-then-capture vs capture-on-order). Not yet chosen — do not assume one.* |
| **Returns / Refunds** | Missing | Eligibility, return lines, refund lifecycle, inventory restock disposition, POS + admin UI. *Decision: return-policy rules.* |
| **Suppliers** | Missing | Supplier entity + purchasing/receiving linkage. *Decision: supplier workflow depth (directory only vs full PO).* |
| **Vouchers / promotions / discounts** | Missing | Where the pricing/order model permits. *Decision: exact voucher/discount semantics; affects immutable order pricing snapshot — integrity-sensitive.* |
| **Staff management / administration** | Missing (backend perms exist) | Membership/role admin UI + lifecycle. *Decision: staff-management depth.* |
| **Reports / Analytics** | Missing | Sales/orders/inventory/channel/period + owner dashboard + exports. *Decision: exact report/export list.* |
| **POS Settings** | Missing | Register/receipt/cash-drawer/session configuration (POS repo). |
| **Admin/business settings** | Missing | Tenant/brand/branch/tax/currency/business configuration. |
| **Delivery / fulfillment (online)** | Partial | Canonical fulfillment exists; online delivery/shipping requirements not modeled. |
| **Multi-brand / multi-branch workflows** | Partial | Data model + scoping exist; single-brand UX + brand switcher + branch selectors in clients. |
| **Org management writes** | Missing | Create/edit branch, warehouse, inventory location, register, device. |

### Explicitly out of this batch
Customers, Suppliers, Staff admin, Vouchers, Returns, Reporting, Storefront checkout/cart/order
creation, online payment. This batch builds only the catalog-management + publication server + SDK
that those clients will consume next.

## Preserved unresolved business decisions (do not silently invent)
- Online payment provider and capture semantics.
- Customer login vs guest checkout policy.
- Detailed return-policy rules.
- Exact voucher/discount semantics.
- Supplier workflow depth.
- Staff-management depth.
- Reporting/export list.
