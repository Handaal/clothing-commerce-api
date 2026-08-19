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
| Supabase/RLS tests    | `pnpm test:rls`         | Roles, request claims, RLS policy behavior, tenant attacks        | Phase 1D application authorization or production safety  |
| Build                 | `pnpm build`            | Compilation and build-time integration                            | Deployment/runtime infrastructure                        |
| SDK package check     | `pnpm sdk:pack`         | The SDK can be packaged and its included files inspected          | Publication or consumer integration in a remote registry |
| Whitespace validation | `git diff --check`      | Trailing whitespace and malformed patch markers                   | Any semantic correctness                                 |

At the Phase 1C-B review point, `pnpm test` runs four Vitest files with eleven tests, including
`tests/openapi-drift.test.ts`. The persistence SQL suite performs 27 assertions per cycle and the
runner executes two clean cycles. The RLS suite performs 87 pgTAP assertions from a reset local
Supabase database. Counts are descriptive, not a target to preserve when useful coverage is added.

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
pnpm test:rls
pnpm build
pnpm sdk:pack
git diff --check
```

`pnpm format` writes formatting changes; review its diff before continuing. Both database commands
require a running Docker engine. Neither needs an `.env` file, Supabase login, linked cloud project,
or production credentials. The RLS command owns and removes a disposable local Supabase stack; see
[Local Supabase development](supabase-local.md).

## What runs in CI

`.github/workflows/ci.yml` currently runs dependency installation with the frozen lockfile,
formatting verification, linting, type checking, Vitest, `pnpm test:persistence`, the distinct
`pnpm test:rls` security step, the build, and SDK packing. Both database layers are mandatory before
completing security-sensitive database work and in every pull request. This prevents migration,
constraint, Supabase-role, or policy failures from reaching `main` even when TypeScript and
transport tests pass.

The GitHub-hosted Ubuntu runner supplies Docker. CI invokes the same Node runner used locally, which
checks Docker availability, creates its own disposable PostgreSQL container, runs both clean test
cycles, and removes the container. The separate RLS runner uses the same repository-pinned
Supabase CLI and start/reset/test/stop lifecycle locally and in CI. The workflow defines no
persistent PostgreSQL service and uses no database or Supabase cloud credentials.

The OpenAPI drift test is part of `pnpm test`; it guards the committed generated specification
against the Zod transport source of truth. SDK packing is a separate CI step so publishable-file
mistakes are visible even when source tests pass.

## Adding or changing tests

- Put TypeScript behavior and contract tests in the existing Vitest layout and keep them
  deterministic.
- Update transport schemas first, regenerate the OpenAPI artifact through the repository command,
  and let the drift test verify that they agree.
- Put portable structural assertions in the Phase 1C-A SQL file and Supabase role/policy assertions
  in the Phase 1C-B pgTAP file. Use transaction-scoped fixtures and rollback so production seed data
  is never implied.
- Test both accepted states and important rejection paths, especially cross-tenant references,
  uniqueness, lifecycle timing, and delete behavior.
- When a new layer requires infrastructure, document its prerequisites, cleanup, secrets boundary,
  CI status, and troubleshooting path.

For RLS changes, exercise positive and negative access as `authenticated`, absence of access as
`anon`, and the documented `service_role` boundary. Re-run from reset and review all 18 tables;
policy tests complement the portable PostgreSQL constraint suite rather than replace it.

## Troubleshooting by layer

- **Install:** verify the supported Node.js and pnpm versions, then inspect the first frozen-lockfile
  error rather than regenerating dependencies casually.
- **Format:** run `pnpm format`, inspect the resulting files, and rerun `pnpm format:check`.
- **Lint/typecheck:** start with the first source diagnostic; later errors may be consequences.
- **Vitest/OpenAPI drift:** run the reported test directly if needed and regenerate committed output
  only from its source schema.
- **Persistence:** separate Docker-engine, PostgreSQL-readiness, migration, and SQL-assertion errors
  using [Docker database testing](../docker/database-testing.md).
- **Supabase/RLS:** inspect Docker, first-run image pulls, port `54322`, migration output, then the
  first pgTAP failure using [Local Supabase development](supabase-local.md).
- **Build/SDK pack:** confirm earlier type and test layers pass, then inspect emitted/package file
  lists for missing or accidentally included artifacts.

On Windows, use `pnpm.cmd` if PowerShell execution policy prevents the `pnpm.ps1` shim from running.

## Security and environment boundaries

Tests must never depend on production credentials or mutate a shared database. Keep secrets out of
fixtures, snapshots, logs, generated OpenAPI, and SDK packages. Both database environments are
local and disposable. Passing the RLS suite proves the tested database policies and Supabase roles,
not identity-provider verification, Phase 1D application authorization, production deployment,
backups, or operational recovery.

For the schema under test, see [Foundational schema](../database/foundational-schema.md). For safe
migration authoring, see [Database migrations](../database/migrations.md).
