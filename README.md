# Clothing Commerce API

Central HTTP API, transport-contract, SDK, persistence, and staff-authorization foundation for the
Clothing Commerce Platform. Through Phase 2E it exposed only `GET /api/v1/health`; Phase 2A adds the shared catalog
domain and persistence, Phase 2B adds the inventory ledger/balance engine foundation, Phase 2C adds the
internal inventory application service boundary over that engine, Phase 2D adds the canonical
Order/Sales domain (`orders`/`order_lines` persistence and the internal `OrderService` for POS and
ONLINE), and Phase 2E adds the canonical **Fulfillment** domain (`fulfillments`/`fulfillment_lines`
persistence and the internal `FulfillmentService` — the immutable physical execution of order lines from
one inventory location), without adding business or public auth endpoints. See
[Order domain](docs/orders/order-domain.md), [Order persistence](docs/orders/order-persistence.md),
[Order lifecycle](docs/orders/order-lifecycle.md),
[Order authorization](docs/orders/order-authorization.md), and the
[Fulfillment domain](docs/fulfillment/fulfillment-domain.md).

Phase 2F-A adds the first stable, authenticated **workforce Management API** — seven read-only endpoints
under `/api/v1` (`me/tenants`, `me/context`, `products`, `products/{id}`, `inventory`, `orders`,
`orders/{id}`) — and bumps `@shifted/clothing-commerce-sdk` to `0.2.0` with typed management methods. It
is read-only, server-RBAC-authoritative, and is not a platform/super-admin, provisioning, billing, or
customer surface. See [Management API](docs/api/management-api.md),
[Authentication](docs/api/authentication.md), [Errors](docs/api/errors.md),
[Pagination](docs/api/pagination.md), [Serialization](docs/api/serialization.md),
[SDK consumption](docs/sdk/consumption.md), and
[ADR-034](docs/decisions/ADR-034-management-api-external-boundary.md)–
[ADR-036](docs/decisions/ADR-036-sdk-distribution-and-consumption.md).

Phase 2L adds [online commerce checkout](docs/orders/online-commerce-core.md): guest Customer/address,
canonical online Orders, transactional stock reservations, pending COD Payment behind explicit server
enablement, management detail and SDK `0.7.0`. Electronic providers remain unselected.

Phase 2M adds [canonical returns and refunds](docs/returns/returns-refunds-core.md) shared by POS and
ONLINE orders: fulfilled/paid eligibility, immutable return history, explicit restock disposition,
atomic inventory receipts and provider-neutral refunds. SDK **0.8.0** exposes typed eligibility,
create/read/history and manual refund settlement. Tenant policy defaults to disabled; electronic
refunds remain pending until a future provider integration supplies verified settlement.

Run `pnpm test:returns:persistence` and `pnpm test:returns:integration` for real database and HTTP
proof. The latter includes seven RLS suites and concurrency acceptance using an isolated temporary
Supabase project. See [validation](docs/development/phase-2m-validation.md).

## Boundaries and ownership

This repository is the future owner of authentication integration, authorization, tenancy,
commerce business rules, background work, external integrations, Supabase schema, append-only
migrations, and seed tooling. It does not own a storefront, POS interface, or mobile management UI.
All three clients call this API and never access privileged database tables directly.

The Zod schemas in `src/contracts` are the transport source of truth. They generate
`openapi/openapi.json` and are bundled into `@shifted/clothing-commerce-sdk`. The small Next.js
application exists only to host Route Handlers; no visual frontend is included.

## Technology

TypeScript, Next.js Route Handlers, Zod, Clerk's backend SDK, Supabase JavaScript, standard `fetch`,
tsup, Vitest, ESLint, Prettier, pnpm, PostgreSQL, and the repository-pinned Supabase CLI.
Foundational persistence and RLS use append-only PostgreSQL migrations under
`supabase/migrations`.

## Install and develop

Requirements: Node.js 24+, pnpm 10.33.1, Git, and Docker for database test commands.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The API listens at `http://localhost:3000` by default. Verify
`http://localhost:3000/api/v1/health`.

## Environment

Copy `.env.example` when composing the real Clerk/Supabase staff-authorization boundary. Clerk
origins and all server credentials are validated at composition; secrets must never use a public
environment prefix. Unit, authorization, persistence, and RLS tests require no Clerk or production
credentials. See [Local authentication](docs/development/authentication-local.md).

## Quality and build

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:authorization
pnpm test:authorization:integration
pnpm test:persistence
pnpm test:catalog:persistence
pnpm test:inventory:persistence
pnpm test:inventory:operations:persistence
pnpm test:rls
pnpm test:catalog:rls
pnpm test:inventory:rls
pnpm test:inventory:operations:rls
pnpm test:catalog:concurrency
pnpm test:inventory:concurrency
pnpm test:inventory:operations:concurrency
pnpm test:inventory:operations:integration
pnpm test:orders:persistence
pnpm test:orders:rls
pnpm test:orders:concurrency
pnpm test:orders:integration
pnpm test:fulfillment:persistence
pnpm test:fulfillment:rls
pnpm test:fulfillment:concurrency
pnpm test:fulfillment:integration
pnpm build
pnpm sdk:pack
```

`test:persistence` requires a running Docker engine. It starts a temporary PostgreSQL 17.6
container, applies migrations and constraint tests twice from an empty schema, and removes the
container. It uses no production Supabase credentials.

`test:rls` uses the official local Supabase PostgreSQL environment and actual `authenticated`,
`anon`, and `service_role` database roles. It resets from migrations, runs 87 pgTAP policy
assertions, and removes its disposable project data. See
[Local Supabase development](docs/development/supabase-local.md).

`test:catalog:persistence` applies the complete history twice and runs 47 Product/Variant,
identifier, option, merchandising, and pricing invariants per cycle. `test:catalog:rls` runs 43
catalog-specific pgTAP assertions from a reset Supabase database. `test:catalog:concurrency` runs a
deterministic two-session regression proving the Tenant-scoped category advisory lock blocks
concurrent same-Tenant reparents from committing a cycle. See
[Catalog testing](docs/development/catalog-testing.md).

`test:inventory:persistence` applies the complete history twice and runs 54 inventory ledger,
balance-projection, reconciliation, idempotency-fingerprint, privilege-boundary, and rejection
invariants per cycle. `test:inventory:rls` runs 30 inventory-specific pgTAP assertions from a reset
Supabase database. `test:inventory:concurrency` runs a deterministic seven-scenario regression
proving the balance row lock prevents overselling and duplicate balance creation, that opposing
multi-key operations (including absent-row creation) serialize without deadlock, and that concurrent
idempotent submissions apply stock once while a conflicting payload is rejected. See
[Inventory testing](docs/development/inventory-testing.md).

Phase 2C adds the inventory application service boundary (`src/inventory/`): the intent-named
commands `getInventoryBalance`, `setOpeningStock`, `adjustInventory`, `receiveInventory`,
`issueInventory`, and `transferInventory`, authorized through Phase 1D against the target
`InventoryLocation`(s) and translated into the sanctioned ledger functions — the raw ledger stays
internal. `test:inventory:operations:persistence` and `test:inventory:operations:concurrency` cover
the two new hardened functions (`record_opening`, `record_count_adjustment`), the generic `issue`
exit, and the opening/stale-count races on disposable PostgreSQL; `test:inventory:operations:rls` and
`test:inventory:operations:integration` are the Supabase-local grant/metadata and end-to-end suites
(Linux CI authoritative). See [inventory operations](docs/inventory/inventory-operations.md) and
[inventory authorization](docs/inventory/inventory-authorization.md).

`test:authorization` runs the deterministic staff identity and application-authorization suite.
It verifies provider mapping, lifecycle, Permission/AccessScope coupling, resource ownership,
protected Roles, and the privileged-operation gate without live Clerk or Supabase credentials.

`test:authorization:integration` resets a disposable local Supabase API stack and exercises the
real privileged authorization repository. It requires Docker but no cloud credentials.

`sdk:pack` creates `artifacts/shifted-clothing-commerce-sdk-0.5.0.tgz`. During registry bootstrap,
that exact tarball is copied into each client repository's `vendor/` directory and locked by pnpm.
This makes every client independently cloneable and testable without a sibling checkout. After a
private registry is approved, clients replace the vendored artifact locator with an explicit
registry version and upgrade independently.

## Release and deployment responsibility

API and SDK versions are released from this repository. A future API deployment will build a
Docker image for an approved Hostinger KVM VPS; no deployment exists now. SDK releases use semantic
versioning and will publish privately (for example GitHub Packages). API, SDK, POS, storefront, and
mobile releases remain independent.

## Documentation index

Use this README as the map; detailed design and operational guidance live under `docs/`.

| Topic                      | Start here                                                                                                                                                                                                                                                               | Covers                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| System architecture        | [System context](docs/platform/system-context.md), [repository boundaries](docs/platform/repository-boundaries.md)                                                                                                                                                       | Service ownership, polyrepo boundaries, and client/API relationships                                                                        |
| Phase 1C-A architecture    | [Foundational persistence architecture](docs/architecture/phase-1c-a-foundational-persistence.md), [domain diagram](docs/architecture/phase-1b-domain-diagram.md)                                                                                                        | Design decisions, ownership, invariants, and Phase 1C-B deferrals                                                                           |
| Architecture decisions     | [Decision records](docs/decisions/)                                                                                                                                                                                                                                      | Accepted/proposed ADRs, including database ownership and physical schema choices                                                            |
| API and contracts          | [API versioning](docs/platform/api-versioning.md), [SDK contract strategy](docs/platform/sdk-contract-strategy.md)                                                                                                                                                       | `/api/v1` compatibility, Zod/OpenAPI ownership, and SDK generation                                                                          |
| Foundational database      | [Foundational schema guide](docs/database/foundational-schema.md)                                                                                                                                                                                                        | Plain-language table meanings, relationships, constraints, and limitations                                                                  |
| Catalog domain             | [Catalog domain](docs/catalog/catalog-domain.md), [catalog persistence](docs/catalog/catalog-persistence.md)                                                                                                                                                             | Product/Variant/options, identifiers, merchandising, pricing, lifecycle, and RLS                                                            |
| Inventory domain           | [Inventory domain](docs/inventory/inventory-domain.md), [inventory persistence](docs/inventory/inventory-persistence.md)                                                                                                                                                 | Operation/movement ledger, balance projection, concurrency, idempotency, and RLS                                                            |
| Inventory operations       | [Inventory operations](docs/inventory/inventory-operations.md), [inventory authorization](docs/inventory/inventory-authorization.md)                                                                                                                                     | Phase 2C application commands, permissions/scopes, results, errors, and idempotency                                                         |
| Fulfillment domain         | [Fulfillment domain](docs/fulfillment/fulfillment-domain.md), [persistence](docs/fulfillment/fulfillment-persistence.md), [authorization](docs/fulfillment/fulfillment-authorization.md), [inventory integration](docs/fulfillment/fulfillment-inventory-integration.md) | Phase 2E immutable physical execution, two-authority + composite proof, atomic inventory issue, idempotency/concurrency, cancellation guard |
| Connected POS sale         | [Connected POS Sale V1](docs/pos/connected-pos-sale-v1.md)                                                                                                                                                                                                               | Phase 2H register context, atomic cash sale, price confirmation, authorization, idempotency, and tax/device deferrals                       |
| Offline POS sale           | [Offline POS V1](docs/pos/offline-pos-v1.md)                                                                                                                                                                                                                             | Device enrollment, bounded grants, canonical signatures, historical prices, ingestion, replay, and reconciliation                           |
| Migrations                 | [Migration guide](docs/database/migrations.md)                                                                                                                                                                                                                           | Authoritative history, adding/reviewing/testing migrations, and rollback philosophy                                                         |
| Docker                     | [Docker strategy](docs/docker/strategy.md), [database testing](docs/docker/database-testing.md), [local Supabase](docs/development/supabase-local.md)                                                                                                                    | Fast PostgreSQL tests, Supabase RLS tests, CI, and production direction                                                                     |
| Testing                    | [Development testing guide](docs/development/testing.md), [catalog testing](docs/development/catalog-testing.md), [inventory testing](docs/development/inventory-testing.md)                                                                                             | Unit, authorization, contract drift, catalog/inventory persistence/RLS, build, SDK                                                          |
| Development and releases   | [SDK release guide](docs/development/sdk-release.md)                                                                                                                                                                                                                     | Local commands and the current vendored SDK release workflow                                                                                |
| Identity and authorization | [Identity and authorization](docs/security/identity-and-authorization.md), [local authentication](docs/development/authentication-local.md)                                                                                                                              | Clerk trust boundary, internal identity, Permission/scope evaluation, and operations                                                        |
| Tenant security and RLS    | [Tenant RLS](docs/security/tenant-rls.md), [tenant isolation strategy](docs/architecture/tenant-isolation-strategy.md)                                                                                                                                                   | Implemented application authorization plus database backstop and threat model                                                               |
| Future deployment          | [Deployment boundaries](docs/platform/deployment-boundaries.md), [Docker strategy](docs/docker/strategy.md#intended-production-boundary)                                                                                                                                 | Intended Hostinger KVM/Docker Compose direction; no deployment exists yet                                                                   |
| Troubleshooting            | [Database-test troubleshooting](docs/docker/database-testing.md#troubleshooting), [testing troubleshooting](docs/development/testing.md#troubleshooting-by-layer)                                                                                                        | How to isolate Docker, PostgreSQL, migration, SQL-test, build, and contract failures                                                        |

## Current implementation boundary

Phase 2N adds [Supplier management V1](docs/suppliers/supplier-management-core.md): tenant-owned
suppliers, active/inactive lifecycle, explicit permissions, optional linkage to canonical receiving,
and immutable supplier receipt history. Unit cost and procurement workflows remain deferred.
Run `pnpm test:suppliers:persistence` and `pnpm test:suppliers:integration` using the existing
ownership-validated disposable infrastructure. The additive SDK release is `0.9.0`.

The repository now owns catalog, append-only inventory, canonical Orders, immutable Fulfillments, the
management API, Connected POS Sale V1, and the Phase 2I Offline POS server boundary. A connected cash checkout composes its POS Order, captured
Payment, full Fulfillment, and inventory issue atomically from a server-trusted Register context.
Clerk-backed staff authorization remains the privileged human boundary; signed offline ingestion uses
previously issued device authority. There is still no Electron POS UI, local offline database, card or
split tender, refund/return, promotion/loyalty, tax engine, storefront, customer authentication, production Docker image/Compose file, or
deployment. Fiscal/tax compliance must be completed before a production deployment where required.

### Historical Phase 2A/2B boundary

Phase 2A adds tenant-owned Product, ProductVariant, identifier, option, Category, Collection, and
base-price persistence plus deny-by-default RLS. Phase 2B adds the inventory foundation — the
append-only operation/movement ledger, the transactionally maintained on-hand balance projection
keyed by `ProductVariant + InventoryLocation`, the private atomic mutation path, and inventory RLS —
without any sales, receiving, returns, transfer, purchasing, costing, or reservation workflow.
Clerk-backed staff authorization remains the privileged boundary. There is still no catalog/public
auth endpoint, Permission seed, customer authentication, order/payment workflow, storefront/POS UI,
production Docker image/Compose file, or deployment.
