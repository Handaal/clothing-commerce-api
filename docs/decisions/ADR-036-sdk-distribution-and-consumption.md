# ADR-036: SDK Distribution and Consumption

- Status: Accepted
- Date: 2026-08-30

## Context

`@shifted/clothing-commerce-sdk` is the validated, platform-neutral client the first external repo
(`clothing-commerce-admin-mobile`) will consume. Phase 2F adds the management methods and must freeze a
distribution mechanism that does not require the API repo's source, workspace resolution, or sibling
paths after installation.

## Decision

- **Version 0.2.0 (additive).** The management contracts and methods are additive over 0.1.0, so the SDK
  minor version is bumped to `0.2.0`. The root package version is unchanged.
- **fetch-based client with injection seams.** `createCommerceClient({ baseUrl, client, getToken })`
  keeps standard `fetch`. `getToken` is the Clerk user/session-token seam (the SDK never owns Clerk UI or
  session state). Tenant context is immutable and per-client via `client.withTenant(tenantId)` — no
  hidden mutable global state. The SDK sends `Authorization`, `X-Tenant-Id`, `X-Client-Type`, and
  `X-Client-Version`, parses the external error envelope into typed errors, and returns the paginated
  contract. It never accepts service-role credentials.
- **Self-contained packaging.** The existing tsup/shared-contract build bundles the contract validators
  into the published package (no OpenAPI codegen). `zod` is declared as the SDK's single runtime
  dependency because the public declarations import it; the consumer's package manager installs it
  transitively from the tarball. A post-build step strips esbuild's module-path banner comments so the
  tarball references no `../../src` in substance or text. The packed SDK requires no API-repo source,
  workspace resolution, or sibling paths after install — only its declared `zod` dependency.
- **Versioned tarball handoff.** `pnpm sdk:pack` produces
  `artifacts/shifted-clothing-commerce-sdk-0.2.0.tgz`. Its filename, version, and SHA256 are recorded in
  the SDK consumption doc. Phase 2F-A does NOT copy the tarball into Admin Mobile. Phase 2F-B copies the
  exact versioned tarball into `clothing-commerce-admin-mobile/vendor/`, commits it in the mobile repo,
  and references it with a relative `file:vendor/…` dependency — never an absolute path, sibling import,
  workspace dependency, or git submodule.
- **Tarball self-containment test.** `pnpm test:sdk` builds, typechecks, unit-tests, packs, then in a
  genuinely isolated temp project installs ONLY the tarball (never installing `zod` itself), asserts no
  `../../src`/workspace references and that the packed manifest declares its `zod` runtime dependency,
  imports the package via ESM and CJS, and runs a strict `skipLibCheck: false` TypeScript typecheck of the
  public types so a future missing declaration dependency fails the gate.

## Consequences

- The first external consumer installs a frozen, self-contained artifact with a recorded checksum.
- A future private registry can replace the vendored tarball without changing consumer code.
- The SDK's type safety is guaranteed by the same Zod contracts the server validates against.
