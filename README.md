# Clothing Commerce API

Central HTTP API, transport-contract, SDK, persistence, and staff-authorization foundation for the
Clothing Commerce Platform. It exposes only `GET /api/v1/health`; Phase 1D adds internal identity
and authorization services without adding commerce functionality or a public auth endpoint.

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
pnpm test:rls
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

`test:authorization` runs the deterministic staff identity and application-authorization suite.
It verifies provider mapping, lifecycle, Permission/AccessScope coupling, resource ownership,
protected Roles, and the privileged-operation gate without live Clerk or Supabase credentials.

`test:authorization:integration` resets a disposable local Supabase API stack and exercises the
real privileged authorization repository. It requires Docker but no cloud credentials.

`sdk:pack` creates `artifacts/shifted-clothing-commerce-sdk-0.1.0.tgz`. During registry bootstrap,
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

| Topic                      | Start here                                                                                                                                                        | Covers                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| System architecture        | [System context](docs/platform/system-context.md), [repository boundaries](docs/platform/repository-boundaries.md)                                                | Service ownership, polyrepo boundaries, and client/API relationships                 |
| Phase 1C-A architecture    | [Foundational persistence architecture](docs/architecture/phase-1c-a-foundational-persistence.md), [domain diagram](docs/architecture/phase-1b-domain-diagram.md) | Design decisions, ownership, invariants, and Phase 1C-B deferrals                    |
| Architecture decisions     | [Decision records](docs/decisions/)                                                                                                                               | Accepted/proposed ADRs, including database ownership and physical schema choices     |
| API and contracts          | [API versioning](docs/platform/api-versioning.md), [SDK contract strategy](docs/platform/sdk-contract-strategy.md)                                                | `/api/v1` compatibility, Zod/OpenAPI ownership, and SDK generation                   |
| Foundational database      | [Foundational schema guide](docs/database/foundational-schema.md)                                                                                                 | Plain-language table meanings, relationships, constraints, and limitations           |
| Migrations                 | [Migration guide](docs/database/migrations.md)                                                                                                                    | Authoritative history, adding/reviewing/testing migrations, and rollback philosophy  |
| Docker                     | [Docker strategy](docs/docker/strategy.md), [database testing](docs/docker/database-testing.md), [local Supabase](docs/development/supabase-local.md)             | Fast PostgreSQL tests, Supabase RLS tests, CI, and production direction              |
| Testing                    | [Development testing guide](docs/development/testing.md)                                                                                                          | Unit, authorization, contract drift, persistence, RLS, build, and SDK validation     |
| Development and releases   | [SDK release guide](docs/development/sdk-release.md)                                                                                                              | Local commands and the current vendored SDK release workflow                         |
| Identity and authorization | [Identity and authorization](docs/security/identity-and-authorization.md), [local authentication](docs/development/authentication-local.md)                       | Clerk trust boundary, internal identity, Permission/scope evaluation, and operations |
| Tenant security and RLS    | [Tenant RLS](docs/security/tenant-rls.md), [tenant isolation strategy](docs/architecture/tenant-isolation-strategy.md)                                            | Implemented application authorization plus database backstop and threat model        |
| Future deployment          | [Deployment boundaries](docs/platform/deployment-boundaries.md), [Docker strategy](docs/docker/strategy.md#intended-production-boundary)                          | Intended Hostinger KVM/Docker Compose direction; no deployment exists yet            |
| Troubleshooting            | [Database-test troubleshooting](docs/docker/database-testing.md#troubleshooting), [testing troubleshooting](docs/development/testing.md#troubleshooting-by-layer) | How to isolate Docker, PostgreSQL, migration, SQL-test, build, and contract failures |

## Current implementation boundary

Phase 1D adds Clerk as the initial staff identity verifier and provider-neutral, current-state
application authorization above the Phase 1C-B RLS backstop. It adds no public auth/business
endpoint, schema migration, Permission seed, customer authentication, commerce business schema,
offline POS authorization, production Docker image/Compose file, or deployment.
