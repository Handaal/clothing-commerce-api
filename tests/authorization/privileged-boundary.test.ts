import { describe, expect, it, vi } from "vitest";

import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { assertAuthorizedOperationProof } from "../../src/authorization/index";
import {
  AuthorizationService,
  executeAuthorizedOperation,
  type AuthorizedOperationContext,
} from "../../src/authorization/authorization-service";
import { assertRoleMutationAllowed } from "../../src/authorization/role-governance";
import { FakeAuthorizationRepository, FakeExternalIdentityVerifier, ids } from "./fakes";

const request = new Request("https://api.example.test/protected");

async function setup(repository = new FakeAuthorizationRepository()) {
  const context = await new AuthorizationContextResolver(
    new FakeExternalIdentityVerifier(),
    repository,
  ).resolve({ request, requestedTenantId: ids.tenantA });
  return { context, repository, service: new AuthorizationService(repository) };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("resource Tenant ownership", () => {
  it.each([
    ["brand", ids.brandB],
    ["branch", ids.branchB],
    ["warehouse", ids.warehouseB],
    ["inventory_location", ids.locationB],
  ] as const)("denies a known foreign-Tenant %s UUID before operation access", async (kind, id) => {
    const { context, service } = await setup();

    await expectCode(
      service.authorize(context, {
        permissionKey: "test.read",
        resources: [{ kind, id }],
      }),
      "TENANT_ACCESS_DENIED",
    );
  });

  it("uses the same safe denial for an unknown resource UUID", async () => {
    const { context, service } = await setup();

    await expectCode(
      service.authorize(context, {
        permissionKey: "test.read",
        resources: [{ kind: "branch", id: "30000000-0000-4000-8000-000000000099" }],
      }),
      "TENANT_ACCESS_DENIED",
    );
  });
});

describe("privileged operation capability boundary", () => {
  it("does not invoke a privileged operation when authorization fails", async () => {
    const { context, service } = await setup();
    const privilegedOperation = vi.fn(async () => "mutated");

    await expectCode(
      executeAuthorizedOperation({
        authorizationService: service,
        context,
        request: { permissionKey: "test.write" },
        operation: privilegedOperation,
      }),
      "PERMISSION_DENIED",
    );
    expect(privilegedOperation).not.toHaveBeenCalled();
  });

  it("passes opaque authorization proof to an approved privileged operation", async () => {
    const { context, service } = await setup();
    const privilegedOperation = vi.fn(async (proof) => {
      assertAuthorizedOperationProof(proof);
      return { changed: true, permissionKey: proof.permissionKey };
    });

    await expect(
      executeAuthorizedOperation({
        authorizationService: service,
        context,
        request: {
          permissionKey: "test.read",
          resources: [{ kind: "branch", id: ids.branchA }],
        },
        operation: privilegedOperation,
      }),
    ).resolves.toEqual({ changed: true, permissionKey: "test.read" });
    expect(privilegedOperation).toHaveBeenCalledOnce();
  });

  it("accepts only proofs issued by the live authorization service", async () => {
    const { context, service } = await setup();
    const proof = await service.authorize(context, { permissionKey: "test.read" });

    expect(() => assertAuthorizedOperationProof(proof)).not.toThrow();

    const forged = {
      authorization: proof.authorization,
      permissionKey: proof.permissionKey,
      resources: proof.resources,
      grantingAssignmentIds: proof.grantingAssignmentIds,
    } as unknown as AuthorizedOperationContext;
    expect(() => assertAuthorizedOperationProof(forged)).toThrowError(
      expect.objectContaining({ code: "AUTHORIZATION_PROOF_INVALID" }),
    );
  });

  it("freezes the issued proof and its nested authorization snapshot", async () => {
    const { context, service } = await setup();
    const proof = await service.authorize(context, {
      permissionKey: "test.read",
      resources: [{ kind: "branch", id: ids.branchA }],
    });

    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.authorization)).toBe(true);
    expect(Object.isFrozen(proof.authorization.assignments)).toBe(true);
    expect(Object.isFrozen(proof.authorization.assignments[0])).toBe(true);
    expect(Object.isFrozen(proof.authorization.assignments[0].scopeTargets)).toBe(true);
    expect(Object.isFrozen(proof.resources)).toBe(true);
    expect(Object.isFrozen(proof.resources[0])).toBe(true);
  });

  it.each([
    ["spread clone", async (proof: AuthorizedOperationContext) => ({ ...proof })],
    ["JSON clone", async (proof: AuthorizedOperationContext) => JSON.parse(JSON.stringify(proof))],
    ["null", async () => null],
    ["undefined", async () => undefined],
  ])("rejects a %s as an authorization proof", async (_label, candidate) => {
    const { context, service } = await setup();
    const proof = await service.authorize(context, { permissionKey: "test.read" });
    const value = await candidate(proof);

    expect(() => assertAuthorizedOperationProof(value)).toThrowError(
      expect.objectContaining({ code: "AUTHORIZATION_PROOF_INVALID" }),
    );
  });
});

describe("protected Role governance", () => {
  it.each(["rename", "archive", "delete", "change_permissions"] as const)(
    "denies tenant %s of a protected Role",
    (mutation) => {
      expect(() => assertRoleMutationAllowed({ isProtectedRole: true, mutation })).toThrowError(
        expect.objectContaining({ code: "PROTECTED_ROLE_MUTATION_DENIED" }),
      );
    },
  );

  it("distinguishes protected state by persistence metadata rather than Role name", () => {
    expect(() =>
      assertRoleMutationAllowed({ isProtectedRole: false, mutation: "rename" }),
    ).not.toThrow();
    expect(() =>
      assertRoleMutationAllowed({
        isProtectedRole: true,
        mutation: "change_permissions",
      }),
    ).toThrowError(expect.objectContaining({ code: "PROTECTED_ROLE_MUTATION_DENIED" }));
  });
});
