# ADR-007: Register and Device Model

- Status: Proposed
- Date: 2026-08-19

## Context

A checkout identity survives hardware replacement, while an installed POS client needs revocable
security identity. Treating either as inventory would also make device or checkout changes alter
stock ownership.

## Decision

- **CONFIRMED:** Register is a tenant-owned checkout context belonging to one Branch. Device is a
  tenant-enrolled physical/software installation identity. They are distinct.
- **RECOMMENDED:** Register has a same-Branch sellable InventoryLocation as its mutable, audited
  default source; multiple Registers may share a source.
- **RECOMMENDED:** Device-to-Register assignment is historical and effective-dated conceptually. A
  Device may be reassigned within its Tenant.
- **RECOMMENDED:** Initially allow at most one active Device per Register and one active Register
  assignment per Device. Concurrent-device policy is deferred.
- **RECOMMENDED:** A Device is enrolled in one Tenant only. Cross-tenant movement requires revocation
  and fresh enrollment.
- **CONFIRMED:** Revoked Devices fail closed and cannot authenticate, refresh, synchronize
  mutations, or start/resume operational work.

## Alternatives rejected

- Device equals Register: loses checkout continuity across hardware replacement and prevents secure
  installation revocation.
- Register owns stock: moving or replacing a checkout would fragment physical inventory.
- Untracked mutable assignment: destroys evidence needed for incident and transaction analysis.
- Multi-tenant active Device: creates an unnecessary credential and isolation hazard.

## Consequences

Register source and Device assignment changes require authorization and audit. Future sessions and
transactions pin relevant context so changing defaults never rewrites history. Offline revocation
windows require founder policy before offline authentication ships.
