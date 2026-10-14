# Supplier management V1

Suppliers are tenant-owned trading partners shared across brands, branches, warehouses and inventory
locations. Phase 2N adds management and attribution to the existing inventory receipt workflow; it
does not introduce a second receiving domain. Admin Mobile, POS and Storefront repositories are
outside this change. The Admin Supplier foundation can adapt the SDK DTOs described here.

## Model and lifecycle

`Supplier` contains `id`, `tenantId`, `name`, optional unique tenant `code`, `status`, optional
`contactPerson`, `phone`, `email`, `address`, `notes`, and `createdAt`/`updatedAt`. Optional stored
fields are returned as null. `address` is a bounded free-text address, avoiding a premature
country-specific address or tax schema. Codes are unique case-insensitively after trimming within
one tenant. No tax identifier is introduced.

Create defaults to `active`. PATCH can set `active` or `inactive`; deactivation preserves the
record and all history. There is no DELETE endpoint or client delete privilege. A composite foreign
key prevents deletion of a supplier referenced by inventory operations. Optional fields can be
cleared with explicit null; omitted update fields remain unchanged. Empty updates are rejected.

## Authorization and transport

All routes require a verified Clerk session and `X-Tenant-Id`. Supplier reads require a
permission-coupled **tenant-wide** `suppliers.read` assignment; writes require a tenant-wide
`suppliers.manage` assignment. Neither permission implies the other. A grant scoped only to a brand,
branch or location is insufficient for this tenant-owned domain. Role names and protected-role
flags confer no bypass. Deployment owners assign permissions explicitly; the migration seeds keys,
never role assignments.

`GET /api/v1/me/context` already exposes domain access guidance. Its additive optional
`access.suppliers: { canRead, canManage }` block follows that architecture and derives from the same
verified assignment facts. Current servers populate it; optionality lets SDK 0.9 consumers parse
older compatible context responses. Every endpoint still authorizes independently.

Supplier history additionally requires usable `inventory.read` visibility and returns only
operations whose entire set of movements is within that location scope. A supplier read grant
cannot widen inventory visibility. Receiving requires the existing `inventory.receive` grant on the
destination location; it does not require `suppliers.manage`. Unknown, cross-tenant and inactive
suppliers are rejected by the canonical database operation for new receipts.

| Endpoint                                      | SDK operation                      | Permission                              |
| --------------------------------------------- | ---------------------------------- | --------------------------------------- |
| GET `/api/v1/suppliers`                       | `listSuppliers(query?)`            | `suppliers.read`                        |
| GET `/api/v1/suppliers/{supplierId}`          | `getSupplier(id)`                  | `suppliers.read`                        |
| POST `/api/v1/suppliers`                      | `createSupplier(input)`            | `suppliers.manage`                      |
| PATCH `/api/v1/suppliers/{supplierId}`        | `updateSupplier(input)`            | `suppliers.manage`                      |
| GET `/api/v1/suppliers/{supplierId}/receipts` | `listSupplierReceipts(id, query?)` | `suppliers.read` + inventory visibility |
| POST `/api/v1/inventory/receipts`             | `receiveInventory(input)`          | existing `inventory.receive` scope      |

All supplier writes require `Idempotency-Key`, supplied as `idempotencyKey` in SDK inputs. They use
the established 200 success response convention. PATCH status implements activation/deactivation;
there is no redundant status endpoint. Management CORS now includes PATCH.

## Search and pagination

Lists use `{ items, pageInfo: { hasMore, nextCursor } }`, default limit 25, bounded 1–100. Supplier
search is a case-insensitive literal substring of name or code, with optional active/inactive filter.
`%`, `_`, commas and parentheses are text, never a PostgREST expression. SQL `position` avoids
interpolated filters. Supplier and history pages use stable ascending UUID keysets, with different
versioned cursor discriminators. Invalid query fields, bounds and cursors fail closed. Every page
reapplies tenant and inventory visibility; cursors do not confer access. UUID ordering is stable,
not chronological. Receipt timestamps are available for display.

Indexes cover tenant/id, tenant/status/id, tenant/code uniqueness and tenant/supplier/operation-id
history. Literal substring search scans the tenant's supplier subset; a full-text/trigram subsystem
is deliberately deferred until measured need.

## Canonical receiving and history

The existing receipt API is a **single-variant quantity operation**, not a multi-line document API.
It accepts additive optional `supplierId` and `supplierReference` (1–200 trimmed characters). The
reference is a delivery note or supplier document number, not a purchase order. A document reference
may be recorded without selecting a supplier. Existing no-supplier requests and response fields
remain compatible. Receipt responses add those optional attribution fields; balance values remain
post-commit observations, not atomic before/after snapshots.

The migration adds supplier attribution columns to `inventory_operations`. The existing canonical
`record_operation` implementation still appends operations and movements and updates balances in
one transaction. A nine-argument overload accepts attribution; the original seven-argument signature
delegates with null metadata, preserving all existing SQL callers and their grants. Inventory table
write grants and append-only triggers remain intact.

The database locks the supplier row while validating active status and capturing the name/code.
A small private helper owned by `suppliers_writer` holds that lock without granting inventory code
supplier UPDATE access. Rename/deactivation and new receiving therefore serialize. Lock validation
and insertion occur in the same transaction; a failed receipt writes no inventory.

History uses **supplierId plus immutable name/code snapshots** on the canonical operation. This
small duplication keeps old delivery activity understandable after supplier rename or code reuse.
Supplier contact/address data is not copied. The existing append-only trigger protects the snapshot,
relationship and document reference. The history projection reads canonical movements and exposes
operation ID, receipt time, actor membership ID, supplier snapshot/reference, variant ID/SKU/product
name, positive quantity, destination location name/ID and branch ID. Product/location display names
are current projections; their IDs and receipt quantities remain canonical historical facts.

## Idempotency

Supplier writes persist canonical parsed intent (including actor and target supplier) and their
original response in private `supplier_commands`. Keys are tenant-scoped, trimmed and lowercased.
Exact replay returns the accepted response, even if later edits changed the current supplier;
clients can refresh detail for current state. Changed intent returns `IDEMPOTENCY_CONFLICT`.

Receipt fingerprints preserve the old byte representation when both attribution fields are absent.
When present, supplier ID and supplier reference enter the canonical fingerprint together with the
existing tenant, actor, operation type, ordered movement variants, destinations and quantities.
Changing or removing attribution with the same key conflicts. Existing notes/timestamp exclusion is
unchanged. An advisory key lock serializes identical submissions; the existing unique key and
conflict handling remain backstops. Exact replay/conflict resolution precedes supplier lifecycle
validation, so deactivation never invalidates an accepted receipt retry. Existing application
variant/location lifecycle and permission checks still apply on every request.

## Persistence and security

Append-only migration: `20260921180000_create_suppliers.sql`. No merged migration is rewritten.
Supplier tables enable RLS and have no direct anon/authenticated access. `service_role` is a
transport: it can select supplier projections and execute sanctioned RPCs, but cannot directly
insert/update/delete suppliers, read command intent, or mutate inventory tables. Application
services issue opaque authorization proofs before repository access and always derive tenant/actor
from the verified context. Private definers have an empty fixed search path and a dedicated
NOLOGIN, NOBYPASSRLS owner. Cross-tenant supplier references have both SQL validation and a composite
foreign-key backstop. Infrastructure superusers remain trusted, as elsewhere in the repository.

Production deployment must apply the migration and expose `suppliers_private` to the server's
PostgREST configuration before deploying the new API/SDK contract. Local configuration is in
`supabase/config.toml`. Schema exposure is not authorization: client schema usage and function
execution remain revoked. No new environment variable or external dependency is required. Existing
Clerk and Supabase server configuration remains in use; no secrets enter SDK artifacts.

## Supplier money extension

The later custom supplier-money extension is documented in
[supplier-money.md](supplier-money.md). It adds atomic priced receipts, initial and standalone
payments, server-computed dues, and reminders while preserving this foundation. Per-line supplier
cost is AP/history only and does not establish inventory valuation or COGS.

## Unit cost and deferred procurement (original Phase 2N boundary)

The current schema has retail selling prices and order/payment snapshots, but no coherent
acquisition-cost, inventory-cost-basis or costing model. Phase 2N therefore adds **no unit cost**.
Reusing retail price as supplier cost would create misleading historical/accounting facts. A later
costing design must define integer minor units, currency and immutable receipt-line facts before
enabling cost capture or reporting.

Explicitly deferred: Purchase Orders, purchase requisitions, RFQs, supplier quotations, supplier
invoices, Accounts Payable, supplier payments, procurement approvals, supplier/vendor portal,
reorder automation and supply-chain forecasting. Staff, Vouchers, Reporting and Settings are not
part of this phase.

## Implementation and validation

Zod contracts live in `src/contracts/management/suppliers.ts`; `src/suppliers` contains validation,
authorization, persistence and safe errors. Thin routes live in `app/api/v1/suppliers`. Inventory
command forwarding stays in `src/inventory`, and `src/openapi/document.ts` plus generated
`openapi/openapi.json` and `packages/sdk` define the external contract.

Run `pnpm test:suppliers:persistence` and `pnpm test:suppliers:integration` (or the narrower
`pnpm test:suppliers:rls`). These extend the existing Returns runners with `--suppliers`, reusing
`returns-test-resources.mjs` unchanged. They create unique temporary projects, verify ownership and
clean up only exact owned resources. They never stop/reset the normal developer project. See
[test isolation](../development/phase-2m-test-isolation.md). HTTP suites run serially against the
shared disposable fixture so independent inventory assertions cannot race each other.

Persistence proves linkage, tenant foreign keys, replay, changed intent, inactive behavior,
immutable snapshots, history deletion protection and legacy receiving. HTTP acceptance covers the
full SDK/API scenarios, permission/scope denial, search/pagination and concurrent replay. Shared
Returns, inventory, fulfillment, orders, catalog and online RLS tests run in the same isolated stack.
Unit tests cover boundary validation, permission coupling and SDK transport behavior. CI runs the
supplier suites along with the existing gates. For SDK distribution, run `pnpm test:sdk` and compare
two independent build/pack SHA-256 values; see [SDK release](../development/sdk-release.md).

Troubleshooting: 403 means missing permission or tenant-wide supplier scope; history also needs
inventory visibility. `SUPPLIER_NOT_FOUND` deliberately does not distinguish foreign from absent.
`SUPPLIER_INACTIVE` applies only to new receipts. `SUPPLIER_CODE_CONFLICT` means the normalized code
is already used in that tenant. `IDEMPOTENCY_CONFLICT` requires a fresh key for a genuinely new
intent, never blind retry. An internal persistence failure after deployment warrants checking
migration and PostgREST schema exposure, not relaxing grants or RLS.
