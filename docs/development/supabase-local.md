# Local Supabase Development

## Purpose

The repository uses the official Supabase CLI and its Docker-based local PostgreSQL environment to
exercise behavior that the lightweight persistence runner cannot model: Supabase database roles,
request claims, row-level security (RLS), and privileged-role bypass. It is a security-integration
test environment, not a production replica and not a cloud Supabase project.

Both database paths are intentional:

| Command                         | Environment                                          | Responsibility                                                                 |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm test:persistence`         | Temporary `postgres:17.6-alpine` container           | Fast migration, constraint, foreign-key, and structural checks                 |
| `pnpm test:catalog:persistence` | Temporary `postgres:17.6-alpine` container           | Catalog relationship, lifecycle, uniqueness, and pricing checks                |
| `pnpm test:rls`                 | Official local Supabase PostgreSQL plus pgTAP runner | Supabase roles, JWT/request claims, RLS policies, and tenant-isolation attacks |
| `pnpm test:catalog:rls`         | Official local Supabase PostgreSQL plus pgTAP runner | Catalog isolation, mutation denial, anon denial, and service-role access       |

Neither command needs an `.env` file, a Supabase login, a linked cloud project, or production
credentials.

## Files and configuration

- `supabase/config.toml` identifies this local project, pins PostgreSQL major version 17, publishes
  local PostgreSQL on port `54322`, and disables seed execution.
- `supabase/migrations/` is the single append-only schema history used by both database runners.
- `supabase/tests/phase_1c_b_tenant_rls.test.sql` contains transactional pgTAP fixtures and policy
  assertions.
- `supabase/tests/phase_2a_catalog_rls.test.sql` contains the catalog-specific transactional pgTAP
  fixtures and policy assertions.
- `scripts/test-rls.mjs` owns the disposable start/reset/test/stop lifecycle.
- `package.json` pins Supabase CLI `2.115.0` as a development dependency and provides short commands.
- `.gitignore` excludes CLI branch and temporary state; migrations, tests, and `config.toml` remain
  versioned.

Change ports or service configuration only in `supabase/config.toml`, then document the reason.
Never add a cloud project reference, access token, database password, JWT signing secret, service
key, or generated local credential output to version control.

## Prerequisites and first setup

Install Node.js 24+, pnpm 10.33.1, and Docker Desktop (Windows/macOS) or Docker Engine (Linux). Give
Docker enough memory and disk for the official PostgreSQL and one-shot test images. Then run from
the repository root:

```powershell
pnpm install --frozen-lockfile
docker version
pnpm exec supabase --version
```

The first start downloads pinned Supabase images and is slower than later starts. The CLI may use
short-lived initialization images even though the long-running stack is database-only.

## Commands and lifecycle

```powershell
# Start the repository's minimal long-running local stack.
pnpm supabase:start

# Show the local database URL and stopped/excluded services.
pnpm supabase:status

# Recreate the database and apply every migration; no seed file is run.
pnpm supabase:reset

# Stop this project's stack and discard its local volumes/data.
pnpm supabase:stop

# Own the full disposable lifecycle and run all Phase 1C-B pgTAP assertions.
pnpm test:rls

# Own the same lifecycle and run all Phase 2A catalog pgTAP assertions.
pnpm test:catalog:rls
```

`pnpm test:rls` verifies Docker and the pinned CLI, starts this project, resets the database from the
complete migration history, verifies the reviewed 87-assertion plan, runs the RLS test file, and
executes `supabase stop --no-backup` in a `finally` cleanup path. The runner checks the single plan
declaration against its approved count before Docker startup; pgTAP separately fails if execution
does not produce that declared count. It stops on a failed start, reset, or assertion and still
attempts cleanup. The test fixtures run inside a transaction and roll back; the final stop also
deletes the local project data. Treat all data in this local stack as disposable.

`pnpm test:catalog:rls` follows the same lifecycle with a reviewed 43-assertion catalog plan and
its own test file/runner.

Do not run either RLS command when you need to preserve manual local test data. Stop or save that work
first. The command targets only the Supabase project ID `clothing-commerce-api`; it does not prune,
stop, or delete unrelated Docker workloads.

## Services and containers

Phase 1C-B needs the Supabase PostgreSQL image and the CLI's temporary pgTAP (`pg_prove`) runner.
The start command excludes Auth/GoTrue, Realtime, Storage, image proxy, API gateway, mail server,
PostgREST, database metadata, Studio, Edge Runtime, analytics, Vector, and Supavisor. This is a
supported CLI exclusion mode and keeps the security test focused on database behavior.

The expected persistent container while started is named like
`supabase_db_clothing-commerce-api`. The CLI can also create short-lived setup/health-check or
`pg_prove` containers. After either RLS test or `pnpm supabase:stop`, no container or volume for
this project should remain. Use these read-only checks when diagnosing cleanup:

```powershell
docker ps -a --filter label=com.supabase.cli.project=clothing-commerce-api
pnpm supabase:status
```

Use `pnpm supabase:stop` to remove this project's resources. Never use `docker system prune`, broad
container deletion, or volume deletion as part of this workflow.

## Modifying migrations or policies safely

1. Add a new timestamped migration; never rewrite an applied migration.
2. Update structural assertions when the database shape intentionally changes.
3. Add positive and adversarial RLS assertions, including every affected operation and role.
4. Run both persistence commands and both RLS commands.
5. Repeat both RLS commands to prove reset/recreation is deterministic.
6. Review policies, grants, helper volatility, function security mode, fixed `search_path`, and
   service-role behavior before review.

The RLS security model and table matrix are in [Tenant isolation and RLS](../security/tenant-rls.md).
The migration rules are in [Database migrations](../database/migrations.md).

## Troubleshooting

- **Docker command or daemon failure:** start Docker, run `docker version`, and confirm the server
  section succeeds. Docker client presence alone is insufficient.
- **First run is slow:** watch Docker Desktop downloads; Supabase initialization and pgTAP images
  are downloaded once and cached locally.
- **Port `54322` is occupied:** stop the process using it or deliberately change `[db].port` in
  `supabase/config.toml`. Do not point tests at an existing database.
- **Stack already running or stale:** run `pnpm supabase:status`, then `pnpm supabase:stop`, and retry.
- **Migration error:** use the first named migration and PostgreSQL diagnostic. Also run
  `pnpm test:persistence` to distinguish portable DDL from Supabase-role behavior.
- **Bad pgTAP plan or assertion:** run `pnpm test:rls`; inspect the first SQL line reported. Fixtures
  are transaction-scoped, so a failed run does not require manual row cleanup.
- **Image pull/network failure:** retry after registry connectivity is restored; no cloud Supabase
  account is involved.
- **Windows script policy:** use `pnpm.cmd` if PowerShell blocks the `pnpm.ps1` shim.
- **Unexpected project container remains:** use `pnpm supabase:stop`, then verify with the label
  filter above. Do not remove unrelated containers.

## Development versus production

Local claims are set directly by the pgTAP test to simulate the trusted values PostgREST would
provide after JWT verification. That direct session setup is not a client authorization mechanism.
Production identity verification, claim issuance, refresh/revocation, application permission and
AccessScope evaluation, audit, and deployment are Phase 1D or later. Production migrations need a
separately approved promotion process; these commands must never be aimed at a remote database.
