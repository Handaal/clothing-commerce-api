# ADR-011: Foundational PostgreSQL Physical Design

- Status: Proposed
- Date: 2026-08-19

## Context

Phase 1C-A translates the approved organizational and identity architecture into the first
PostgreSQL migrations. Three physical choices were intentionally left for this phase: a UUID
generation path compatible with current Supabase PostgreSQL, a referentially safe representation of
heterogeneous AccessScope targets, and an evolvable lifecycle-value strategy.

[PostgreSQL 18 provides the native `uuidv7()` function](https://www.postgresql.org/docs/18/functions-uuid.html),
but the current Supabase PostgreSQL guidance and local compatibility target are PostgreSQL 17.
[Supabase documents UUIDv7 for PostgreSQL 17 as a custom extension](https://supabase.com/docs/guides/self-hosting/custom-postgres-extensions).
Adding that extension would introduce deployment-specific compiled code solely for a default-value
optimization.

PostgreSQL cannot attach a foreign key from one generic `(target_type, target_id)` pair to several
resource tables. Such a shape would leave target existence and tenant ownership to application
code.

## Decision

- Store every internal identifier in PostgreSQL's native `uuid` type.
- Use the PostgreSQL 17 built-in `gen_random_uuid()` UUIDv4 generator as the Phase 1C-A database
  default. The columns accept trusted UUIDv7 values without schema changes. Adopt native
  `uuidv7()` through a future append-only migration after the deployed Supabase PostgreSQL version
  supports it; do not install a custom extension.
- Represent `access_scope_targets` with four nullable concrete foreign-key columns: `brand_id`,
  `branch_id`, `warehouse_id`, and `inventory_location_id`. A CHECK constraint requires exactly one.
  Each concrete column has a composite tenant-safe foreign key.
- Copy the constant `explicit` scope mode into each target row and include it in the AccessScope
  foreign key. This prevents tenant-wide scopes from acquiring explicit target rows without a
  trigger or unverified application convention.
- Use text lifecycle columns with table-specific CHECK constraints rather than PostgreSQL enums.
  This keeps allowed states explicit while permitting append-only constraint evolution.
- Keep `created_at` and `updated_at` explicit. This phase adds no update trigger; writers must set
  `updated_at` in the same mutation until a reviewed persistence service owns that behavior.

## Alternatives rejected

- A custom SQL or native UUIDv7 generator: unnecessary cryptographic and deployment risk while the
  native PostgreSQL 18 function is not the Supabase compatibility floor.
- Requiring callers to supply every UUID: preserves UUIDv7 but makes safe server-created records
  unnecessarily dependent on an application generator before a persistence service exists.
- Generic target type plus UUID: PostgreSQL cannot enforce target existence or tenant sameness.
- One target table per resource type: referentially safe but fragments one conceptual relationship
  and multiplies migrations and query paths without adding semantics.
- PostgreSQL enums: harder to evolve transactionally as lifecycle contracts mature.

## Consequences

Phase 1C-A defaults are UUIDv4 rather than the preferred UUIDv7. Identity remains opaque,
distributed, and non-sequential, and future UUIDv7 inputs remain type-compatible. No authorization
or ordering may rely on UUID timestamp bits.

AccessScope targets use a wider row but retain ordinary foreign keys, direct tenant identity, and
future RLS-friendly indexes. Adding a new target kind requires an append-only migration adding its
column, foreign key, uniqueness/index rules, and extending the exactly-one-target constraint.

Lifecycle states are constrained consistently without freezing them into PostgreSQL enum types.
Application services and Phase 1C-B/1D still own state-transition authorization and behavior.
