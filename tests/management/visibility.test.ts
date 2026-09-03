import { describe, expect, it } from "vitest";

import type { AuthorizationContext } from "../../src/authorization";
import type {
  AuthorizationResource,
  EffectiveAuthorizationAssignment,
} from "../../src/authorization/model";
import {
  deriveCatalogReadVisibility,
  deriveInventoryReadVisibility,
  deriveInventoryWriteCapability,
  deriveInventoryWriteScope,
  deriveOrderReadVisibility,
  ManagementWritePermission,
  type InventoryLocationCapability,
} from "../../src/management/visibility";

function assignment(
  permissionKeys: readonly string[],
  scope:
    | { readonly mode: "tenant" }
    | { readonly mode: "explicit"; readonly targets: readonly AuthorizationResource[] },
): EffectiveAuthorizationAssignment {
  return {
    assignmentId: "assignment",
    roleId: "role",
    isProtectedRole: false,
    accessScopeId: "scope",
    scopeMode: scope.mode,
    scopeTargets: scope.mode === "explicit" ? scope.targets : [],
    permissionKeys,
  };
}

function contextWith(
  assignments: readonly EffectiveAuthorizationAssignment[],
): AuthorizationContext {
  return {
    authentication: { provider: "clerk", subject: "user_1" },
    userIdentity: { id: "11111111-1111-1111-1111-111111111111" },
    tenant: { id: "22222222-2222-2222-2222-222222222222" },
    membership: { id: "33333333-3333-3333-3333-333333333333" },
    assignments,
  };
}

const BRAND_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BRAND_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BRANCH_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LOCATION_A = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const WAREHOUSE_A = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const LOCATION_B = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const LOCATION_W = "99999999-9999-9999-9999-999999999999";

describe("catalog read visibility", () => {
  it("returns not-readable with no assignment", () => {
    expect(deriveCatalogReadVisibility(contextWith([]))).toEqual({
      canRead: false,
      tenantWide: false,
      brandIds: [],
    });
  });

  it("is tenant-wide for a tenant-scope grant", () => {
    const context = contextWith([assignment(["catalog.read"], { mode: "tenant" })]);
    expect(deriveCatalogReadVisibility(context)).toEqual({
      canRead: true,
      tenantWide: true,
      brandIds: [],
    });
  });

  it("unions explicit brand targets", () => {
    const context = contextWith([
      assignment(["catalog.read"], {
        mode: "explicit",
        targets: [
          { kind: "brand", id: BRAND_A },
          { kind: "brand", id: BRAND_B },
        ],
      }),
    ]);
    const visibility = deriveCatalogReadVisibility(context);
    expect(visibility.canRead).toBe(true);
    expect(visibility.tenantWide).toBe(false);
    expect([...visibility.brandIds].sort()).toEqual([BRAND_A, BRAND_B].sort());
  });

  it("is not-readable when only a wrong-kind (branch) target is granted", () => {
    const context = contextWith([
      assignment(["catalog.read"], {
        mode: "explicit",
        targets: [{ kind: "branch", id: BRANCH_A }],
      }),
    ]);
    expect(deriveCatalogReadVisibility(context)).toEqual({
      canRead: false,
      tenantWide: false,
      brandIds: [],
    });
  });
});

describe("inventory read visibility", () => {
  it("is tenant-wide for a tenant-scope grant", () => {
    const context = contextWith([assignment(["inventory.read"], { mode: "tenant" })]);
    expect(deriveInventoryReadVisibility(context)).toEqual({
      canRead: true,
      tenantWide: true,
      locationIds: [],
    });
  });

  it("unions explicit inventory_location targets", () => {
    const context = contextWith([
      assignment(["inventory.read"], {
        mode: "explicit",
        targets: [{ kind: "inventory_location", id: LOCATION_A }],
      }),
    ]);
    expect(deriveInventoryReadVisibility(context)).toEqual({
      canRead: true,
      tenantWide: false,
      locationIds: [LOCATION_A],
    });
  });

  it("is not-readable when only a wrong-kind (brand) target is granted", () => {
    const context = contextWith([
      assignment(["inventory.read"], {
        mode: "explicit",
        targets: [{ kind: "brand", id: BRAND_A }],
      }),
    ]);
    expect(deriveInventoryReadVisibility(context)).toEqual({
      canRead: false,
      tenantWide: false,
      locationIds: [],
    });
  });
});

describe("order read visibility", () => {
  it("is tenant-wide for a tenant-scope grant", () => {
    const context = contextWith([assignment(["orders.read"], { mode: "tenant" })]);
    expect(deriveOrderReadVisibility(context)).toEqual({
      canRead: true,
      tenantWide: true,
      brandIds: [],
      branchIds: [],
    });
  });

  it("unions brand and branch targets that coexist", () => {
    const context = contextWith([
      assignment(["orders.read"], {
        mode: "explicit",
        targets: [
          { kind: "brand", id: BRAND_A },
          { kind: "branch", id: BRANCH_A },
        ],
      }),
    ]);
    expect(deriveOrderReadVisibility(context)).toEqual({
      canRead: true,
      tenantWide: false,
      brandIds: [BRAND_A],
      branchIds: [BRANCH_A],
    });
  });

  it("is not-readable when only a wrong-kind (warehouse) target is granted", () => {
    const context = contextWith([
      assignment(["orders.read"], {
        mode: "explicit",
        targets: [{ kind: "warehouse", id: WAREHOUSE_A }],
      }),
    ]);
    expect(deriveOrderReadVisibility(context)).toEqual({
      canRead: false,
      tenantWide: false,
      brandIds: [],
      branchIds: [],
    });
  });

  it("ignores assignments that do not grant the permission", () => {
    const context = contextWith([
      assignment(["orders.create"], {
        mode: "explicit",
        targets: [{ kind: "brand", id: BRAND_A }],
      }),
    ]);
    expect(deriveOrderReadVisibility(context).canRead).toBe(false);
  });
});

describe("inventory write scope", () => {
  it("has no scope without the permission", () => {
    expect(deriveInventoryWriteScope(contextWith([]), ManagementWritePermission.receive)).toEqual({
      hasScope: false,
      tenantWide: false,
      locationIds: [],
    });
  });

  it("is tenant-wide for a tenant-scope grant", () => {
    const context = contextWith([assignment(["inventory.receive"], { mode: "tenant" })]);
    expect(deriveInventoryWriteScope(context, ManagementWritePermission.receive)).toEqual({
      hasScope: true,
      tenantWide: true,
      locationIds: [],
    });
  });

  it("unions explicit inventory_location targets", () => {
    const context = contextWith([
      assignment(["inventory.transfer"], {
        mode: "explicit",
        targets: [
          { kind: "inventory_location", id: LOCATION_A },
          { kind: "inventory_location", id: LOCATION_B },
        ],
      }),
    ]);
    const scope = deriveInventoryWriteScope(context, ManagementWritePermission.transfer);
    expect(scope.hasScope).toBe(true);
    expect(scope.tenantWide).toBe(false);
    expect([...scope.locationIds].sort()).toEqual([LOCATION_A, LOCATION_B].sort());
  });

  it("has no scope for a wrong-kind-only (brand) target", () => {
    const context = contextWith([
      assignment(["inventory.adjust"], {
        mode: "explicit",
        targets: [{ kind: "brand", id: BRAND_A }],
      }),
    ]);
    expect(deriveInventoryWriteScope(context, ManagementWritePermission.adjust)).toEqual({
      hasScope: false,
      tenantWide: false,
      locationIds: [],
    });
  });
});

const NO_SCOPE = { hasScope: false, tenantWide: false, locationIds: [] } as const;
const TENANT_WIDE = { hasScope: true, tenantWide: true, locationIds: [] } as const;
function explicitScope(...locationIds: readonly string[]) {
  return { hasScope: true, tenantWide: false, locationIds } as const;
}

// LA: fully enabled + active. LB: transfer-origin only. LW: receive + transfer-destination (no origin).
const ALL_FLAGS_ACTIVE: Omit<InventoryLocationCapability, "id" | "name"> = {
  status: "active",
  isReceivingEnabled: true,
  isTransferOriginEnabled: true,
  isTransferDestinationEnabled: true,
};
const LA: InventoryLocationCapability = { id: LOCATION_A, name: "Location A", ...ALL_FLAGS_ACTIVE };
const LB: InventoryLocationCapability = {
  id: LOCATION_B,
  name: "Location B",
  status: "active",
  isReceivingEnabled: false,
  isTransferOriginEnabled: true,
  isTransferDestinationEnabled: false,
};
const LW: InventoryLocationCapability = {
  id: LOCATION_W,
  name: "Location W",
  status: "active",
  isReceivingEnabled: true,
  isTransferOriginEnabled: false,
  isTransferDestinationEnabled: true,
};

describe("inventory write capability derivation", () => {
  it("reports no capability for a read-only caller (no write scope)", () => {
    const capability = deriveInventoryWriteCapability(
      { receive: NO_SCOPE, adjust: NO_SCOPE, transfer: NO_SCOPE },
      [],
    );
    expect(capability).toEqual({
      canReceive: false,
      canAdjust: false,
      canTransfer: false,
      locations: [],
    });
  });

  it("combines tenant-wide write scope with each location's operational flags", () => {
    const capability = deriveInventoryWriteCapability(
      { receive: TENANT_WIDE, adjust: TENANT_WIDE, transfer: TENANT_WIDE },
      [LA, LB, LW],
    );
    expect(capability.canReceive).toBe(true);
    expect(capability.canAdjust).toBe(true);
    // A valid origin (LA/LB) and a distinct valid destination (LA/LW) exist.
    expect(capability.canTransfer).toBe(true);

    const byId = Object.fromEntries(capability.locations.map((l) => [l.id, l]));
    expect(byId[LOCATION_A]).toMatchObject({
      canReceive: true,
      canAdjust: true,
      canTransferOrigin: true,
      canTransferDestination: true,
    });
    // LB is receive-disabled and destination-disabled.
    expect(byId[LOCATION_B]).toMatchObject({
      canReceive: false,
      canAdjust: true,
      canTransferOrigin: true,
      canTransferDestination: false,
    });
    // LW is a receive target and transfer destination but not a transfer origin.
    expect(byId[LOCATION_W]).toMatchObject({
      canReceive: true,
      canAdjust: true,
      canTransferOrigin: false,
      canTransferDestination: true,
    });
  });

  it("a caller scoped to a single location cannot transfer to itself", () => {
    const scoped = explicitScope(LOCATION_A);
    const capability = deriveInventoryWriteCapability(
      { receive: scoped, adjust: scoped, transfer: scoped },
      [LA],
    );
    expect(capability.canReceive).toBe(true);
    expect(capability.canAdjust).toBe(true);
    // LA is both a valid origin and destination, but a transfer needs two DISTINCT locations.
    expect(capability.canTransfer).toBe(false);
    expect(capability.locations[0]).toMatchObject({
      canTransferOrigin: true,
      canTransferDestination: true,
    });
  });

  it("never marks a location outside the permission's scope as a write target", () => {
    // Transfer scope covers only LA; LB is hydrated (e.g. by another permission) but must stay closed.
    const capability = deriveInventoryWriteCapability(
      { receive: NO_SCOPE, adjust: NO_SCOPE, transfer: explicitScope(LOCATION_A) },
      [LA, LB],
    );
    const byId = Object.fromEntries(capability.locations.map((l) => [l.id, l]));
    expect(byId[LOCATION_A].canTransferOrigin).toBe(true);
    expect(byId[LOCATION_B]).toMatchObject({
      canReceive: false,
      canAdjust: false,
      canTransferOrigin: false,
      canTransferDestination: false,
    });
  });

  it("respects independent per-permission scopes on the same location", () => {
    // Receive is granted (tenant-wide) but adjust/transfer are not: only receive resolves true.
    const capability = deriveInventoryWriteCapability(
      { receive: TENANT_WIDE, adjust: NO_SCOPE, transfer: NO_SCOPE },
      [LA],
    );
    expect(capability).toMatchObject({ canReceive: true, canAdjust: false, canTransfer: false });
    expect(capability.locations[0]).toMatchObject({
      canReceive: true,
      canAdjust: false,
      canTransferOrigin: false,
      canTransferDestination: false,
    });
  });

  it("closes an archived location and gates an inactive one to adjust/origin only", () => {
    const archived: InventoryLocationCapability = {
      id: LOCATION_A,
      name: "Archived",
      ...ALL_FLAGS_ACTIVE,
      status: "archived",
    };
    const inactive: InventoryLocationCapability = {
      id: LOCATION_B,
      name: "Inactive",
      ...ALL_FLAGS_ACTIVE,
      status: "inactive",
    };
    const capability = deriveInventoryWriteCapability(
      { receive: TENANT_WIDE, adjust: TENANT_WIDE, transfer: TENANT_WIDE },
      [archived, inactive],
    );
    const byId = Object.fromEntries(capability.locations.map((l) => [l.id, l]));
    expect(byId[LOCATION_A]).toMatchObject({
      canReceive: false,
      canAdjust: false,
      canTransferOrigin: false,
      canTransferDestination: false,
    });
    // Inactive: adjust and transfer-out (evacuation) allowed; receive and transfer-in require active.
    expect(byId[LOCATION_B]).toMatchObject({
      canReceive: false,
      canAdjust: true,
      canTransferOrigin: true,
      canTransferDestination: false,
    });
  });
});
