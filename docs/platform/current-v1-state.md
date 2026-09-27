# Clothing Commerce Platform — Canonical V1 State

**Status as of:** 2026-09-27 (Phase 2Q Reporting core + API-owned CSV export **merged** (SDK `0.13.1`).
Phase **2R-A Operational Settings Core + SDK `0.14.0`** is implemented on branch
`phase/2r-operational-settings-core`, PR pending. Admin Mobile Promotion, Reporting and Settings
integration remain.)
**Audience:** Any engineering agent (Claude, Codex, or human) starting a new phase.
**Authority:** This document describes the **actual merged state** verified against Git and source,
not planned or remembered state. Where a claim could not be verified it is marked
`unresolved`, `historical`, or `expected but unverified`.

Read this first. Then read the target repo's `AGENTS.md`, then the immediately preceding phase doc.

---

## Verified repository state (origin/main, 2026-09-24)

Git is the source of truth. Local `main` in every repo was stale at inspection time; the merged
truth lives on `origin/main`. All feature branches below were confirmed merged into `origin/main`.

| Repo         | Path                                                    | `origin/main` SHA | Merged head                                   |
| ------------ | ------------------------------------------------------- | ----------------- | --------------------------------------------- |
| API          | `C:\Users\ydelk\Desktop\clothing-commerce-api`          | `5c59fd6`         | PR #28 — Phase 2P Promotions API/core         |
| POS          | `C:\Users\ydelk\Desktop\clothing-commerce-pos`          | `4553cc8`         | PR #5 — returns crash-durable recovery hotfix |
| Storefront   | `C:\Users\ydelk\Desktop\clothing-commerce-storefront`   | `cde64e5`         | PR #2 — storefront checkout integration       |
| Admin Mobile | `C:\Users\ydelk\Desktop\clothing-commerce-admin-mobile` | `652280b`         | PR #10 — admin suppliers foundation           |

> **Caution for future agents:** the local `main` branch in each repo may lag `origin/main`.
> Always `git fetch` and inspect `origin/main` before branching. Do not trust local `main`.

**Current SDK:** `@shifted/clothing-commerce-sdk@0.14.0`
(deterministic pack SHA-256 `f6a666241c135c302829d78f22e601deaffc963e102570db0ee667703b4bf69a`, artifact
`artifacts/shifted-clothing-commerce-sdk-0.14.0.tgz`, identical across two independent packs). It is a
backward-compatible MINOR over merged `0.13.1`, adding the tenant-wide operational-settings methods/DTOs
(business/brands/branches/warehouses/inventory-locations/registers/storefront/returns/devices), the
optional `getContext().access.settings` guidance, and the enriched POS context business/branch identity.

**SDK consumed by clients (staggered — not all on latest):**

| Client       | Vendored SDK      |
| ------------ | ----------------- |
| Admin Mobile | `0.9.0` (current) |
| POS          | `0.8.0`           |
| Storefront   | `0.7.0`           |

Clients pin the SDK as a vendored `file:vendor/*.tgz` tarball. A client upgrades deliberately when it
adopts new API surface; lag is expected and not a defect.

---

## A. Project purpose

A multi-brand / multi-branch clothing commerce platform built around **one shared commerce core**:

- **Shared API + database** — the single source of business truth.
- **Electron POS** — cashier application; connected and offline-first cash sales.
- **Public Storefront** — real online sales channel (browse → cart → checkout → order), not a brochure.
- **Admin Mobile** — owner/manager operational management, including the website catalog.
- **Shared inventory** — POS and online draw from the same physical inventory truth.
- **Online + POS sales** unify into one canonical Order domain with channel identifiers.
- **Offline-first POS** — durable local sales that later synchronize through idempotent API operations.

---

## B. Repository map

| Repo             | Path                             | Owns                                                                                                         | Must NOT own                                                                               |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **API**          | `clothing-commerce-api`          | Canonical domain rules, PostgreSQL schema + migrations, authorization, OpenAPI, the packed SDK, integrations | UI presentation; client-side business logic                                                |
| **POS**          | `clothing-commerce-pos`          | Electron cashier app; connected + offline sales UI; local durable operational state                          | Global truth; server secrets; direct DB table access; API source                           |
| **Storefront**   | `clothing-commerce-storefront`   | Public commerce frontend (Next.js); presentation, SEO, Core Web Vitals                                       | Any business API, business DB, migrations, inventory truth; privileged management surfaces |
| **Admin Mobile** | `clothing-commerce-admin-mobile` | Owner/manager management (Expo); catalog content management                                                  | Cashier/POS/selling functionality; schema/migrations; authorization decisions              |

**Key distinctions to preserve:**

- Admin Mobile is **NOT** the cashier application (that is POS).
- Admin Mobile is **NOT** a Shifted platform super-admin console — it manages one tenant's business.
- Repositories share **no** source files, workspace links, submodules, or absolute-path dependencies.
  The stable integration surface is HTTPS + the versioned SDK artifact only.

---

## C. Frozen architecture invariants

These are established and must not be changed without an ADR. Do not invent new invariants.

- One commerce core.
- `Product` / `Variant` shared across all channels.
- Physical inventory belongs to an `InventoryLocation`. No channel-private stock (`pos_stock`,
  `website_stock`, etc. are prohibited).
- `Order` is the canonical sale; channels are `POS` and `ONLINE`.
- `Tenant` != `Brand`.
- `Branch` != `Warehouse`.
- `InventoryLocation` belongs to a `Branch` **or** a `Warehouse`.
- `Register` != `InventoryLocation`.
- `Device` != `Register`.
- `UserIdentity` != `Membership`.
- `Role` != `Permission` != `Scope`.
- `service_role` is a **DB transport only**, never application authorization.
- The **server is authoritative** for authorization; client UI permissions are never authoritative.
- Clients **do not import API source**; they consume the packed SDK.
- API owns the OpenAPI document and the packed SDK; clients consume the packed SDK.
- **No role-name authorization bypasses** and no protected-role flags conferring bypass.
- Single-brand tenants are **not** forced through brand-switcher UX.

Reference ADRs live in `docs/decisions/ADR-001` … `ADR-036` and the `docs/architecture/*` models.

---

## D. Completed phases (verified)

Concise summaries only; each phase has its own detailed doc. SDK versions shown where a phase
advanced the contract.

| Phase                                    | Delivered                                                                                                                                                                           | Repos affected  | Frozen contract                                                                                                                                                                                                                                             | SDK    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **2F — Management Reads**                | Auth + tenant context; read-only management slice (Products, Inventory, Orders)                                                                                                     | API, Admin      | Read-only management boundary; `/me/context` access guidance                                                                                                                                                                                                | ~0.2.0 |
| **2G — Inventory Management**            | Append-only movement ledger; receive/adjust/transfer/issue writes; row-version reads                                                                                                | API, Admin      | Clients never overwrite authoritative quantities; ledger + balance projection; idempotent ops                                                                                                                                                               | 0.3.x  |
| **2H — Connected POS**                   | `GET /pos/context`, `POST /pos/sales` atomic cash sale (Order+Payment+Fulfillment+issue in one tx)                                                                                  | API, POS        | Server resolves Register→Branch→location + currency; client cannot submit price/location/currency                                                                                                                                                           | ~0.5.0 |
| **2I — Offline POS + Sync**              | Ed25519 device enrollment; signed offline outbox; `ingestOfflineSale`; reconciliation                                                                                               | API, POS        | Locally generated private key never leaves device; exact-replay ingestion; historical-price semantics                                                                                                                                                       | ~0.5.0 |
| **2J — Catalog Management**              | Catalog write (product/variant/option/SKU/price lifecycle); publication boundary; public read surface                                                                               | API             | One catalog model, no parallel ecommerce catalog; publication ≠ internal state                                                                                                                                                                              | 0.6.0  |
| **2K — Storefront Catalog / PDP / Cart** | Public catalog browsing, product detail, variant selection, persistent cart                                                                                                         | Storefront      | Public contract only; canonical variant IDs                                                                                                                                                                                                                 | 0.6.0  |
| **2L — Online Commerce**                 | `POST /storefront/checkout` → canonical `online` Order + Customer + address + ATS reservation + pending Payment; management order visibility                                        | API, Storefront | Immutable delivery snapshots; shared ATS reservations; COD stays pending; client cannot pick location/price                                                                                                                                                 | 0.7.0  |
| **2M — Returns & Refunds**               | One Return domain (POS + ONLINE); restock/non-restock; cash settlement; pending electronic refunds; cumulative caps                                                                 | API, POS, Admin | Immutable economics from OrderLine snapshots; cumulative quantity + payment ceilings; adapter seam for electronic refund                                                                                                                                    | 0.8.0  |
| **2N — Supplier Management**             | Tenant-owned suppliers + lifecycle; optional supplier attribution on canonical receiving; supplier receipt history                                                                  | API, Admin      | Suppliers shared across brands/branches; no second receiving domain; no unit-cost/procurement; immutable name/code snapshots on history                                                                                                                     | 0.9.0  |
| **2O — Staff Management (API core)**     | Staff projection over identity+membership+RBAC; membership lifecycle; role/scope assignment; anti-escalation; last-admin lockout; assignable role/scope catalogs (Admin UI pending) | API             | Staff is a projection, not a new model; add-staff links existing identities by exact-email lookup; subset-of-own escalation rule; assignment options come from canonical catalogs, never from other members' assignments; history preserved; not HR/payroll | 0.11.0 |

Detailed docs: `docs/pos/connected-pos-sale-v1.md`, `docs/pos/offline-pos-v1.md`,
`docs/catalog/catalog-management.md`, `docs/orders/online-commerce-core.md`,
`docs/returns/returns-refunds-core.md`, `docs/suppliers/supplier-management-core.md`,
plus `docs/development/phase-2l-validation.md` and `docs/development/phase-2m-validation.md`.

> The 2F/2G/2H/2I SDK versions above are `expected but unverified` from prior-phase memory; the
> current SDK (0.9.0) and 2J–2N versions (0.6.0–0.9.0) are verified from source/README.

---

## E. Current functional capabilities

`Implemented` = works end-to-end at the stated layer. `Deferred` = agreed but not built.

| Domain                     | Implemented                                                                                                                                                                                                                                                                                                                    | Deferred                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Catalog**                | Product/variant/option/SKU/price lifecycle write; publication boundary; public read; Admin management UI; Storefront browsing/PDP                                                                                                                                                                                              | —                                                                                                                       |
| **Inventory**              | Append-only ledger; receive/adjust/transfer/issue; balance projection; row-version reads; Admin visibility + management                                                                                                                                                                                                        | Unsellable/damaged subledger                                                                                            |
| **POS**                    | Connected atomic cash sale; register/currency resolution; cashier UI                                                                                                                                                                                                                                                           | Card tender; POS settings (register/receipt/cash-drawer/session)                                                        |
| **Offline POS**            | Device enrollment; signed durable outbox; ingestion + reconciliation; crash-durable local recovery                                                                                                                                                                                                                             | Card tender offline; general replication framework                                                                      |
| **Storefront**             | Public catalog, PDP, variant selection, persistent cart, checkout UI                                                                                                                                                                                                                                                           | Verified customer accounts; safe public order tracking polish                                                           |
| **Checkout (online)**      | Guest checkout → canonical Order + Customer + address + reservation + pending Payment                                                                                                                                                                                                                                          | Payment gateway integration                                                                                             |
| **Customers**              | Guest checkout core (customer + saved address)                                                                                                                                                                                                                                                                                 | Verified accounts; customer management; order history; POS customer attach                                              |
| **Orders**                 | Canonical Order (POS + ONLINE); placement, cancellation; immutable pricing snapshots; fulfillment; management visibility                                                                                                                                                                                                       | —                                                                                                                       |
| **Payments abstraction**   | `PaymentProvider` adapter seam; COD/cash captured; pending electronic                                                                                                                                                                                                                                                          | Real provider; capture semantics; COD collection endpoint                                                               |
| **Reservations / ATS**     | Shared available-to-sell reservations consumed at checkout                                                                                                                                                                                                                                                                     | —                                                                                                                       |
| **Returns / refunds**      | Return domain (POS + ONLINE); restock/non-restock; cash settlement; pending electronic refund; cumulative caps; POS + Admin visibility                                                                                                                                                                                         | Electronic refund provider/worker; exchange workflow; final policy                                                      |
| **Suppliers**              | Tenant-owned supplier CRUD + lifecycle; receiving attribution; receipt history; Admin foundation                                                                                                                                                                                                                               | Purchase orders / procurement; supplier invoices / AP; unit-cost model                                                  |
| **Admin Mobile**           | Auth; read management (Products/Inventory/Orders); catalog management; online-order + returns visibility; supplier foundation                                                                                                                                                                                                  | Staff admin; settings; reporting                                                                                        |
| **Authorization / scopes** | Permission catalog; tenant-wide + scoped grants; deny-by-default; idempotency; RLS                                                                                                                                                                                                                                             | —                                                                                                                       |
| **Operational settings**   | Tenant-wide `settings.read`/`settings.manage`; business profile (incl. tax id), brands, branches (+ brand eligibility, receipt footer), warehouses, inventory locations, registers, storefront checkout, return policy, device governance (list/revoke/assign); server-enforced mutation safety; enriched POS receipt identity | Admin Mobile settings UI; scoped settings; role/permission authoring; receipt templates; POS cash-drawer/session config |
| **Staff management**       | Staff projection; add-staff by exact-email identity resolution; **canonical assignable role + access-scope catalogs**; membership lifecycle (active/suspend/revoke); role+scope assignment; anti-escalation; last-admin lockout; `staff.read`/`staff.manage`; `/me/context` guidance                                           | Admin Mobile staff UI; role/scope/target authoring; external invitation delivery                                        |

---

## F. SDK state

- **Package version:** `0.13.0` (`packages/sdk/package.json`).
- **0.13.0 additions (MINOR — backward-compatible):** read-only reporting on the tenant client —
  `getReportSummary`, `getSalesReport`, `getProductsReport`, `getInventoryReport`, `getReturnsReport`,
  `getPromotionsReport`, `getSuppliersReport` — with typed filters, currency-grouped DTOs, period
  metadata, and cursor types; plus optional `getContext().access.reports { canRead }` UI guidance. All
  require a tenant-wide `reports.read` grant.
- **Package version (historical):** `0.12.1`.
- **Artifact:** `artifacts/shifted-clothing-commerce-sdk-0.12.1.tgz`.
- **Deterministic pack SHA-256:**
  `4fcd8076052cac6b4717b6eaa030a91f054398578cbbde9ceb69e7cfc819c7a0` (identical across two
  independent packs).
- **0.12.1 addition (PATCH — compatible response-field addition):**
  `getContext().access.promotions` optional `{ canRead, canManage }`, derived independently from
  tenant-wide effective `promotions.read` / `promotions.manage` grants. It is UI guidance only.
- **0.12.0 additions (MINOR):** Storefront/POS quotes, optional Promotion code intent on sale placement,
  and tenant-scoped Promotion/code management methods and DTOs.
- **0.11.0 additions (MINOR — backward-compatible addition):** `listAssignableStaffRoles`,
  `listAssignableStaffScopes` — the canonical, read-only, tenant-scoped catalogs of the `roleId` and
  `accessScopeId` values `assignStaffRole` accepts. Both require tenant-wide `staff.manage`; the role
  catalog is filtered to roles whose permissions the caller already holds. Clients must not derive
  assignment options from other staff members' assignments.
- **0.10.0 additions:** `listStaff`, `findEligibleStaffIdentitiesByEmail`, `getStaffMember`,
  `createStaff`, `updateStaffStatus`, `assignStaffRole`, `unassignStaffRole`; `getContext().access.staff`
  optional `{ canRead, canManage }`.
- **0.9.0 additions:** `listSuppliers`, `getSupplier`, `createSupplier`, `updateSupplier`,
  `listSupplierReceipts`; `receiveInventory` gains optional `supplierId` / `supplierReference`;
  `getContext().access.suppliers` optional `{ canRead, canManage }` UI guidance.
- **Consumers:** Admin `0.9.0`, POS `0.8.0`, Storefront `0.7.0` (vendored tarballs).
- **Release process:** built and packed only from the API repo; see `docs/development/sdk-release.md`.
  Verify by comparing two independent build/pack SHA-256 values (`pnpm test:sdk`).

The SDK contains no Node-only runtime dependency and no server secrets.

---

## G. Security / data-integrity contracts

Future agents must preserve every guarantee below.

- **Tenant isolation** — all tenant-owned records carry `tenantId`; RLS denies cross-tenant access.
- **Scoped authorization** — permission + scope both enforced; role names never bypass. Tenant-owned
  domains (e.g. suppliers) require tenant-wide grants; brand/branch-only grants are insufficient.
- **RLS** — tenant tables enable RLS with no direct anon/authenticated access. `service_role` is
  transport: it may read projections and invoke sanctioned RPCs, not directly mutate protected tables.
- **Inventory atomicity** — one canonical `record_operation` appends operation + movements and updates
  balances in a single transaction; append-only triggers protect history.
- **Idempotency** — critical mutations require `Idempotency-Key`; canonical intent + response persisted.
- **Exact replay** — same key + identical intent returns the original response/IDs; changed intent
  returns `IDEMPOTENCY_CONFLICT`. Authorization is rechecked on every replay.
- **Immutable historical snapshots** — order pricing snapshots, return economics (from OrderLine
  snapshots), and supplier name/code history snapshots are immutable after acceptance.
- **Offline signed outbox** — POS signs the exact canonical UTF-8 string with a locally held Ed25519
  key; the server verifies signatures against enrolled credential intervals.
- **POS crash recovery** — offline sales and return recovery are crash-durable locally.
- **ATS / reservation integrity** — checkout reserves stock per line; reservations are consumed
  against the shared ledger, never a channel-private copy.
- **Returns / refund cumulative caps** — per-line quantity ceiling and payment monetary ceiling checked
  in one serialized transaction; pending and failed refunds count against the ceiling.
- **Supplier receipt replay** — receipt fingerprints preserve legacy byte representation when no
  attribution is present; adding/removing/changing attribution under the same key conflicts. Replay
  resolution precedes supplier lifecycle validation, so deactivation never invalidates an accepted
  receipt retry.

---

## H. Test infrastructure safety (mandatory lesson)

**A local data-loss incident occurred on 2026-09-19.** An early uncommitted test runner invoked
Supabase `stop --no-backup` with `cwd` defaulting to the repo root; the CLI read the repo
`supabase/config.toml`, selected the normal `clothing-commerce-api` project, and deleted its data
volume. The lost data was not recovered. Full record: `docs/development/phase-2m-test-isolation.md`.

Rules every future agent must follow:

- Destructive DB tests **must** use isolated, disposable resources (unique project ID + temporary
  workdir + ownership marker).
- **Ownership must be proven before any cleanup.** Inspect the exact generated project label and
  validate every resource's full name/labels/mounts before deletion.
- **No generic Docker volume deletion**, no wildcard removal, no global prune.
- **Never** run `supabase stop --no-backup` (or reset) against the normal development project.
- **Fail closed:** no ownership proof → no deletion. Resources that cannot be proven owned are
  retained for inspection, even if that leaves a test leak.

Safe runners share `scripts/returns-test-resources.mjs`. Supplier suites reuse it via `--suppliers`.

**Remaining legacy runners:** the foundation two-cycle persistence gate (`test-persistence.mjs` and the
catalog/inventory/inventory-operations/orders/fulfillment/management variants) uses tmpfs disposable
containers and is not the destructive path, but any **new private schema must be registered** in all
seven reset lists (precedent: `returns_private`, `online_private`, `catalog_public`, `suppliers_private`)
or cycle 2 fails with "schema already exists" (fixed in `7c8f726`). `unresolved`: a full migration of
every legacy persistence runner onto the ownership-marker boundary is not yet complete.

---

## I. Deferred business decisions (do not fabricate)

These remain **unresolved**. Do not silently invent an answer; freeze the decision explicitly when
its phase arrives.

- **Production electronic payment provider** — provider + capture semantics (auth-then-capture vs
  capture-on-order) not chosen.
- **COD production policy** — captured/fulfilled COD works like cash; unpaid-COD netting and a COD
  collection endpoint are a separate decision, not implemented.
- **Return-policy specifics** — final windows, allowed reasons, condition/inspection, cross-branch
  receiving, approval thresholds, evidence retention, fees.
- **Exchange workflow** — not designed.
- **Acquisition / unit-cost model** — no cost basis exists; retail price must not be reused as cost.
- **Procurement / purchase orders** — deferred (PO, requisitions, RFQ, quotations, reorder, forecasting).
- **Supplier invoices / Accounts Payable / supplier payments** — deferred.
- **Detailed promotions / voucher / discount semantics** — Phase 2P-A delivers the validated **money
  core** (branch `phase/2p-promotions-core`): promotion/adjustment/redemption schema, the Order
  accounting evolution (`gross_subtotal_minor`/`discount_total_minor`/net `total_minor`, backward
  compatible), the shared deterministic evaluation engine, largest-remainder allocation, redemption
  under row locks, and the Returns net-refund basis, proven by `pnpm test:promotions:persistence`
  (39 invariants, twice from empty). Frozen product contract: one promotion per order (best eligible
  saving), global/voucher limits only. See [promotions core](../promotions/promotions-core.md) and
  [ADR-037](../decisions/ADR-037-promotion-accounting-and-adjustment-semantics.md). The **client-facing
  API surface is now delivered**: `POST /storefront/quote` + `POST /pos/quote`, optional `promotionCode`
  on checkout and POS sale (redeemed transactionally with server-authoritative net validation), Admin
  promotion/code management (`promotions.read` / `promotions.manage`), OpenAPI, and SDK **`0.12.0`**
  (deterministic pack SHA-256 `e2296c0300778ba3847065605d1863e86caea6042bd6063676bd60c40ef9b076`).
  SDK `0.12.1` adds the missing optional Promotion capability projection to `/me/context` without
  changing Promotion authorization or money behavior.
  Proven by `pnpm test:promotions:persistence` (46), `pnpm test:promotions:concurrency` (12 — final
  voucher race), and the SDK consumer gates.
- **Reporting** — Phase **2Q-A** delivers the operational reporting **core + SDK `0.13.0`** (branch
  `phase/2q-reporting-core`): tenant-wide read-only `summary`/`sales`/`products`/`inventory`/`returns`/
  `promotions`/`suppliers` over canonical tables via the `reporting_reader` role + `reporting_private`
  SECURITY DEFINER RPCs, with frozen financial/time/currency definitions
  ([ADR-038](../decisions/ADR-038-operational-reporting-definitions.md),
  [reporting core](../reporting/reporting-core.md)), proven by `pnpm test:reporting:persistence` (twice
  from empty). **Still deferred:** exports/downloads, scheduled reports, scoped/branch-local reporting,
  as-of historical inventory, and any profitability (no cost basis exists).
- **Operational / business settings** — Phase **2R-A** delivers the operational-settings **core + SDK
  `0.14.0`** (branch `phase/2r-operational-settings-core`): tenant-wide `settings.read` /
  `settings.manage` over the existing organization/config tables via `settings_writer` +
  `settings_private` SECURITY DEFINER RPCs, with server-enforced mutation safety (immutable
  codes/parents, currency locks once commercial history exists, lifecycle-only deletion, append-only
  device assignment governance) and POS-context business/branch receipt identity
  ([ADR-039](../decisions/ADR-039-operational-settings-mutation-safety.md),
  [settings core](../settings/operational-settings-core.md)), proven by `pnpm test:settings:persistence`
  (52 assertions, twice from empty). **Still deferred:** receipt templates/designers, theme/shipping/
  payment-gateway config, scoped (per-brand/branch) settings, role/permission authoring, and POS
  cash-drawer/session configuration.

---

## J. V1 remaining roadmap

| Phase                                            | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **2O — Staff Management**                        | **In progress.** API core **merged** (PR #24, `docs/staff/staff-management-core.md`): membership lifecycle + role/scope assignment + anti-escalation + last-admin lockout; Add Staff links an existing account resolved by **exact email lookup only** (no global identity-directory browsing, no Clerk invite flow, no raw-UUID workflow). Completion patch **implemented / PR pending** on `phase/2o-staff-assignment-catalogs`: canonical read-only `GET /staff/assignable-roles` + `GET /staff/assignable-scopes` as the single source of selectable assignment options (replacing derivation from other members' assignments); role/scope/target **authoring stays deferred to 2R or later**; SDK `0.11.0`. **Remaining:** merge the catalogs patch, then Admin Mobile staff UI integration and runtime acceptance. |
| **2P — Vouchers / Discounts / Promotions**       | **API/core merged as PR #28.** Shared deterministic quotes/redemption, immutable discount allocation, net Returns basis, Promotion management, OpenAPI and SDK `0.12.x`; Admin Mobile integration remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **2Q — Reporting & Analytics**                   | **2Q-A API core + SDK `0.13.0` implemented (branch `phase/2q-reporting-core`, PR pending):** tenant-wide read-only summary/sales/products/inventory/returns/promotions/suppliers with frozen currency/time/financial definitions. Remaining: owner dashboard (Admin Mobile), exports, scheduled reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **2R — Business & Operational Settings**         | **2R-A API core + SDK `0.14.0` implemented (branch `phase/2r-operational-settings-core`, PR pending):** tenant-wide `settings.read`/`settings.manage` over business/brands/branches/warehouses/inventory-locations/registers/storefront/returns/devices with server-enforced mutation safety and POS receipt identity. Remaining: Admin Mobile settings UI; POS cash-drawer/session config.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **2S — Whole-System Acceptance / Stabilization** | End-to-end acceptance, hardening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Optional before client-ready V1:** payment-gateway implementation if electronic payments are
required for launch (adapter seam already exists; provider undecided).

After the phase sequence: client validation → feedback iterations → production hardening → launch.

---

## K. Fast delivery protocol

- Coherent **vertical slices**, usually **1–3 PRs per phase**.
- **Strong tests** for money / inventory / security / idempotency; lighter focused tests for ordinary
  UI / CRUD.
- **One real runtime acceptance** per vertical slice.
- **Docs in the same phase/PR** (Documentation is Definition of Done — see API `AGENTS.md`).
- **Lightweight post-merge closeout.**
- Do **not** repeatedly rerun giant audits without reason.
- Do **not** broaden scope while closing a phase.
- **Client-ready V1 first**, production hardening later where safe.

---

## L. How to start the next phase

1. Read this file.
2. Read the target repo's `AGENTS.md`.
3. `git fetch` and inspect **`origin/main`** (local `main` may be stale).
4. Inspect the relevant domain code.
5. Inspect the current SDK (`packages/sdk`) and which version the target client vendors.
6. Read the immediately preceding phase doc if relevant.
7. Verify unresolved business decisions (section I) — do not invent answers.
8. Create a feature branch from `origin/main`.
9. Implement **only** the requested phase scope.
10. Stop before the next phase.
</content>

</invoke>
