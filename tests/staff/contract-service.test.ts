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
import { StaffListQuerySchema } from "../../src/staff/request";
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
});

describe("Staff permission coupling", () => {
  const repository = new StaffRepository(createClient("https://example.test", "test-key"));
  const service = new StaffService(
    new AuthorizationService(new StubResourceRepository(new Map())),
    repository,
  );

  it("denies missing permission before persistence", async () => {
    const spy = vi.spyOn(repository, "create");
    await expect(
      service.create(contextWith([]), "key", { identityId: identity }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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

  it("reports full capability for a tenant-wide manager", () => {
    expect(staffCapabilities(contextWith([grant(["staff.read", "staff.manage"])]))).toEqual({
      canRead: true,
      canManage: true,
    });
  });
});
