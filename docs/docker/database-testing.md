# Docker Database Testing

## Purpose

`pnpm test:persistence` and `pnpm test:catalog:persistence` prove that the complete migration
history builds the approved schema and enforces foundational and catalog invariants on the
PostgreSQL compatibility target. They use Docker so tests are isolated from any developer-owned or
remote database.

In this repository those Docker terms mean:

- **Image:** the reusable `postgres:17.6-alpine` package containing PostgreSQL and its minimal Linux
  userspace.
- **Container:** one running instance created from that image for a single persistence-test run.
- **Docker Engine:** the local service that pulls the image and creates, runs, and removes the
  container. The Node runner talks to it through the Docker CLI.
- **Ephemeral container:** a disposable container whose database state is expected to disappear
  after the test; it is never a source of durable project data.
- **Port:** a network endpoint that could make container PostgreSQL reachable from the host. This
  runner publishes no database port because `psql` executes inside the container.
- **Volume:** persistent storage that can outlive a container. This runner creates no database
  volume; it mounts PostgreSQL's data directory as temporary `tmpfs` storage instead.

## Requirements and configuration

- Docker Desktop or another compatible Docker engine must be installed and running.
- Docker must be able to run Linux containers and pull `postgres:17.6-alpine`.
- Run the command from the repository root after `pnpm install`.
- No `.env` file, Supabase project, remote database URL, or production credential is required.

PostgreSQL 17.6 is pinned because it is the Phase 1C compatibility target. The Alpine image keeps
the disposable test footprint small; it does not define the production hosting topology.

## What the runner does

The implementation is in `scripts/test-persistence.mjs`, with the package command declared in
`package.json`. One run performs these steps:

1. Confirms that the Docker server is reachable with `docker version`.
2. Starts `postgres:17.6-alpine` with a process-specific name such as
   `clothing-commerce-persistence-12345`.
3. Gives the container a fixed disposable database name and password, mounts PostgreSQL data as
   `tmpfs`, and publishes no host port.
4. Polls `pg_isready` for up to approximately 60 seconds.
5. Creates non-login `anon`, `authenticated`, and `service_role` role fixtures so Supabase-targeted
   policy declarations can be constructed in plain PostgreSQL. They are test-only role names, not
   credentials or a simulation of JWT behavior.
6. Discovers all `.sql` files in `supabase/migrations/` and applies them in filename order through
   `psql` with `ON_ERROR_STOP=1`.
7. Runs `supabase/tests/phase_1c_a_foundational_persistence.sql`. Its fixtures and assertions are
   enclosed in a transaction that is rolled back.
8. Drops the private `commerce_context` schema, then drops and recreates the public schema.
9. Repeats the complete migration and SQL test cycle from empty state.
10. Force-removes the exact disposable container in a `finally` cleanup path, including after most
    failures. A cleanup failure is reported and makes the process fail.

The second cycle tests repeatable reconstruction, not SQL-file idempotency. Individual migrations
are expected to run once in order against the state produced by their predecessors.

`scripts/test-catalog-persistence.mjs` follows the same safety lifecycle with its own
`clothing-commerce-catalog-persistence-<pid>` container. It runs the dedicated catalog SQL file in
both cycles and explicitly removes `catalog_private`, `commerce_context`, and `public` between them.

`scripts/test-inventory-persistence.mjs` and `scripts/test-inventory-concurrency.mjs` follow the same
lifecycle with `clothing-commerce-inventory-persistence-<pid>` and
`clothing-commerce-inventory-concurrency-<pid>` containers. The persistence runner runs the dedicated
inventory SQL file in both cycles and additionally removes `inventory_private` between them; the
concurrency runner drives real two-session balance-lock races. Both connect over container-internal
TCP `127.0.0.1:5432` with an explicit `PGPASSWORD` and never publish a host port — see
[Inventory testing](../development/inventory-testing.md).

## GitHub Actions CI

The repository CI workflow runs `pnpm test:persistence` on its GitHub-hosted Ubuntu runner after the
unit/OpenAPI tests and before the build. This is the same runner and disposable-container lifecycle
used locally: CI does not define a persistent PostgreSQL service, publish a database port, or use
production or Supabase cloud credentials.

CI also runs `pnpm test:catalog:persistence` and `pnpm test:inventory:persistence`, then the separate
mandatory `pnpm test:rls`, `pnpm test:catalog:rls`, and `pnpm test:inventory:rls` layers against
official local Supabase, plus the `pnpm test:catalog:concurrency` and `pnpm test:inventory:concurrency`
two-session regressions. Keeping the steps distinct preserves clear per-domain diagnostics while also
enforcing Supabase-role and policy behavior.

Persistence is a mandatory pull-request check because migration ordering, PostgreSQL constraints,
and cross-tenant rejection paths are not exercised by TypeScript or OpenAPI tests. A failing Docker
availability check, image pull, migration, SQL assertion, or container cleanup makes the CI job
fail. Migration and invariant labels are printed before their SQL executes so the failing layer is
visible in the Actions log.

## Commands

Run the suite:

```powershell
pnpm test:persistence
pnpm test:catalog:persistence
pnpm test:inventory:persistence
pnpm test:inventory:concurrency
```

Check whether the Docker engine is reachable:

```powershell
docker version
```

Inspect only containers created by this runner:

```powershell
docker ps --filter "name=clothing-commerce-persistence-"
docker ps -a --filter "name=clothing-commerce-persistence-"
docker ps --filter "name=clothing-commerce-catalog-persistence-"
docker ps --filter "name=clothing-commerce-inventory-persistence-"
docker ps --filter "name=clothing-commerce-inventory-concurrency-"
```

If a failed run prints an exact container name, inspect it before cleanup only if it still exists:

```powershell
docker logs <exact-container-name>
docker stop <exact-container-name>
docker rm <exact-container-name>
```

Use `docker rm --force <exact-container-name>` only for a confirmed disposable test container. Do
not use broad name expansion or remove unrelated containers or volumes.

## Understanding failures

| Failure point                  | Likely layer            | First checks                                                     |
| ------------------------------ | ----------------------- | ---------------------------------------------------------------- |
| Docker server is unreachable   | Docker engine           | Start Docker Desktop; run `docker version`                       |
| Image pull or create fails     | Docker/network/platform | Check connectivity, disk space, Linux-container mode             |
| PostgreSQL never becomes ready | PostgreSQL/container    | Inspect runner output and `docker logs` if the container remains |
| Named migration fails          | Migration SQL           | Read the first `psql` error and the named migration              |
| SQL assertion fails            | Schema invariant/test   | Compare the assertion with the migration and architecture docs   |
| Node reports spawn/pipe error  | Local runtime/tool path | Confirm `docker`, Node.js, and pnpm are available in the shell   |
| Cleanup reports a stale name   | Container cleanup       | List the exact runner prefix and remove only the disposable item |

On Windows, PowerShell execution policy can block a `.ps1` shim even when pnpm is installed. In
that situation, use `pnpm.cmd` for the same repository command. Docker Desktop normally needs its
Linux/WSL 2 engine running before the test starts. A permissions error from `docker version`
belongs to the Docker layer: confirm the current Windows user can access Docker Desktop and that
the selected Docker context points to the running local engine before investigating migration SQL.

## Modifying the runner safely

Treat the pinned image, no-host-port design, temporary storage, ordered discovery, `ON_ERROR_STOP`,
double-cycle reset, and unconditional cleanup as safety properties. If one changes, update the SQL
tests and this guide in the same change. Never add production credentials or make a remote database
the runner's implicit target.

Foundational assertions remain in Phase 1C files; catalog migration assertions and Supabase
role/RLS behavior belong in their Phase 2A files. All use transaction rollback for fixtures. Keep
failure messages specific enough to distinguish Docker startup, PostgreSQL readiness, migration
application, and invariant assertion failures.

## Development and production differences

This is a local integration-test harness, not a production database container or Supabase-role
simulator. It validates portable PostgreSQL DDL and constraints. Phase 1C-B's implemented
Supabase-aware RLS layer complements rather than replaces it; see
[Local Supabase development](../development/supabase-local.md).

Production is expected to use managed Supabase PostgreSQL and a separately containerized API. No
production Dockerfile, Compose topology, database deployment command, backup process, or secret
distribution mechanism exists in this phase. See [Docker strategy](strategy.md) for the intended
boundary and [Database migrations](../database/migrations.md) for schema-change policy.
