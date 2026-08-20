# ADR-015: Category and Collection Model

- Status: Accepted
- Date: 2026-08-19

## Context

Catalog classification and merchandising campaigns have different semantics. Categories need
simple nesting; collections such as seasonal edits need curated membership without becoming a
taxonomy or speculative rule engine.

## Decision

- Category is a Tenant-owned single-parent hierarchy. A tenant-safe self-FK, self-parent CHECK, and
  ancestor-walking trigger prevent foreign parents and cycles.
- The ancestor-walking trigger first takes a Tenant-scoped transaction advisory lock
  (`pg_advisory_xact_lock(hashtextextended(tenant_id, 0))`). This serializes concurrent hierarchy
  mutations within one Tenant so two reparents cannot each pass cycle detection against a stale
  snapshot and then both commit a cycle. Distinct Tenants hash to distinct keys and stay parallel; a
  rare hash collision only serializes two Tenants and never weakens integrity. A closure table or
  materialized path is intentionally not used at this complexity level.
- ProductCategory is tenant-safe many-to-many; products may appear in multiple categories.
- Collection is a Tenant-owned flat merchandising grouping with draft/active/archive lifecycle.
- ProductCollection is ordered, manual, tenant-safe many-to-many membership.
- All three entity slugs (Product, Category, Collection) are tenant-scoped, normalized, and
  lifecycle-wide non-reusable. UUID remains identity.

## Alternatives rejected

- One category column on Product: prevents multiple classification paths.
- General graph taxonomy: permits ambiguous ancestry and exceeds current needs.
- Treat Collection as Category: conflates classification with campaigns/curation.
- Dynamic collection rules and schedules now: require query/publication behavior not yet designed.

## Consequences

Hierarchy reads may use recursive queries; no closure table is needed yet. Association rows may be
removed where safe, while entity archive preserves durable identity. Dynamic collections,
publication timing, and slug redirects remain later decisions. A later mechanism change (for example
a closure table) must keep the same guarantees: single parent, same-Tenant ancestry, self-parent
rejection, cycle rejection, and safe concurrency; the two-session regression in
`scripts/test-catalog-concurrency.mjs` guards the concurrency guarantee.
