import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "../../src/authorization";
import {
  AssignStaffRoleRequestSchema,
  CreateStaffRequestSchema,
  UpdateStaffStatusRequestSchema,
} from "../../src/contracts/management/staff";
import { StaffRepository } from "../../src/staff/repository";
import { StaffService, staffCapabilities } from "../../src/staff/service";
import {
  AssignmentCatalogQuerySchema,
  EligibleIdentityLookupSchema,
  StaffListQuerySchema,
} from "../../src/staff/request";
import { contextWith, grant, location, ids, StubResourceRepository } from "../inventory/fakes";

const identity = "70000000-0000-4000-8000-0000000000aa";
const role = "90000000-0000-4000-8000-0000000000bb";
const scope = "b0000000-0000-4000-8000-0000000000cc";

describe("Staff request validation", () => {
  it.each([{}, { identityId: "not-a-uuid" }, { identityId: identity, extra: 1 }])(
    "rejects invalid create %j",
    (value) => {
      expect(CreateStaffRequestSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each([
    {},
    { status: "invited" },
    { status: "deleted" },
    { status: "active", reason: "" },
    { status: "active", extra: 1 },
  ])("rejects invalid status update %j", (value) => {
    expect(UpdateStaffStatusRequestSchema.safeParse(value).success).toBe(false);
  });

  it("accepts the three lifecycle targets", () => {
    for (const status of ["active", "suspended", "deactivated"] as const) {
      expect(UpdateStaffStatusRequestSchema.parse({ status })).toEqual({ status });
    }
  });

  it.each([
    {},
    { roleId: role },
    { accessScopeId: scope },
    { roleId: "x", accessScopeId: scope },
    { roleId: role, accessScopeId: scope, extra: 1 },
  ])("rejects invalid assignment %j", (value) => {
    expect(AssignStaffRoleRequestSchema.safeParse(value).success).toBe(false);
  });

  it("accepts a valid assignment with an optional reason", () => {
    expect(AssignStaffRoleRequestSchema.parse({ roleId: role, accessScopeId: scope })).toEqual({
      roleId: role,
      accessScopeId: scope,
    });
    expect(
      AssignStaffRoleRequestSchema.parse({ roleId: role, accessScopeId: scope, reason: " x " }),
    ).toMatchObject({ reason: "x" });
  });

  it.each([{ limit: 0 }, { limit: 101 }, { status: "deleted" }, { roleId: "x" }, { unknown: 1 }])(
    "fails closed for query %j",
    (value) => {
      expect(StaffListQuerySchema.safeParse(value).success).toBe(false);
    },
  );

  it.each([
    {},
    { email: "" },
    { email: "   " },
    { email: "dana@example.test", search: "dana" },
    { email: "dana@example.test", limit: 10 },
    { search: "dana" },
  ])("fails closed for eligible-identity lookup %j (email-only, no directory search)", (value) => {
    expect(EligibleIdentityLookupSchema.safeParse(value).success).toBe(false);
  });

  it("accepts an exact-email lookup and trims surrounding whitespace", () => {
    expect(EligibleIdentityLookupSchema.parse({ email: "  Dana@Example.test  " })).toEqual({
      email: "Dana@Example.test",
    });
  });

  it.each([{ limit: 0 }, { limit: 101 }, { search: "admin" }, { roleId: role }, { cursor: "" }])(
    "fails closed for assignment-catalog query %j (paging only, no search or filter)",
    (value) => {
      expect(AssignmentCatalogQuerySchema.safeParse(value).success).toBe(false);
    },
  );

  it("defaults the assignment-catalog page size", () => {
    expect(AssignmentCatalogQuerySchema.parse({})).toEqual({ limit: 25 });
  });
});

describe("Staff permission coupling", () => {
  const repository = new StaffRepository(createClient("https://example.test", "test-key"));
  // The login provisioner is never reached in these permission-coupling tests (authorization fails first),
  // so a throwing double proves no unauthorized call ever mints an external account.
  const loginProvisioner = {
    provisionLogin: vi.fn(async () => {
      throw new Error("login provisioner must not be called");
    }),
    deleteLogin: vi.fn(async () => {}),
  };
  const service = new StaffService(
    new AuthorizationService(new StubResourceRepository(new Map())),
    repository,
    loginProvisioner,
  );

  it("denies missing permission before persistence", async () => {
    const spy = vi.spyOn(repository, "create");
    await expect(
      service.create(contextWith([]), "key", { identityId: identity }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("denies createLogin without staff.manage and never mints an external account", async () => {
    const peek = vi.spyOn(repository, "peekCommand");
    await expect(
      service.createLogin(contextWith([grant(["staff.read"])]), "key", {
        displayName: "Dana",
        username: "dana",
        pin: "1234",
        roleId: role,
        accessScopeId: scope,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(loginProvisioner.provisionLogin).not.toHaveBeenCalled();
    expect(peek).not.toHaveBeenCalled();
    peek.mockRestore();
  });

  it("does not borrow tenant scope from a brand/branch-scoped grant", async () => {
    const context = contextWith([grant(["staff.manage"], [location(ids.locationActive)])]);
    expect(staffCapabilities(context)).toEqual({ canRead: false, canManage: false });
    await expect(service.create(context, "key", { identityId: identity })).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
  });

  it("keeps read and manage independent", async () => {
    const context = contextWith([grant(["staff.read"])]);
    expect(staffCapabilities(context)).toEqual({ canRead: true, canManage: false });
    await expect(
      service.updateStatus(context, ids.tenant, "key", { status: "suspended" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("requires staff.manage (not merely staff.read) to resolve an eligible identity by email", async () => {
    const spy = vi.spyOn(repository, "findEligibleIdentitiesByEmail");
    await expect(
      service.findEligibleIdentitiesByEmail(contextWith([grant(["staff.read"])]), {
        email: "dana@example.test",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each(["listAssignableRoles", "listAssignableScopes"] as const)(
    "requires staff.manage (not merely staff.read) for %s",
    async (operation) => {
      const spy = vi.spyOn(repository, operation);
      await expect(
        service[operation](contextWith([grant(["staff.read"])]), { limit: 25 }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      // A brand/branch-scoped staff.manage grant is likewise insufficient for a tenant-wide catalog.
      await expect(
        service[operation](contextWith([grant(["staff.manage"], [location(ids.locationActive)])]), {
          limit: 25,
        }),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    },
  );

  it("reports full capability for a tenant-wide manager", () => {
    expect(staffCapabilities(contextWith([grant(["staff.read", "staff.manage"])]))).toEqual({
      canRead: true,
      canManage: true,
    });
  });
});
