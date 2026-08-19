# Docker Strategy

## Role of Docker

Docker is an execution and packaging tool for this platform; it is not a domain boundary. The API
continues to own the commerce core, transport contracts, SDK, database schema, and migrations
whether a process runs locally, in CI, or in a production container.

The strategy has three distinct contexts. The two development/test contexts are implemented today.

| Context                        | Current state | Intended use                                                    |
| ------------------------------ | ------------- | --------------------------------------------------------------- |
| PostgreSQL migration test      | Implemented   | Disposable PostgreSQL 17.6 for DDL and constraint verification  |
| Local Supabase integration     | Implemented   | Phase 1C-B roles, request context, RLS, and policy verification |
| Production application runtime | Deferred      | API and web workloads deployed as versioned containers          |

## Local development today

`pnpm test:persistence` starts a single temporary `postgres:17.6-alpine` container. It publishes no
host port, uses temporary in-memory storage, contains no production secret, and is removed after
the run. This provides a reproducible PostgreSQL boundary without requiring a developer to install
or maintain a local database service.

It is deliberately not the Supabase local stack. Portable DDL and structural constraints can be
tested cheaply at this layer. `pnpm test:rls` separately starts the official local Supabase
PostgreSQL environment, resets the same migration history, runs pgTAP using actual Supabase roles,
and removes the project data. Long-running services unrelated to Phase 1C-B are excluded; the CLI
may use short-lived initialization and pgTAP images.

See [Docker database testing](database-testing.md) for the fast runner and
[Local Supabase development](../development/supabase-local.md) for commands, services, lifecycle,
safe cleanup, and troubleshooting.

## Continuous integration

The current GitHub Actions workflow runs install, formatting, linting, type checking, unit/contract
tests, the same disposable `pnpm test:persistence` workflow used locally, a separate mandatory
`pnpm test:rls` step, the build, and SDK package verification. The GitHub-hosted Ubuntu runner's
Docker engine supports both repository-owned runners. Each creates and removes its own database
environment; the workflow provisions no persistent service and uses no production or cloud
Supabase credentials.

## Intended production boundary

The documented deployment direction is a Hostinger KVM VPS running Docker Compose for the API,
storefront, a future worker, and a reverse proxy when introduced. Managed Supabase remains outside
that Compose stack by default and supplies PostgreSQL and future platform services over an
authenticated, encrypted connection.

This boundary supports reproducible releases, independent service rollout, clear ownership in the
polyrepo model, and application rollback without pretending that rolling back an image also rolls
back database state. Database migrations remain append-only and require their own safe promotion
process.

No production Dockerfile, Compose manifest, reverse-proxy configuration, registry workflow,
deployment automation, or production migration command is implemented in Phase 1C-B.

## Development versus production

| Concern          | Fast migration test                  | Local Supabase security test                    | Intended production                              |
| ---------------- | ------------------------------------ | ----------------------------------------------- | ------------------------------------------------ |
| Database         | Disposable PostgreSQL 17.6           | Official Supabase PostgreSQL 17                 | Managed Supabase PostgreSQL                      |
| Data lifetime    | Temporary `tmpfs`                    | Local project data discarded by test/stop       | Durable managed storage with backups             |
| Network          | No host database port                | Local port `54322`                              | Restricted encrypted service connectivity        |
| Credentials      | Fixed disposable runner values       | CLI-generated local-only values                 | Runtime-injected secrets                         |
| Workloads        | PostgreSQL only                      | PostgreSQL plus one-shot setup/pgTAP containers | API/storefront/future worker containers          |
| Schema promotion | Rebuild from empty migrations        | Reset from empty migrations                     | Future controlled, append-only migration process |
| RLS/auth context | Metadata only, no Supabase roles/JWT | Tested as `authenticated`, `anon`, service role | Required with application authorization          |

## Security and operations principles

- Never bake database credentials, signing keys, or other server secrets into images or SDK
  artifacts.
- Inject production configuration at runtime through an approved secret mechanism.
- Use least-privilege database identities and restricted networks; the API must not make privileged
  credentials client-visible.
- Pin and review base images, scan release artifacts, and define upgrade ownership before production
  rollout.
- Define TLS termination, health checks, resource limits, logging, backup/restore verification, and
  incident recovery as part of the deployment phase.
- Treat database migration and application-image rollback as separate operational decisions.

These are forward constraints, not claims of completed infrastructure. See
[Deployment boundaries](../platform/deployment-boundaries.md) for service ownership and
[Database migrations](../database/migrations.md) for schema-history rules.

## Known limitations

Current Docker coverage proves clean migration construction against PostgreSQL 17.6 and the tested
Supabase RLS behavior. It does not prove identity-provider verification, Phase 1D application
authorization, production networking, persistent-volume behavior, managed backup recovery,
production resource sizing, rolling deployment, or disaster recovery. Those capabilities must be
designed and verified in their approved future phases.
