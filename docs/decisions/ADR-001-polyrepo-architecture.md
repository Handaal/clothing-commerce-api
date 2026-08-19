# ADR-001: Polyrepo Architecture

- Status: Accepted
- Date: 2026-08-19

## Decision

Replace the Phase 1A application monorepo with four independently versioned repositories: API,
POS, storefront, and admin mobile. They share only HTTPS contracts and packaged SDK releases, never
sibling source imports, workspaces, submodules, or absolute paths.

## Consequences

Each component owns CI, lockfile, documentation, Git history, deployment, and release timing.
Cross-repository contract changes require explicit versioning and compatibility discipline.
