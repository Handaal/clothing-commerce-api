# Register and Device Model

## Register

**CONFIRMED:** A Register is a tenant-owned POS checkout context within exactly one Branch. It is a
business concept, not physical stock, a user, a session, or an installation.

Its conceptual profile includes immutable internal identity, direct tenant identity, branch,
branch-unique register code, display name, operational status, and a default inventory location.
Future register sessions and sales refer to the Register but are outside Phase 1B.

The default inventory location must belong to the same tenant and branch, be active, and be
sellable. Multiple Registers may share it.

### Inventory source changes

**RECOMMENDED:** A Register may switch its default source only through a controlled, authorized,
audited operation. A future active register session should pin its source for the relevant
transaction/session rather than reinterpret old sales when the default changes. The application
must reject a source owned by another branch or tenant.

Register deactivation prevents new sessions or sales. Archive preserves historical sessions,
orders, receipts, and assignments. Codes are never reused within the branch.

## Device

**CONFIRMED:** A Device is the enrolled identity of a physical device or software installation,
primarily a future Electron POS terminal. It is not a Register. Reinstalling software may produce a
new installation identity even on the same hardware.

Its conceptual profile includes immutable device identity, direct tenant identity, installation
identifier, device type, display name, activation/revocation state, enrollment time, last-seen time,
app version, and non-authoritative platform/OS metadata. Branch and Register are assignments, not
device identity.

Metadata supplied by a client is untrusted diagnostic data. It cannot activate a device, select a
tenant, or grant permissions.

## Assignment and security rules

- **RECOMMENDED:** A device belongs to exactly one tenant enrollment. It cannot be active in
  multiple tenants. Moving to another tenant requires revocation and fresh enrollment.
- **RECOMMENDED:** A device may be reassigned between Registers in the same tenant through an
  authorized workflow. Register assignment history is append-preserved with effective times,
  actor, and reason.
- **RECOMMENDED:** A device's Branch is derived from or validated against its current Register
  assignment; persistence may carry direct branch context for safe querying but must reject
  disagreement.
- **RECOMMENDED:** Default to at most one active Device per Register and one active Register
  assignment per Device. Preserve a relationship model capable of sequential reassignment.
- **DEFERRED:** Concurrent multiple devices on one Register may be allowed only after cash-session,
  receipt numbering, peripheral, and support implications are understood.
- **CONFIRMED:** Multiple Registers may share one InventoryLocation; no Device owns inventory.

## Revocation behavior

**RECOMMENDED:** Revocation is security-terminal for the enrollment. A revoked device cannot
authenticate, refresh credentials, start or resume a register session, synchronize mutations, or
select inventory. Server-side checks must take effect independently of UI state. Re-enrollment
creates new credentials and an explicit audit link; it does not silently clear revocation.

Offline revocation behavior and the maximum offline authorization window are
**HIGH — REQUIRES FOUNDER DECISION** before offline POS authentication ships. This does not block
Phase 1C foundational identity/assignment persistence.

## Audit requirements

Audit device enrollment, activation, revocation, credential rotation, register reassignment,
branch-context change, and register source-location change. Capture actor, old/new assignment or
state, timestamp, reason, request/client metadata, and correlation identifier. Last-seen telemetry
is operational data and need not produce a domain audit event for every heartbeat.
