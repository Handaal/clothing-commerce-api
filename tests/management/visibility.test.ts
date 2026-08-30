import { describe, expect, it } from "vitest";

import type { AuthorizationContext } from "../../src/authorization";
import type {
  AuthorizationResource,
  EffectiveAuthorizationAssignment,
} from "../../src/authorization/model";
import {
  deriveCatalogReadVisibility,
  deriveInventoryReadVisibility,
  deriveOrderReadVisibility,
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
