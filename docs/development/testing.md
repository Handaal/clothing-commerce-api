# Development Testing

## Purpose

The repository uses layered checks because no single test can prove formatting, TypeScript safety,
transport compatibility, business behavior, database integrity, and distributable output at once.
Run the smallest relevant check while developing, then run the full sequence before treating an
implementation as complete.

## Test and validation layers

| Layer                 | Command                 | What it catches                                                   | What it does not prove                                   |
| --------------------- | ----------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Formatting            | `pnpm format:check`     | Files that differ from the Prettier rules                         | Type, behavior, or database correctness                  |
| Linting               | `pnpm lint`             | Configured ESLint correctness and maintainability issues          | Runtime or PostgreSQL behavior                           |
| Type checking         | `pnpm typecheck`        | Strict TypeScript errors across configured packages               | Runtime values or SQL constraints                        |
| Unit/contract tests   | `pnpm test`             | Vitest behavior, health contracts/routes, OpenAPI drift, SDK code | Live PostgreSQL and RLS behavior                         |
| Persistence tests     | `pnpm test:persistence` | Ordered migrations and SQL invariants on PostgreSQL 17.6, twice   | Supabase RLS/auth context or production upgrade safety   |
| Build                 | `pnpm build`            | Compilation and build-time integration                            | Deployment/runtime infrastructure                        |
| SDK package check     | `pnpm sdk:pack`         | The SDK can be packaged and its included files inspected          | Publication or consumer integration in a remote registry |
| Whitespace validation | `git diff --check`      | Trailing whitespace and malformed patch markers                   | Any semantic correctness                                 |

At the Phase 1C-A review point, `pnpm test` runs four Vitest files with eleven tests, including
`tests/openapi-drift.test.ts`. The persistence SQL suite performs 27 assertions per cycle and the
runner executes two clean cycles. Counts are descriptive, not a target to preserve when useful
coverage is added.

## Recommended completion sequence

From the repository root, after installing dependencies:

```powershell
pnpm install
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:persistence
pnpm build
pnpm sdk:pack
git diff --check
```

`pnpm format` writes formatting changes; review its diff before continuing. The persistence command
requires a running Docker engine, while the other current checks do not require a database. The
persistence runner needs no `.env` file or production credentials.

## What runs in CI

`.github/workflows/ci.yml` currently runs dependency installation with the frozen lockfile,
formatting verification, linting, type checking, Vitest, `pnpm test:persistence`, the build, and SDK
packing. Persistence tests are mandatory both locally before completing database work and in every
pull request. This prevents migration-order or structural-integrity failures from reaching `main`
even when TypeScript and transport tests pass.

The GitHub-hosted Ubuntu runner supplies Docker. CI invokes the same Node runner used locally, which
checks Docker availability, creates its own disposable PostgreSQL container, runs both clean test
cycles, and removes the container. The workflow defines no PostgreSQL service and uses no database
or Supabase cloud credentials.

The OpenAPI drift test is part of `pnpm test`; it guards the committed generated specification
against the Zod transport source of truth. SDK packing is a separate CI step so publishable-file
mistakes are visible even when source tests pass.

## Adding or changing tests

- Put TypeScript behavior and contract tests in the existing Vitest layout and keep them
  deterministic.
- Update transport schemas first, regenerate the OpenAPI artifact through the repository command,
  and let the drift test verify that they agree.
- Put database structural assertions in `supabase/tests/`. Use transaction-scoped fixtures and
  rollback so production seed data is never implied.
- Test both accepted states and important rejection paths, especially cross-tenant references,
  uniqueness, lifecycle timing, and delete behavior.
- When a new layer requires infrastructure, document its prerequisites, cleanup, secrets boundary,
  CI status, and troubleshooting path.

Phase 1C-B Supabase/RLS tests are expected to add policy and authenticated-context coverage. They
will complement the portable PostgreSQL constraint suite rather than replace it.

## Troubleshooting by layer

- **Install:** verify the supported Node.js and pnpm versions, then inspect the first frozen-lockfile
  error rather than regenerating dependencies casually.
- **Format:** run `pnpm format`, inspect the resulting files, and rerun `pnpm format:check`.
- **Lint/typecheck:** start with the first source diagnostic; later errors may be consequences.
- **Vitest/OpenAPI drift:** run the reported test directly if needed and regenerate committed output
  only from its source schema.
- **Persistence:** separate Docker-engine, PostgreSQL-readiness, migration, and SQL-assertion errors
  using [Docker database testing](../docker/database-testing.md).
- **Build/SDK pack:** confirm earlier type and test layers pass, then inspect emitted/package file
  lists for missing or accidentally included artifacts.

On Windows, use `pnpm.cmd` if PowerShell execution policy prevents the `pnpm.ps1` shim from running.

## Security and environment boundaries

Tests must never depend on production credentials or mutate a shared database. Keep secrets out of
fixtures, snapshots, logs, generated OpenAPI, and SDK packages. The Phase 1C-A database test is
local and disposable; passing it does not certify production deployment, tenant RLS, authentication,
authorization, backups, or operational recovery.

For the schema under test, see [Foundational schema](../database/foundational-schema.md). For safe
migration authoring, see [Database migrations](../database/migrations.md).
