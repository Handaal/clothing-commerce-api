# Phase 2M validation record

Starting main: `1c01b81dceb971081d68d6ba7ef7825d1cfad3f1` (Phase 2L merge).
Branch: `phase/2m-returns-refunds-core`. Work is confined to the Commerce API repository.
Existing generated `AGENTS.md` and `next-env.d.ts` changes were preserved in the named stash
`preserve generated Next dev files before phase 2m` before switching to clean main.

SDK advanced from main's `0.7.0` to additive release `0.8.0`. Two independent final build/pack runs
produced the same SHA-256:

`3bc355f638426993a7d7bd69c818855b1776540630d9701f03c770aa3fae3056`

Artifact: `artifacts/shifted-clothing-commerce-sdk-0.8.0.tgz` (ignored local distribution artifact).
The packed SDK installed in a fresh consumer and passed ESM, CommonJS and strict TypeScript checks
with `skipLibCheck:false`, including typed return operations and transitive Zod resolution.

## Executed checks

- Frozen install, Prettier format/check, ESLint, strict API/SDK TypeScript, production Next.js build,
  and `git diff --check`.
- 229 unit tests across 19 files, including 8 return contract checks and 17 SDK tests.
- 57 identity and application authorization tests across five files.
- 13 OpenAPI structure/drift checks (also included in the unit total).
- 19 real Next.js HTTP acceptance tests against disposable Supabase/PostgreSQL. Authentication uses
  locally signed sessions through the actual Clerk verifier. No inventory or refund-integrity mocks.
- 228 pgTAP assertions across seven RLS suites: 22 return-specific assertions plus foundation,
  catalog, inventory, orders, fulfillment and online security regressions.
- Focused PostgreSQL 17 return persistence: 20 assertions and two expected-error checks, with canonical
  POS sale, two partial returns, restock/non-restock, replay, quantity protection and immutable originals.
- Foundation, catalog, inventory, inventory operations, orders, fulfillment and management persistence
  suites each replay all migrations twice from an empty disposable database schema. Their cleanup now
  includes the new private schema before the second replay.

The HTTP suite proves tenant/branch/brand containment; create/refund/receive permissions and revoked
permission replay; missing authentication/idempotency; line containment and injected totals; policy
boundaries; immutable snapshot economics; pending-to-settled cash refunds; independent monetary
ceilings; concurrent final-quantity contention; concurrent exact replay; and rollback after an injected
failure at the final refund insert. The rollback leaves no return, refund or stock receipt.

Runtime scenarios A-D passed: a two-unit POS sale followed by a one-unit cash return and one-unit
restock; rejection of two additional units; non-restock with no sellable increase; and exact retry with
the same Return, Refund and inventory operation identifiers. Order detail exposes returned quantities.
Full and multiple partial returns are covered. ONLINE pending COD is denied; captured and fulfilled
COD uses the same domain. Electronic refund state remains pending, and manual electronic settlement
is denied. Test-only privileged fixtures establish captured electronic facts; no gateway was called
or represented as successfully refunding money.

## Local environment incident

An early version of the new isolated test runner routed its final Supabase `stop --no-backup` to the
repository directory instead of its temporary project. This removed the existing local development
Supabase database volume. The mistake was reported to the user during execution. The local stack was
restarted and its services are healthy, but its previous data was not recovered; no backup restoration
is claimed. This was a local environment loss, not a production deployment or a source-code change.

The runner now defaults subprocesses to its unique temporary project, explicitly runs Vitest from
the repository, and keeps Next.js and database resources separate from the regular development stack.
Subsequent full runs passed and left the restarted development database container running. Cleanup
removes the temporary node_modules link before deleting only the validated temporary directory.

The subsequent [test infrastructure safety closeout](phase-2m-test-isolation.md) records the exact
destructive path, adds fail-closed ownership guards, and proves live development resources remain
unchanged across the corrected runners. The incident history above is retained.

## Remaining business and operational decisions

Live tenant returns and manual refunds remain disabled by default. Production return windows, reason
codes, condition inspection, cross-branch receiving policy, approval thresholds/dual approval,
settlement evidence retention, exchanges, fees and unpaid COD handling still need decisions.
No policy-administration UI, electronic provider, refund worker or production settlement workflow is
introduced. See [returns and refunds core](../returns/returns-refunds-core.md) for transaction rules,
permissions, routes, configuration, provider staging and operational limitations.
