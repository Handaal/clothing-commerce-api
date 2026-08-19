# Persistence Conventions

## Scope

These conventions guide the next migration-design phase. They are conceptual and introduce no SQL
schema, migration, API contract, or ID generator.

## Identifier strategy

| Candidate               | Evaluation                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UUIDv4                  | Distributed and well supported, but random insertion has poor index locality and carries no useful creation ordering.                                                                            |
| UUIDv7                  | Distributed, time-ordered, URL-safe in ordinary UUID form, and improves index locality while retaining a very large random component. Time ordering is diagnostic, not authoritative audit time. |
| Database-generated UUID | Central and simple for online server-created records, but cannot alone identify records created during future offline workflows. Generation location is separate from UUID version.              |
| Sequential bigint       | Compact and index-friendly, but exposes enumeration, complicates distributed/offline creation, and requires coordination across systems.                                                         |
| Human business code     | Useful for staff, receipts, labels, and imports, but mutable/formatted and scoped; unsuitable as primary identity.                                                                               |

**RECOMMENDED:** Use UUIDv7 as the platform-wide internal primary identity convention. Generate it
at the authoritative creation boundary: normally server/database infrastructure, and in explicitly
designed future offline workflows on trusted application code. Validate supplied UUIDs and never
derive authorization, timestamps, or trust from their embedded time component.

Future offline POS commands also need unique idempotency/command identifiers. Client-generated
record identity does not authorize creation and does not replace server conflict resolution.

Expose opaque internal IDs in APIs/URLs where stable references are needed. Keep human-facing codes
as separate normalized fields. Do not expose sequential database keys as public identity.

## Business-code uniqueness

| Value                  | Recommended uniqueness boundary                             |
| ---------------------- | ----------------------------------------------------------- |
| Tenant slug            | Global, normalized, across all lifecycle states             |
| Brand code             | Tenant, normalized, across all lifecycle states             |
| Branch code            | Tenant, normalized, across all lifecycle states             |
| Warehouse code         | Tenant, normalized, across all lifecycle states             |
| InventoryLocation code | Tenant, normalized, across all lifecycle states             |
| Register code          | Branch, normalized, across all lifecycle states             |
| Device installation ID | Global for an enrollment/install identity                   |
| Membership             | Tenant plus UserIdentity for the current logical membership |
| Role name              | Tenant, normalized, across all lifecycle states             |
| Permission name        | Global, normalized, immutable                               |

Normalization should define trimming, Unicode normalization, and case behavior before constraints
ship. **RECOMMENDED:** Business codes and slugs are never reused after archival. This preserves
historical imports, external references, receipts, and operator understanding.

Tenant slug changes are controlled and audited. The immutable tenant ID remains canonical. Slug
alias/redirect behavior is **DEFERRED** until public routing exists; old slugs remain reserved.

## Lifecycle policy

Operational `status` and archive metadata are preferred over a universal `deleted_at` flag. Status
expresses domain behavior; archive metadata records who/when/reason. Exact status enums are decided
with schemas in Phase 1C.

| Entity            | Recommended lifecycle                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Tenant            | Provision/onboard, activate, suspend, archive; no normal hard delete after any dependency/history. |
| Brand             | Activate/inactivate/archive; archive blocks new use and preserves catalog/history.                 |
| Branch            | Activate/temporarily inactivate/archive through dependency closeout.                               |
| Warehouse         | Activate/temporarily inactivate/archive through stock/logistics closeout.                          |
| InventoryLocation | Activate/inactivate/archive only after inventory and defaults are safely resolved.                 |
| Register          | Activate/deactivate/archive; retain sessions, sales, and assignment history.                       |
| Device            | Enroll/activate/revoke; revocation is retained and fail-closed.                                    |
| Membership        | Invite/activate/suspend/deactivate; preserve assignments and provenance.                           |
| Role              | Activate/archive; resolve active assignments first and preserve role history.                      |

Hard deletion is limited to proven-empty provisioning mistakes under a privileged maintenance
process or a separately governed legal/privacy process. It is never an ordinary tenant operation.
Once financial or inventory activity exists, referential and audit history wins over deletion.

## Auditability

Future audit events are append-preserved and conceptually capture event type, tenant context,
actor (user, service, or system), target type and ID, old/new state or bounded change summary,
timestamp, reason, request/correlation ID, client type/version, device identity where applicable,
and relevant network metadata subject to privacy policy.

Audit at minimum:

- Tenant status, slug, and ownership-sensitive settings changes;
- Brand, Branch, Warehouse, InventoryLocation, and Register creation/status/archive/capability changes;
- Branch supported-brand and Register source-location changes;
- Device enrollment, activation, revocation, and Register assignment;
- Membership invitation, activation, suspension, and deactivation;
- Role creation/archive, role assignment, Permission grant/removal, and AccessScope/target changes.

Routine profile edits may use a lower-severity audit category but are not silently untraceable.
Audit records are not a substitute for domain history such as the future inventory movement ledger.
Audit table design and retention are **DEFERRED**.

## Time, text, and addresses

- Store instants in UTC and retain explicit IANA timezones on tenants/physical locations for local
  business interpretation.
- Currency codes use ISO 4217; locale tags use BCP 47; country codes use an approved ISO standard.
- Codes have a stored display form and deterministic normalized comparison form where needed.
- Structured addresses and contact information use reusable value shapes but do not create a
  generic Facility entity.
- Mutable JSON/settings require owned schemas and versioning; arbitrary unvalidated blobs are not a
  substitute for domain modeling.
