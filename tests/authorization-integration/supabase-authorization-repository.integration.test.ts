import { describe, expect, it } from "vitest";

import type { ExternalIdentityVerifier } from "../../src/authentication/external-identity";
import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import {
  AuthorizationService,
  assertAuthorizedOperationProof,
} from "../../src/authorization/authorization-service";
import type { VerifiedExternalIdentity } from "../../src/authorization/model";
import { createSupabaseAuthorizationRepository } from "../../src/authorization/supabase-authorization-repository";

const ids = {
  tenantA: "10000000-0000-4000-8000-000000000001",
  tenantB: "10000000-0000-4000-8000-000000000002",
  tenantSuspended: "10000000-0000-4000-8000-000000000003",
  userValid: "70000000-0000-4000-8000-000000000001",
  membershipValid: "80000000-0000-4000-8000-000000000001",
  membershipDuplicate: "80000000-0000-4000-8000-000000000008",
  membershipMissingRole: "80000000-0000-4000-8000-000000000009",
  membershipTenantTarget: "80000000-0000-4000-8000-000000000010",
  membershipMissingPermission: "80000000-0000-4000-8000-000000000011",
  membershipMalformedTarget: "80000000-0000-4000-8000-000000000012",
  branchA: "30000000-0000-4000-8000-000000000001",
  brandA: "20000000-0000-4000-8000-000000000001",
  brandB: "20000000-0000-4000-8000-000000000002",
  warehouseA: "40000000-0000-4000-8000-000000000001",
  locationA: "50000000-0000-4000-8000-000000000001",
  deviceActive: "c0000000-0000-4000-8000-000000000001",
  deviceRevoked: "c0000000-0000-4000-8000-000000000002",
} as const;

class IntegrationIdentityVerifier implements ExternalIdentityVerifier {
  constructor(private readonly subject: string) {}

  async verifyRequest(): Promise<VerifiedExternalIdentity> {
    return { provider: "clerk", subject: this.subject, sessionId: "integration-session" };
  }
}

const url = process.env.AUTHORIZATION_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.AUTHORIZATION_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "Run this suite through pnpm test:authorization:integration; no shared or production Supabase project is supported.",
  );
}

const repository = createSupabaseAuthorizationRepository({ url, serviceRoleKey });
const request = new Request("https://api.example.test/integration-protected");

function resolver(subject: string) {
  return new AuthorizationContextResolver(
    new IntegrationIdentityVerifier(subject),
    repository,
    () => new Date(Date.now()),
  );
}

async function resolve(subject: string, tenantId: string = ids.tenantA) {
  return resolver(subject).resolve({ request, requestedTenantId: tenantId });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe.sequential("SupabaseAuthorizationRepository integration", () => {
  it("uses exact provider provenance and exposes duplicate cardinality", async () => {
    await expect(repository.findProviderBindings("clerk", "integration-valid")).resolves.toEqual([
      expect.objectContaining({
        userIdentityId: ids.userValid,
        provider: "clerk",
        providerSubject: "integration-valid",
        unlinkedAt: null,
      }),
    ]);
    await expect(repository.findProviderBindings("auth0", "integration-valid")).resolves.toEqual(
      [],
    );
    await expect(repository.findProviderBindings("clerk", "integration-missing")).resolves.toEqual(
      [],
    );
    await expect(
      repository.findProviderBindings("clerk", "integration-duplicate-binding"),
    ).resolves.toHaveLength(2);
  });

  it("fails closed on missing and duplicate provider bindings without echoing the subject", async () => {
    const missing = resolve("integration-missing");
    await expectCode(missing, "PROVIDER_BINDING_MISSING");
    await expect(missing).rejects.not.toThrow("integration-missing");

    await expectCode(resolve("integration-duplicate-binding"), "PROVIDER_BINDING_INVALID");
  });

  it("reads identity, tenant, membership, and Device lifecycle rows from PostgreSQL", async () => {
    await expect(repository.findUserIdentities(ids.userValid)).resolves.toEqual([
      { id: ids.userValid, status: "active" },
    ]);
    await expect(repository.findTenants(ids.tenantSuspended)).resolves.toEqual([
      { id: ids.tenantSuspended, status: "suspended" },
    ]);
    await expect(repository.findMemberships(ids.tenantA, ids.userValid)).resolves.toEqual([
      expect.objectContaining({ id: ids.membershipValid, status: "active" }),
    ]);
    await expect(repository.findDevices(ids.tenantA, ids.deviceActive)).resolves.toEqual([
      { id: ids.deviceActive, tenantId: ids.tenantA, status: "active" },
    ]);
    await expect(repository.findDevices(ids.tenantA, ids.deviceRevoked)).resolves.toEqual([
      { id: ids.deviceRevoked, tenantId: ids.tenantA, status: "revoked" },
    ]);
  });

  it("hydrates assignments and lets the resolver discard ended, future, archived-role, and archived-scope grants", async () => {
    await expect(
      repository.loadAssignments(ids.tenantA, ids.membershipValid),
    ).resolves.toHaveLength(5);

    const context = await resolve("integration-valid");
    expect(context.assignments).toEqual([
      expect.objectContaining({
        assignmentId: "b2000000-0000-4000-8000-000000000001",
        scopeMode: "explicit",
        scopeTargets: [{ kind: "branch", id: ids.branchA }],
        permissionKeys: ["test.read"],
      }),
    ]);
  });

  it.each([
    ["integration-inactive-identity", ids.tenantA, "IDENTITY_INACTIVE"],
    ["integration-no-membership", ids.tenantA, "TENANT_ACCESS_DENIED"],
    ["integration-inactive-membership", ids.tenantA, "MEMBERSHIP_INACTIVE"],
    ["integration-suspended-tenant", ids.tenantSuspended, "TENANT_SUSPENDED"],
    ["integration-duplicate-membership", ids.tenantA, "AUTHORIZATION_STATE_INVALID"],
  ])("fails closed for lifecycle/cardinality state %s", async (subject, tenantId, code) => {
    await expectCode(resolve(subject, tenantId), code);
  });

  it.each([
    ["missing Role", ids.membershipMissingRole],
    ["target attached to tenant scope", ids.membershipTenantTarget],
    ["missing Permission", ids.membershipMissingPermission],
    ["target containing multiple resource IDs", ids.membershipMalformedTarget],
  ])("rejects controlled corrupt persisted state: %s", async (_label, membershipId) => {
    await expectCode(
      repository.loadAssignments(ids.tenantA, membershipId),
      "AUTHORIZATION_STATE_INVALID",
    );
  });

  it("accepts an empty explicit scope as an empty allowlist and denies resource access", async () => {
    const context = await resolve("integration-empty-scope");
    expect(context.assignments).toEqual([
      expect.objectContaining({ scopeMode: "explicit", scopeTargets: [] }),
    ]);

    await expectCode(
      new AuthorizationService(repository).authorize(context, {
        permissionKey: "test.read",
        resources: [{ kind: "branch", id: ids.branchA }],
      }),
      "SCOPE_DENIED",
    );
  });

  it.each([
    ["brand", ids.brandA],
    ["branch", ids.branchA],
    ["warehouse", ids.warehouseA],
    ["inventory_location", ids.locationA],
  ] as const)("resolves authoritative Tenant ownership for %s", async (kind, id) => {
    await expect(repository.findResourceTenantIds({ kind, id })).resolves.toEqual([ids.tenantA]);
  });

  it("returns no owner for an unknown UUID and the foreign owner for a known foreign resource", async () => {
    await expect(
      repository.findResourceTenantIds({
        kind: "brand",
        id: "20000000-0000-4000-8000-000000000099",
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.findResourceTenantIds({ kind: "brand", id: ids.brandB }),
    ).resolves.toEqual([ids.tenantB]);
  });

  it("authorizes a valid exact resource with a runtime-issued proof and denies foreign ownership", async () => {
    const context = await resolve("integration-valid");
    const service = new AuthorizationService(repository);
    const proof = await service.authorize(context, {
      permissionKey: "test.read",
      resources: [{ kind: "branch", id: ids.branchA }],
    });
    expect(() => assertAuthorizedOperationProof(proof)).not.toThrow();

    await expectCode(
      service.authorize(context, {
        permissionKey: "test.read",
        resources: [{ kind: "brand", id: ids.brandB }],
      }),
      "TENANT_ACCESS_DENIED",
    );
  });
});
