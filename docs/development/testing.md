# Development Testing

## Purpose

The repository uses layered checks because no single test can prove formatting, TypeScript safety,
transport compatibility, business behavior, database integrity, and distributable output at once.
Run the smallest relevant check while developing, then run the full sequence before treating an
implementation as complete.

## Test and validation layers

| Layer                      | Command                                      | What it catches                                                                                           | What it does not prove                                    |
| -------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Formatting                 | `pnpm format:check`                          | Files that differ from the Prettier rules                                                                 | Type, behavior, or database correctness                   |
| Linting                    | `pnpm lint`                                  | Configured ESLint correctness and maintainability issues                                                  | Runtime or PostgreSQL behavior                            |
| Type checking              | `pnpm typecheck`                             | Strict TypeScript errors across configured packages                                                       | Runtime values or SQL constraints                         |
| Unit/contract tests        | `pnpm test`                                  | Vitest behavior, health contracts/routes, OpenAPI drift, SDK code                                         | Live PostgreSQL and RLS behavior                          |
| Identity/authorization     | `pnpm test:authorization`                    | Provider mapping, lifecycle, Permission/scope, ownership, proof                                           | Live Clerk, provisioning, or production credentials       |
| Auth repository            | `pnpm test:authorization:integration`        | Real Supabase adapter, hydration, corrupt-state denial                                                    | Live Clerk, cloud Supabase, or production credentials     |
| Persistence tests          | `pnpm test:persistence`                      | Ordered migrations and SQL invariants on PostgreSQL 17.6, twice                                           | Supabase RLS/auth context or production upgrade safety    |
| Catalog persistence        | `pnpm test:catalog:persistence`              | Catalog relations and invariants on PostgreSQL 17.6, twice                                                | Supabase role behavior or production upgrade safety       |
| Inventory persistence      | `pnpm test:inventory:persistence`            | Inventory ledger/balance invariants on PostgreSQL 17.6, twice                                             | Supabase role behavior or production upgrade safety       |
| Supabase/RLS tests         | `pnpm test:rls`                              | Roles, request claims, RLS policy behavior, tenant attacks                                                | Application authorization or production safety            |
| Catalog RLS tests          | `pnpm test:catalog:rls`                      | Catalog policies, runtime isolation, write denial, bypass role                                            | Catalog application authorization or public publication   |
| Inventory RLS tests        | `pnpm test:inventory:rls`                    | Inventory policies, runtime isolation, write and helper denial                                            | Inventory application authorization or public publication |
| Catalog concurrency        | `pnpm test:catalog:concurrency`              | Tenant-scoped category advisory lock; two-session cycle race                                              | Non-hierarchy catalog behavior                            |
| Inventory concurrency      | `pnpm test:inventory:concurrency`            | Balance row-lock oversell/creation races; two-session tests                                               | Non-stock inventory behavior                              |
| Inventory ops persistence  | `pnpm test:inventory:operations:persistence` | record_opening/record_count_adjustment + issue on PostgreSQL, twice                                       | Application authorization or Supabase RLS behavior        |
| Inventory ops concurrency  | `pnpm test:inventory:operations:concurrency` | Opening race, opening replay race, and stale-count race                                                   | Non-operation inventory behavior                          |
| Inventory ops RLS          | `pnpm test:inventory:operations:rls`         | Grants/metadata for the new functions; client execute denial                                              | Application command semantics                             |
| Inventory ops integration  | `pnpm test:inventory:operations:integration` | Real service + repository against the sanctioned functions                                                | Non-inventory application behavior                        |
| Orders persistence         | `pnpm test:orders:persistence`               | orders/order_lines/counter, create_order/cancel_order, integrity, twice                                   | Application authorization or Supabase RLS behavior        |
| Orders RLS                 | `pnpm test:orders:rls`                       | Deny-authenticated policy stance, function grants, writer hardening                                       | Application command semantics                             |
| Orders concurrency         | `pnpm test:orders:concurrency`               | Idempotent/conflicting create races, order-number race, cancel race                                       | Non-order behavior                                        |
| Orders integration         | `pnpm test:orders:integration`               | Real service + repository: create/read/cancel, replay after catalog/register change                       | Non-order application behavior                            |
| Fulfillment persistence    | `pnpm test:fulfillment:persistence`          | fulfillments/lines, no status column, integrity, over-fulfillment, immutability, privilege graph, twice   | Application authorization or Supabase RLS behavior        |
| Fulfillment RLS            | `pnpm test:fulfillment:rls`                  | Deny-authenticated stance, function/issue grants, writer hardening, inventory_writer read-only            | Application command semantics                             |
| Fulfillment concurrency    | `pnpm test:fulfillment:concurrency`          | Idempotency race, over-fulfillment race, cancel-vs-fulfill (both), lock ordering, location lifecycle race | Non-fulfillment behavior                                  |
| Fulfillment integration    | `pnpm test:fulfillment:integration`          | Real service + repository: two-authority, partial/multi-location, replay, cancellation guard              | Non-fulfillment application behavior                      |
| Management persistence     | `pnpm test:management:persistence`           | `catalog.read` seeded and granted to no role; the three list indexes with exact columns/order, twice      | Application behavior                                      |
| API contracts              | `pnpm test:api:contracts`                    | Management DTO parsing, safe integers, ISO-UTC time, pagination envelope, cursor encode/decode, envelope  | Live database or authorization behavior                   |
| OpenAPI                    | `pnpm test:openapi`                          | Seven paths, Clerk security scheme, tenant-header placement, schemas/error responses, health unchanged    | Runtime request handling                                  |
| Management API integration | `pnpm test:api:integration`                  | Real resolver + read services vs Supabase: auth, /me/*, visibility-before-pagination, 404/403, detail     | Real Clerk configuration                                  |
| Connected POS integration  | `pnpm test:pos:sale:integration`             | Connected price/stock/authorization, atomic composition, and replay                                       | Offline device authority                                  |
| Offline POS RLS            | `pnpm test:pos:offline:rls`                  | New table denial, writer ownership, function grants, tenant-safe keys                                     | Application command semantics                             |
| Offline POS integration    | `pnpm test:pos:offline:integration`          | Enrollment, grant, signature, policy, historical price, replay, reconciliation, revocation                | Electron/local persistence                                |
| SDK check                  | `pnpm test:sdk`                              | Build, types, methods, token/tenant/client headers, error parsing, pack, isolated self-contained tarball  | Publication to a remote registry                          |
| Build                      | `pnpm build`                                 | Compilation and build-time integration                                                                    | Deployment/runtime infrastructure                         |
| SDK package check          | `pnpm sdk:pack`                              | The SDK can be packaged and its included files inspected                                                  | Publication or consumer integration in a remote registry  |
| Whitespace validation      | `git diff --check`                           | Trailing whitespace and malformed patch markers                                                           | Any semantic correctness                                  |

At the Phase 1D review point, `pnpm test` runs the four existing unit/contract files with eleven
tests, including `tests/openapi-drift.test.ts`. `pnpm test:authorization` separately runs five files
with 57 deterministic tests, and the Supabase adapter integration file runs 20 cases. The
persistence SQL suite performs 27 assertions per cycle and the runner executes two clean cycles.
The RLS suite performs 87 pgTAP assertions from a reset local Supabase database. Counts are
descriptive, not a target to preserve when useful coverage is added. Phase 2A adds 47 catalog
persistence assertions per cycle, 43 catalog RLS assertions, and a separate deterministic
seven-check category concurrency regression. Phase 2B adds 39 inventory persistence assertions per
cycle, 28 inventory RLS assertions, and a separate deterministic 13-check balance concurrency
regression.

## Recommended completion sequence

From the repository root, after installing dependencies:

```powershell
pnpm install
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:authorization
pnpm test:authorization:integration
pnpm test:persistence
pnpm test:catalog:persistence
pnpm test:inventory:persistence
pnpm test:rls
pnpm test:catalog:rls
pnpm test:inventory:rls
pnpm test:catalog:concurrency
pnpm test:inventory:concurrency
pnpm test:pos:sale:integration
pnpm test:pos:offline:rls
pnpm test:pos:offline:integration
pnpm build
pnpm sdk:pack
git diff --check
```

`pnpm format` writes formatting changes; review its diff before continuing. The database commands
require a running Docker engine. None needs an `.env` file, Supabase login, linked cloud project, or
production credentials. The Supabase commands own and remove disposable local stacks; see
[Local Supabase development](supabase-local.md). `pnpm test:all` is the shorter aggregate for the
test commands; formatting, lint, typecheck, build, packing, and diff checks remain separate.

## What runs in CI

`.github/workflows/ci.yml` currently runs dependency installation with the frozen lockfile,
formatting verification, linting, type checking, unit/contract Vitest, the distinct deterministic
and real-repository authorization steps, all three persistence commands, all three distinct RLS
security steps, the catalog category and inventory balance concurrency regressions, the build, and
SDK packing. Application authorization and all database layers are mandatory in every pull request.

The GitHub-hosted Ubuntu runner supplies Docker. CI invokes the same Node runner used locally, which
checks Docker availability, creates its own disposable PostgreSQL container, runs both clean test
cycles, and removes the container. The authorization-integration and RLS runners use the same
repository-pinned Supabase CLI and start/reset/test/stop lifecycle locally and in CI. The workflow
defines no persistent PostgreSQL service and uses no database or Supabase cloud credentials.

The OpenAPI drift test is part of `pnpm test`; it guards the committed generated specification
against the Zod transport source of truth. SDK packing is a separate CI step so publishable-file
mistakes are visible even when source tests pass.

## Adding or changing tests

- Put TypeScript behavior and contract tests in the existing Vitest layout and keep them
  deterministic.
- Put staff identity and application-authorization tests under `tests/authorization`. Use provider
  doubles and the in-memory repository; exercise real provenance mapping and authorization logic,
  never production Clerk credentials.
- Put real adapter tests under `tests/authorization-integration` and run them only through the
  owning script. Test-only SQL belongs in a non-migration setup file and must be applied only after
  a local reset; never weaken production constraints to manufacture corrupt states.
- Update transport schemas first, regenerate the OpenAPI artifact through the repository command,
  and let the drift test verify that they agree.
- Put portable structural assertions in the Phase 1C-A SQL file and Supabase role/policy assertions
  in the Phase 1C-B pgTAP file. Use transaction-scoped fixtures and rollback so production seed data
  is never implied.
- Put Phase 2A catalog constraints and role behavior in the dedicated catalog persistence and RLS
  files described by [Catalog testing](catalog-testing.md).
- Put Phase 2B inventory ledger, balance, concurrency, and role behavior in the dedicated inventory
  files described by [Inventory testing](inventory-testing.md).
- Test both accepted states and important rejection paths, especially cross-tenant references,
  uniqueness, lifecycle timing, and delete behavior.
- When a new layer requires infrastructure, document its prerequisites, cleanup, secrets boundary,
  CI status, and troubleshooting path.

For RLS changes, exercise positive and negative access as `authenticated`, absence of access as
`anon`, and the documented `service_role` boundary. Re-run from reset and review the explicit
foundational or catalog table set; policy tests complement portable PostgreSQL constraints rather
than replace them.

## Troubleshooting by layer

- **Install:** verify the supported Node.js and pnpm versions, then inspect the first frozen-lockfile
  error rather than regenerating dependencies casually.
- **Format:** run `pnpm format`, inspect the resulting files, and rerun `pnpm format:check`.
- **Lint/typecheck:** start with the first source diagnostic; later errors may be consequences.
- **Vitest/OpenAPI drift:** run the reported test directly if needed and regenerate committed output
  only from its source schema.
- **Identity/authorization:** run `pnpm test:authorization`; distinguish provider verification,
  binding/lifecycle context, Permission, ownership, and scope failures using the safe error code.
- **Authorization repository:** run `pnpm test:authorization:integration`; inspect Docker, local API
  ports, reset/fixture output, and then the first adapter assertion. Local keys must stay captured.
- **Persistence:** separate Docker-engine, PostgreSQL-readiness, migration, and SQL-assertion errors
  using [Docker database testing](../docker/database-testing.md).
- **Supabase/RLS:** inspect Docker, first-run image pulls, port `54322`, migration output, then the
  first pgTAP failure using [Local Supabase development](supabase-local.md).
- **Build/SDK pack:** confirm earlier type and test layers pass, then inspect emitted/package file
  lists for missing or accidentally included artifacts.

On Windows, use `pnpm.cmd` if PowerShell execution policy prevents the `pnpm.ps1` shim from running.

## Security and environment boundaries

Tests must never depend on production credentials or mutate a shared database. Keep secrets out of
fixtures, snapshots, logs, generated OpenAPI, and SDK packages. Deterministic authorization tests
use no network; all database environments are local and disposable. The adapter runner passes its
captured local service key only to its child Vitest process and never prints it. Passing the suites
proves the tested provider adapter boundary, mapping/evaluation behavior, database policies, and
Supabase roles—not live Clerk configuration, provisioning workflows, production deployment,
backups, or operational recovery.

For the schema under test, see [Foundational schema](../database/foundational-schema.md). For safe
migration authoring, see [Database migrations](../database/migrations.md).
