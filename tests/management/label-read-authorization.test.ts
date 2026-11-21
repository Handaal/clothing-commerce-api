import { describe, expect, it, vi } from "vitest";

import {
  AuthorizationError,
  type AuthorizationContext,
  type AuthorizationService,
} from "../../src/authorization";
import type { EffectiveAuthorizationAssignment } from "../../src/authorization/model";
import { authorizeCatalogLabelRead } from "../../src/catalog/label-read-authorization";

const BRAND = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function contextWith(
  permissionKeys: readonly string[],
  brandScoped: boolean,
): AuthorizationContext {
  const assignment: EffectiveAuthorizationAssignment = {
    assignmentId: "assignment",
    roleId: "role",
    isProtectedRole: false,
    accessScopeId: "scope",
    scopeMode: brandScoped ? "explicit" : "tenant",
    scopeTargets: brandScoped ? [{ kind: "brand", id: BRAND }] : [],
    permissionKeys,
  };
  return {
    authentication: { provider: "clerk", subject: "user_1" },
    userIdentity: { id: "11111111-1111-1111-1111-111111111111" },
    tenant: { id: "22222222-2222-2222-2222-222222222222" },
    membership: { id: "33333333-3333-3333-3333-333333333333" },
    assignments: [assignment],
  };
}

function fakeAuthorization(allowed: (key: string) => boolean) {
  const authorize = vi.fn(async (_context: unknown, request: { permissionKey: string }) => {
    if (!allowed(request.permissionKey)) throw new AuthorizationError("PERMISSION_DENIED");
    return { permissionKey: request.permissionKey } as never;
  });
  return { service: { authorize } as unknown as AuthorizationService, authorize };
}

describe("authorizeCatalogLabelRead", () => {
  it("keeps the author path for catalogue authors", async () => {
    const { service, authorize } = fakeAuthorization(() => true);
    await authorizeCatalogLabelRead(
      service,
      contextWith(["catalog.author"], false),
      "catalog.author",
    );
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("lets a brand-scoped catalogue reader (a cashier) list labels", async () => {
    const { service, authorize } = fakeAuthorization((key) => key === "catalog.read");
    await authorizeCatalogLabelRead(service, contextWith(["catalog.read"], true), "catalog.author");
    expect(authorize).toHaveBeenLastCalledWith(expect.anything(), {
      permissionKey: "catalog.read",
      resources: [{ kind: "brand", id: BRAND }],
    });
  });

  it("still refuses members without any catalogue read", async () => {
    const { service } = fakeAuthorization(() => false);
    await expect(
      authorizeCatalogLabelRead(service, contextWith(["orders.read"], false), "catalog.author"),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
