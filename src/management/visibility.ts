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
