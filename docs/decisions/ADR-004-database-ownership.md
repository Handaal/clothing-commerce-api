# ADR-004: Database Ownership

- Status: Accepted
- Date: 2026-08-19

## Decision

Only the API repository owns future Supabase schema, append-only migrations, and seed tooling.
Clients use the API and receive no privileged database credentials.

## Consequences

Database evolution, tenant isolation, auditability, and authoritative inventory remain centralized.
Phase 1A-R introduces no business schema or migration.
