# Docker Strategy

## Role of Docker

Docker is an execution and packaging tool for this platform; it is not a domain boundary. The API
continues to own the commerce core, transport contracts, SDK, database schema, and migrations
whether a process runs locally, in CI, or in a production container.

The strategy has three distinct contexts. Only the first is implemented today.

| Context                        | Current state | Intended use                                                   |
| ------------------------------ | ------------- | -------------------------------------------------------------- |
| PostgreSQL migration test      | Implemented   | Disposable PostgreSQL 17.6 for DDL and constraint verification |
| Local Supabase integration     | Deferred      | Phase 1C-B RLS, auth-context, and policy verification          |
| Production application runtime | Deferred      | API and web workloads deployed as versioned containers         |

## Local development today

`pnpm test:persistence` starts a single temporary `postgres:17.6-alpine` container. It publishes no
host port, uses temporary in-memory storage, contains no production secret, and is removed after
the run. This provides a reproducible PostgreSQL boundary without requiring a developer to install
or maintain a local database service.

It is deliberately not the Supabase local stack. Portable DDL and structural constraints can be
tested cheaply at this layer. Future RLS and request-context behavior needs Supabase-aware local
infrastructure because those tests depend on platform conventions beyond a plain PostgreSQL
container.

See [Docker database testing](database-testing.md) for commands, lifecycle, and troubleshooting.

## Continuous integration

The current GitHub Actions workflow runs install, formatting, linting, type checking, unit/contract
tests, the same disposable `pnpm test:persistence` workflow used locally, the build, and SDK package
verification. Persistence failures fail the pull request job. The GitHub-hosted Ubuntu runner's
Docker engine runs the test-managed PostgreSQL container; the workflow does not provision a
persistent database service or use production credentials.

A future CI change may add a Supabase-aware suite and production-image validation. Those changes
must define runner support, image caching, timeouts, cleanup, credentials, and useful failure
artifacts rather than assuming local Docker behavior.

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
deployment automation, or production migration command is implemented in Phase 1C-A.

## Development versus production

| Concern          | Development migration test                      | Intended production                              |
| ---------------- | ----------------------------------------------- | ------------------------------------------------ |
| Database         | Disposable PostgreSQL 17.6 container            | Managed Supabase PostgreSQL                      |
| Data lifetime    | Temporary `tmpfs`, discarded after each run     | Durable managed storage with backups             |
| Network          | No host database port                           | Restricted encrypted service connectivity        |
| Credentials      | Fixed disposable local values inside the runner | Runtime-injected secrets                         |
| Workloads        | Database test only                              | API/storefront/future worker containers          |
| Schema promotion | Rebuild from empty migrations                   | Future controlled, append-only migration process |
| RLS/auth context | Not tested in Phase 1C-A                        | Required before tenant application access        |

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

The current Docker coverage proves migration construction against PostgreSQL 17.6 only. It does not
prove Supabase RLS behavior, production networking, persistent-volume behavior, managed backup
recovery, production resource sizing, rolling deployment, or disaster recovery. Those capabilities
must be designed and verified in their approved future phases.
