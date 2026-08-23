# ADR-020: Inventory Application Service Boundary

- Status: Accepted
- Date: 2026-08-22

## Context

Phase 2B built the inventory engine: an append-only operation/movement ledger with a maintained
`inventory_balances` projection, written only through the hardened `SECURITY DEFINER`
`inventory_private.record_operation`. That function is infrastructure. If future commerce domains
(Orders, Purchasing, Returns, POS, Storefront) called it directly they would depend on ledger
mechanics — signed `quantity_delta`, movement JSON, the `payload_fingerprint`, SQLSTATEs, the
`inventory_writer` role, the balance-write GUC — and could bypass business rules and centralized
authorization. There is no TypeScript domain layer yet; the authorization module is the only
established pattern.

## Decision

- Introduce a flat `src/inventory/` application module (matching the existing flat module convention,
  not nested domain/application/infrastructure folders) exposing an `InventoryService` with six
  intent-named commands: `getInventoryBalance`, `setOpeningStock`, `adjustInventory`,
  `receiveInventory`, `issueInventory`, `transferInventory`.
- All authorization reuses Phase 1D `executeAuthorizedOperation`: a permission key plus target
  `InventoryLocation` resource(s), evaluated by the existing authorization service. No new
  authorization engine, no role-name checks, no Clerk-metadata authorization. `service_role` is a
  database credential, never an authorization decision.
- A narrow, module-internal `InventoryRepository` port hides all ledger detail. It exposes typed
  methods (`recordOpening`, `recordCountAdjustment`, `recordReceipt`, `recordIssue`, `recordTransfer`,
  plus reads) and never a generic `recordOperation`, a raw client, SQL, movement JSON, signed deltas,
  or an RPC name. Other domains never receive this repository.
- The `SupabaseInventoryRepository` adapter holds a private service-role client, asserts the
  authorization proof before any privileged access, builds the movement shape internally, calls the
  sanctioned functions, and maps every database error to a stable `InventoryError`. Raw SQLSTATEs and
  database messages never escape it.
- The private functions are reached over PostgREST via the exposed `inventory_private` schema; the
  EXECUTE grants (service_role only) remain the enforcement boundary, not the schema exposure.

## Alternatives rejected

- **Expose `record_operation` (or a generic `recordOperation` port) to application services:** leaks
  ledger semantics and lets callers construct arbitrary signed movements, defeating the boundary.
- **A public SECURITY DEFINER wrapper per function:** more public surface than exposing the private
  schema to PostgREST behind the same grants.
- **Nested domain/application/infrastructure folders:** inconsistent with the repository's existing
  flat modules.

## Consequences

The rest of the system expresses stock intent through a single, authorized, testable boundary; the
Phase 2B privilege model is unchanged and unweakened. Future Orders/Purchasing/Returns/POS integrate
by calling these commands (or a future HTTP API in front of them), never the ledger. Adding a new
intent means adding a command with its own permission and lifecycle rules, keeping the port narrow.
