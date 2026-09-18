# Phase 2L validation record

Starting clean main: `0891859638744889cbc34809cae2cffd746b9a39` (catalog merge PR #19).
Branch: `phase/2l-online-commerce-core`. Prior latest migration:
`20260912180200_create_catalog_public_read_and_grants.sql`.

The current-main SDK was `0.6.0`, repacked SHA-256:
`622a93f6fa5561373973fd2a4676d1789847f5515baca17181bbef40d1eed5e1`.
The new SDK is `0.7.0`, with two independent build/pack runs producing identical SHA-256:
`ff94c5d34e23775afbd1ebc9180c40030d1161ca9f2c3efbf72fac5bed70c70a`.
Artifact: `artifacts/shifted-clothing-commerce-sdk-0.7.0.tgz` (ignored local distribution artifact).

Validation performed against real disposable PostgreSQL 17 and local Supabase, not inventory mocks:

- Frozen install, formatting/check, ESLint, strict TypeScript, production Next.js build.
- 220 unit tests across 18 files (includes 16 SDK tests and checkout validation).
- 13 OpenAPI structure/drift checks, also included in the unit suite.
- 18 real Next.js HTTP acceptance tests using published catalog, guest intent, PostgREST and PostgreSQL.
  The actual Clerk verifier accepts only the runner's locally signed test session for management reads.
  Cases cover exact and concurrent replay, changed intent, current price replacement, public tenant/
  brand/publication containment, customer separation, snapshots, ATS, last-unit contention, stock-write
  denial, cancellation, expiry, partial/full fulfillment, failed-issue rollback, placement rollback and
  internal payment transitions. No electronic gateway success is fabricated.
- 14 existing connected POS integration tests, including captured cash and shared fulfillment/inventory.
- 206 pgTAP assertions across six RLS suites: 20 new online assertions plus existing foundational,
  catalog, inventory, Order and Fulfillment security checks.
- Foundation, inventory, Order and Fulfillment persistence suites each replay migrations twice from an
  empty schema; the focused online PostgreSQL proof creates canonical customer/order/payment/hold rows.
- Packed SDK installed into an isolated project: ESM, CommonJS, strict consumer TypeScript with
  `skipLibCheck:false`, transitive Zod resolution and typed checkout operation.
- `git diff --check`.

Only disposable test routing explicitly enables COD. Business approval for COD and selection/capture
policy for an electronic provider remain unresolved. Passing the configured COD technical scenario
does not establish production payment-method approval. Live tenant configuration defaults to disabled.

The implementation, commands, transaction/locking rules, operational limitations and future provider
requirements are documented in [online commerce core](../orders/online-commerce-core.md).
