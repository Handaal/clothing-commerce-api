import { describe, expect, it } from "vitest";

import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { AuthorizationService } from "../../src/authorization/authorization-service";
import type { AuthorizationResource } from "../../src/authorization/model";
import {
  FakeAuthorizationRepository,
  FakeExternalIdentityVerifier,
  assignment,
  ids,
} from "./fakes";

const request = new Request("https://api.example.test/protected");
const otherTenantAResources = {
  brand: "20000000-0000-4000-8000-000000000011",
  branch: "30000000-0000-4000-8000-000000000011",
  warehouse: "40000000-0000-4000-8000-000000000011",
  inventory_location: "50000000-0000-4000-8000-000000000011",
} as const;

async function setup(repository: FakeAuthorizationRepository) {
  const context = await new AuthorizationContextResolver(
    new FakeExternalIdentityVerifier(),
    repository,
    () => new Date("2026-08-19T00:00:00.000Z"),
  ).resolve({ request, requestedTenantId: ids.tenantA });
  return { context, service: new AuthorizationService(repository) };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

function addSameTenantResource(
  repository: FakeAuthorizationRepository,
  resource: AuthorizationResource,
) {
  repository.resourceTenantIds.set(`${resource.kind}:${resource.id}`, [ids.tenantA]);
}

describe("permission and AccessScope evaluation", () => {
  it("authorizes a Permission through a tenant-wide Role assignment", async () => {
    const repository = new FakeAuthorizationRepository();
    const { context, service } = await setup(repository);

    const proof = await service.authorize(context, { permissionKey: "test.read" });

    expect(proof.permissionKey).toBe("test.read");
    expect(proof.grantingAssignmentIds).toEqual([ids.assignmentX]);
  });

  it("denies a missing Permission before any privileged resource lookup", async () => {
    const repository = new FakeAuthorizationRepository();
    const { context, service } = await setup(repository);

    await expectCode(
      service.authorize(context, {
        permissionKey: "test.write",
        resources: [{ kind: "branch", id: ids.branchA }],
      }),
      "PERMISSION_DENIED",
    );
    expect(repository.resourceLookupCount).toBe(0);
  });

  it("deduplicates identical resources before ownership lookup and proof creation", async () => {
    const repository = new FakeAuthorizationRepository();
    const { context, service } = await setup(repository);
    const branch = { kind: "branch" as const, id: ids.branchA };

    const proof = await service.authorize(context, {
      permissionKey: "test.read",
      resources: [branch, branch],
    });

    expect(repository.resourceLookupCount).toBe(1);
    expect(proof.resources).toEqual([branch]);
  });

  it("unions Permissions from multiple Roles without using Role names", async () => {
    const repository = new FakeAuthorizationRepository();
    repository.assignmentsByMembership.set(ids.membershipA, [
      assignment({ permissionKeys: ["test.read"] }),
      assignment({
        id: ids.assignmentY,
        roleId: ids.roleY,
        scopeId: ids.scopeB,
        permissionKeys: ["test.write"],
      }),
    ]);
    const { context, service } = await setup(repository);

    await expect(service.authorize(context, { permissionKey: "test.read" })).resolves.toBeDefined();
    await expect(
      service.authorize(context, { permissionKey: "test.write" }),
    ).resolves.toBeDefined();
  });

  it("does not grant through archived, ended, future, or deprecated assignment state", async () => {
    const repository = new FakeAuthorizationRepository();
    const active = assignment({ id: ids.assignmentX });
    const deprecated = {
      ...active,
      permissions: [{ key: "test.read", status: "deprecated" as const }],
    };
    repository.assignmentsByMembership.set(ids.membershipA, [
      deprecated,
      assignment({ id: ids.assignmentY, roleStatus: "archived" }),
      assignment({
        id: "b2000000-0000-4000-8000-000000000003",
        unassignedAt: "2026-08-10T00:00:00.000Z",
      }),
      assignment({
        id: "b2000000-0000-4000-8000-000000000004",
        assignedAt: "2026-09-01T00:00:00.000Z",
      }),
    ]);
    const { context, service } = await setup(repository);

    await expectCode(
      service.authorize(context, { permissionKey: "test.read" }),
      "PERMISSION_DENIED",
    );
  });

  it.each([
    ["brand", ids.brandA],
    ["branch", ids.branchA],
    ["warehouse", ids.warehouseA],
    ["inventory_location", ids.locationA],
  ] as const)(
    "allows an explicitly targeted %s and denies another same-Tenant target",
    async (kind, id) => {
      const repository = new FakeAuthorizationRepository();
      const allowed = { kind, id } as AuthorizationResource;
      const denied = { kind, id: otherTenantAResources[kind] } as AuthorizationResource;
      addSameTenantResource(repository, denied);
      repository.assignmentsByMembership.set(ids.membershipA, [
        assignment({ mode: "explicit", targets: [allowed] }),
      ]);
      const { context, service } = await setup(repository);

      await expect(
        service.authorize(context, { permissionKey: "test.read", resources: [allowed] }),
      ).resolves.toBeDefined();
      await expectCode(
        service.authorize(context, { permissionKey: "test.read", resources: [denied] }),
        "SCOPE_DENIED",
      );
    },
  );

  it("uses exact resource semantics and does not infer Branch-to-location hierarchy", async () => {
    const repository = new FakeAuthorizationRepository();
    repository.assignmentsByMembership.set(ids.membershipA, [
      assignment({
        mode: "explicit",
        targets: [{ kind: "branch", id: ids.branchA }],
      }),
    ]);
    const { context, service } = await setup(repository);

    await expectCode(
      service.authorize(context, {
        permissionKey: "test.read",
        resources: [{ kind: "inventory_location", id: ids.locationA }],
      }),
      "SCOPE_DENIED",
    );
  });

  it("keeps Brand and physical-location scope orthogonal", async () => {
    const repository = new FakeAuthorizationRepository();
    repository.assignmentsByMembership.set(ids.membershipA, [
      assignment({ mode: "explicit", targets: [{ kind: "brand", id: ids.brandA }] }),
    ]);
    const { context, service } = await setup(repository);

    await expectCode(
      service.authorize(context, {
        permissionKey: "test.read",
        resources: [
          { kind: "brand", id: ids.brandA },
          { kind: "branch", id: ids.branchA },
        ],
      }),
      "SCOPE_DENIED",
    );
  });

  it("requires tenant-wide scope for an operation declared anywhere in the Tenant", async () => {
    const repository = new FakeAuthorizationRepository();
    repository.assignmentsByMembership.set(ids.membershipA, [
      assignment({
        mode: "explicit",
        targets: [{ kind: "branch", id: ids.branchA }],
      }),
    ]);
    const { context, service } = await setup(repository);

    await expectCode(service.authorize(context, { permissionKey: "test.read" }), "SCOPE_DENIED");
  });
});

describe("assignment-level Permission and scope coupling", () => {
  it("prevents the Permission-X/Scope-B cross-product escalation", async () => {
    const repository = new FakeAuthorizationRepository();
    const branchOther = { kind: "branch" as const, id: otherTenantAResources.branch };
    addSameTenantResource(repository, branchOther);
    repository.assignmentsByMembership.set(ids.membershipA, [
      assignment({
        permissionKeys: ["test.read"],
        mode: "explicit",
        targets: [{ kind: "branch", id: ids.branchA }],
      }),
      assignment({
        id: ids.assignmentY,
        roleId: ids.roleY,
        scopeId: ids.scopeB,
        permissionKeys: ["test.write"],
        mode: "explicit",
        targets: [branchOther],
      }),
    ]);
    const { context, service } = await setup(repository);

    await expectCode(
      service.authorize(context, { permissionKey: "test.read", resources: [branchOther] }),
      "SCOPE_DENIED",
    );
    await expect(
      service.authorize(context, { permissionKey: "test.write", resources: [branchOther] }),
    ).resolves.toMatchObject({ grantingAssignmentIds: [ids.assignmentY] });
  });

  it("allows multiple assignments to cover multiple resources only when each grants the Permission", async () => {
    const repository = new FakeAuthorizationRepository();
    repository.assignmentsByMembership.set(ids.membershipA, [
      assignment({
        permissionKeys: ["test.read"],
        mode: "explicit",
        targets: [{ kind: "brand", id: ids.brandA }],
      }),
      assignment({
        id: ids.assignmentY,
        roleId: ids.roleY,
        scopeId: ids.scopeB,
        permissionKeys: ["test.read"],
        mode: "explicit",
        targets: [{ kind: "branch", id: ids.branchA }],
      }),
    ]);
    const { context, service } = await setup(repository);

    const proof = await service.authorize(context, {
      permissionKey: "test.read",
      resources: [
        { kind: "brand", id: ids.brandA },
        { kind: "branch", id: ids.branchA },
      ],
    });
    expect(proof.grantingAssignmentIds).toEqual([ids.assignmentX, ids.assignmentY]);
  });
});
