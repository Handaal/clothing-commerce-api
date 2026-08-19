# ADR-003: Versioned SDK Contract

- Status: Accepted
- Date: 2026-08-19

## Decision

Canonical Zod schemas generate OpenAPI and are bundled into the versioned
`@shifted/clothing-commerce-sdk`. SDK releases use semantic versioning. Clients consume packaged
artifacts rather than source packages.

## Consequences

Contract drift is testable, clients validate responses consistently, and installed clients upgrade
on independent schedules. The Phase 1A-R registry bootstrap uses vendored pnpm-packed tarballs;
future releases use an approved private registry.
