# Clothing Commerce API

Central HTTP API, transport-contract, and SDK foundation for the Clothing Commerce Platform. In
Phase 1A-R it exposes only `GET /api/v1/health`; it deliberately has no commerce functionality.

## Boundaries and ownership

This repository is the future owner of authentication integration, authorization, tenancy,
commerce business rules, background work, external integrations, Supabase schema, append-only
migrations, and seed tooling. It does not own a storefront, POS interface, or mobile management UI.
All three clients call this API and never access privileged database tables directly.

The Zod schemas in `src/contracts` are the transport source of truth. They generate
`openapi/openapi.json` and are bundled into `@shifted/clothing-commerce-sdk`. The small Next.js
application exists only to host Route Handlers; no visual frontend is included.

## Technology

TypeScript, Next.js Route Handlers, Zod, standard `fetch`, tsup, Vitest, ESLint, Prettier, and pnpm.

## Install and develop

Requirements: Node.js 24+, pnpm 10.33.1, and Git.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The API listens at `http://localhost:3000` by default. Verify
`http://localhost:3000/api/v1/health`.

## Environment

Copy `.env.example` only when future server configuration is needed. Every listed placeholder is
server-only. Phase 1A-R requires no secret or database configuration.

## Quality and build

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm sdk:pack
```

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

See `docs/platform`, `docs/decisions`, and `docs/development/sdk-release.md`. Current scope is only
the Phase 1A-R polyrepo foundation.
