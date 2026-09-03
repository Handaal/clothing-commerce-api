import type { AuthorizationContext } from "../authorization";
import type { EffectiveAuthorizationAssignment } from "../authorization/model";

/**
 * Domain-specific pure derivation of read visibility from a genuine AuthorizationContext. This is NOT a
 * generic SQL authorization engine: each function projects the effective assignments into the exact,
 * minimal shape one management list endpoint needs, with no hierarchy inference whatsoever.
 *
 * Frozen `canRead` semantics (identical across domains):
 *   - no granting assignment                       -> canRead=false, tenantWide=false, ids=[]
 *   - a granting assignment with scopeMode "tenant" -> canRead=true,  tenantWide=true,  ids=[]
 *   - explicit grant(s) with >=1 relevant target    -> canRead=true,  tenantWide=false, ids=union
 *   - explicit grant(s) with ZERO relevant targets  -> canRead=false, tenantWide=false, ids=[]
 *
 * "Relevant" target kinds are fixed per permission: catalog.read -> brand; inventory.read ->
 * inventory_location; orders.read -> brand and/or branch. A wrong-kind-only scope (e.g. orders.read
 * against a warehouse, or catalog.read against a branch) yields canRead=false.
 */

export const ManagementReadPermission = {
  catalog: "catalog.read",
  inventory: "inventory.read",
  orders: "orders.read",
} as const;

export interface CatalogReadVisibility {
  readonly canRead: boolean;
  readonly tenantWide: boolean;
  /** Non-empty only when canRead && !tenantWide. */
  readonly brandIds: readonly string[];
}

export interface InventoryReadVisibility {
  readonly canRead: boolean;
  readonly tenantWide: boolean;
  /** Non-empty only when canRead && !tenantWide. */
  readonly locationIds: readonly string[];
}

export interface OrderReadVisibility {
  readonly canRead: boolean;
  readonly tenantWide: boolean;
  /** Brand scope for ONLINE orders; non-empty only when canRead && !tenantWide. */
  readonly brandIds: readonly string[];
  /** Branch scope for POS orders; non-empty only when canRead && !tenantWide. */
  readonly branchIds: readonly string[];
}

function grantingAssignments(
  assignments: readonly EffectiveAuthorizationAssignment[],
  permissionKey: string,
): readonly EffectiveAuthorizationAssignment[] {
  return assignments.filter((assignment) => assignment.permissionKeys.includes(permissionKey));
}

function hasTenantWideGrant(granting: readonly EffectiveAuthorizationAssignment[]): boolean {
  return granting.some((assignment) => assignment.scopeMode === "tenant");
}

function unionExplicitTargetIds(
  granting: readonly EffectiveAuthorizationAssignment[],
  kind: "brand" | "branch" | "inventory_location",
): string[] {
  const ids = new Set<string>();
  for (const assignment of granting) {
    if (assignment.scopeMode !== "explicit") {
      continue;
    }
    for (const target of assignment.scopeTargets) {
      if (target.kind === kind) {
        ids.add(target.id);
      }
    }
  }
  return [...ids];
}

export function deriveCatalogReadVisibility(context: AuthorizationContext): CatalogReadVisibility {
  const granting = grantingAssignments(context.assignments, ManagementReadPermission.catalog);
  if (granting.length === 0) {
    return { canRead: false, tenantWide: false, brandIds: [] };
  }
  if (hasTenantWideGrant(granting)) {
    return { canRead: true, tenantWide: true, brandIds: [] };
  }
  const brandIds = unionExplicitTargetIds(granting, "brand");
  if (brandIds.length === 0) {
    return { canRead: false, tenantWide: false, brandIds: [] };
  }
  return { canRead: true, tenantWide: false, brandIds };
}

export function deriveInventoryReadVisibility(
  context: AuthorizationContext,
): InventoryReadVisibility {
  const granting = grantingAssignments(context.assignments, ManagementReadPermission.inventory);
  if (granting.length === 0) {
    return { canRead: false, tenantWide: false, locationIds: [] };
  }
  if (hasTenantWideGrant(granting)) {
    return { canRead: true, tenantWide: true, locationIds: [] };
  }
  const locationIds = unionExplicitTargetIds(granting, "inventory_location");
  if (locationIds.length === 0) {
    return { canRead: false, tenantWide: false, locationIds: [] };
  }
  return { canRead: true, tenantWide: false, locationIds };
}

/**
 * Inventory WRITE-capability derivation for /me/context UX guidance ONLY. This mirrors — but never
 * replaces — the server-side authorization the POST routes perform inside InventoryService. Each
 * capability combines THREE independent facts and is true only when all three hold:
 *   1. permission        — the caller holds inventory.receive / inventory.adjust / inventory.transfer
 *   2. authorization scope — that grant is tenant-wide, or explicitly targets the location
 *   3. location operational capability — the location's status + capability flags permit the op
 * Scope alone never implies capability, and a flag alone never implies permission; both are required,
 * fail-closed, exactly as the mutation path enforces at request time.
 */

export const ManagementWritePermission = {
  receive: "inventory.receive",
  adjust: "inventory.adjust",
  transfer: "inventory.transfer",
} as const;

export interface InventoryWriteScope {
  /** True when the caller holds the permission with at least one usable inventory_location target. */
  readonly hasScope: boolean;
  readonly tenantWide: boolean;
  /** Explicit inventory_location targets; non-empty only when hasScope && !tenantWide. */
  readonly locationIds: readonly string[];
}

/** Per-permission write scope. Same fail-closed semantics as read visibility (wrong-kind-only => none). */
export function deriveInventoryWriteScope(
  context: AuthorizationContext,
  permissionKey: string,
): InventoryWriteScope {
  const granting = grantingAssignments(context.assignments, permissionKey);
  if (granting.length === 0) {
    return { hasScope: false, tenantWide: false, locationIds: [] };
  }
  if (hasTenantWideGrant(granting)) {
    return { hasScope: true, tenantWide: true, locationIds: [] };
  }
  const locationIds = unionExplicitTargetIds(granting, "inventory_location");
  if (locationIds.length === 0) {
    return { hasScope: false, tenantWide: false, locationIds: [] };
  }
  return { hasScope: true, tenantWide: false, locationIds };
}

/** True when the permission's scope covers this specific location (tenant-wide or explicitly targeted). */
export function writeScopeCoversLocation(scope: InventoryWriteScope, locationId: string): boolean {
  if (!scope.hasScope) {
    return false;
  }
  return scope.tenantWide || scope.locationIds.includes(locationId);
}

/** Operational facts of a candidate write location, read from the inventory_locations row. */
export interface InventoryLocationCapability {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "inactive" | "archived";
  readonly isReceivingEnabled: boolean;
  readonly isTransferOriginEnabled: boolean;
  readonly isTransferDestinationEnabled: boolean;
}

export interface InventoryWriteLocationCapability {
  readonly id: string;
  readonly name: string;
  readonly canReceive: boolean;
  readonly canAdjust: boolean;
  readonly canTransferOrigin: boolean;
  readonly canTransferDestination: boolean;
}

export interface InventoryWriteCapability {
  readonly canReceive: boolean;
  readonly canAdjust: boolean;
  readonly canTransfer: boolean;
  readonly locations: readonly InventoryWriteLocationCapability[];
}

export interface InventoryWriteScopes {
  readonly receive: InventoryWriteScope;
  readonly adjust: InventoryWriteScope;
  readonly transfer: InventoryWriteScope;
}

/**
 * Pure combination of the three write scopes with each candidate location's operational capability.
 * The per-location rules mirror InventoryService exactly:
 *   - receive:            receiving-enabled AND status active
 *   - adjust:             status not archived (active or inactive)
 *   - transfer origin:    transfer-origin-enabled AND status not archived
 *   - transfer dest:      transfer-destination-enabled AND status active
 * Each is additionally gated by the matching permission's scope covering the location. Top-level
 * booleans report whether the op is actually performable somewhere: transfer requires a valid origin
 * AND a valid destination at two DISTINCT locations (a single location cannot transfer to itself).
 */
export function deriveInventoryWriteCapability(
  scopes: InventoryWriteScopes,
  locations: readonly InventoryLocationCapability[],
): InventoryWriteCapability {
  const perLocation = locations.map((location) => {
    const notArchived = location.status !== "archived";
    const active = location.status === "active";
    return {
      id: location.id,
      name: location.name,
      canReceive:
        writeScopeCoversLocation(scopes.receive, location.id) &&
        location.isReceivingEnabled &&
        active,
      canAdjust: writeScopeCoversLocation(scopes.adjust, location.id) && notArchived,
      canTransferOrigin:
        writeScopeCoversLocation(scopes.transfer, location.id) &&
        location.isTransferOriginEnabled &&
        notArchived,
      canTransferDestination:
        writeScopeCoversLocation(scopes.transfer, location.id) &&
        location.isTransferDestinationEnabled &&
        active,
    };
  });

  const origins = perLocation.filter((location) => location.canTransferOrigin);
  const destinations = perLocation.filter((location) => location.canTransferDestination);
  const canTransfer = origins.some((origin) =>
    destinations.some((destination) => destination.id !== origin.id),
  );

  return {
    canReceive: perLocation.some((location) => location.canReceive),
    canAdjust: perLocation.some((location) => location.canAdjust),
    canTransfer,
    locations: perLocation,
  };
}

export function deriveOrderReadVisibility(context: AuthorizationContext): OrderReadVisibility {
  const granting = grantingAssignments(context.assignments, ManagementReadPermission.orders);
  if (granting.length === 0) {
    return { canRead: false, tenantWide: false, brandIds: [], branchIds: [] };
  }
  if (hasTenantWideGrant(granting)) {
    return { canRead: true, tenantWide: true, brandIds: [], branchIds: [] };
  }
  const brandIds = unionExplicitTargetIds(granting, "brand");
  const branchIds = unionExplicitTargetIds(granting, "branch");
  if (brandIds.length === 0 && branchIds.length === 0) {
    return { canRead: false, tenantWide: false, brandIds: [], branchIds: [] };
  }
  return { canRead: true, tenantWide: false, brandIds, branchIds };
}
