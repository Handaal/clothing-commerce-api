import { describe, expect, it } from "vitest";

import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { FakeAuthorizationRepository, FakeExternalIdentityVerifier, ids } from "./fakes";

const request = new Request("https://api.example.test/protected");

function resolver(repository: FakeAuthorizationRepository) {
  return new AuthorizationContextResolver(new FakeExternalIdentityVerifier(), repository);
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("tenant selection and lifecycle", () => {
  it("selects each active Tenant independently for a multi-Tenant identity", async () => {
    const repository = new FakeAuthorizationRepository();

    const tenantAContext = await resolver(repository).resolve({
      request,
      requestedTenantId: ids.tenantA,
    });
    const tenantBContext = await resolver(repository).resolve({
      request,
      requestedTenantId: ids.tenantB,
    });

    expect(tenantAContext.tenant.id).toBe(ids.tenantA);
    expect(tenantAContext.membership.id).toBe(ids.membershipA);
    expect(tenantBContext.tenant.id).toBe(ids.tenantB);
    expect(tenantBContext.membership.id).toBe(ids.membershipB);
  });

  it("denies Tenant C rather than choosing a first or default membership", async () => {
    const repository = new FakeAuthorizationRepository();

    await expectCode(
      resolver(repository).resolve({ request, requestedTenantId: ids.tenantC }),
      "TENANT_ACCESS_DENIED",
    );
  });

  it("denies a malformed Tenant selector", async () => {
    await expectCode(
      resolver(new FakeAuthorizationRepository()).resolve({
        request,
        requestedTenantId: "not-a-uuid",
      }),
      "TENANT_ACCESS_DENIED",
    );
  });

  it.each(["invited", "suspended", "deactivated"] as const)(
    "denies a %s Membership",
    async (status) => {
      const repository = new FakeAuthorizationRepository();
      repository.memberships = repository.memberships.map((membership) =>
        membership.id === ids.membershipA ? { ...membership, status } : membership,
      );

      await expectCode(
        resolver(repository).resolve({ request, requestedTenantId: ids.tenantA }),
        "MEMBERSHIP_INACTIVE",
      );
    },
  );

  it("denies a missing Membership with the generic Tenant failure", async () => {
    const repository = new FakeAuthorizationRepository();
    repository.memberships = repository.memberships.filter(
      (membership) => membership.id !== ids.membershipA,
    );

    await expectCode(
      resolver(repository).resolve({ request, requestedTenantId: ids.tenantA }),
      "TENANT_ACCESS_DENIED",
    );
  });

  it("denies a suspended Tenant after validating Membership", async () => {
    const repository = new FakeAuthorizationRepository();
    repository.tenants = repository.tenants.map((tenant) =>
      tenant.id === ids.tenantA ? { ...tenant, status: "suspended" as const } : tenant,
    );

    await expectCode(
      resolver(repository).resolve({ request, requestedTenantId: ids.tenantA }),
      "TENANT_SUSPENDED",
    );
  });

  it.each(["provisioning", "archived"] as const)("denies a %s Tenant", async (status) => {
    const repository = new FakeAuthorizationRepository();
    repository.tenants = repository.tenants.map((tenant) =>
      tenant.id === ids.tenantA ? { ...tenant, status } : tenant,
    );

    await expectCode(
      resolver(repository).resolve({ request, requestedTenantId: ids.tenantA }),
      "TENANT_INACTIVE",
    );
  });

  it("accepts an active verified Device and denies a revoked one", async () => {
    const repository = new FakeAuthorizationRepository();

    const context = await resolver(repository).resolve({
      request,
      requestedTenantId: ids.tenantA,
      verifiedDevice: { deviceId: ids.deviceActive, credentialId: "verified-device-credential" },
    });
    expect(context.device?.id).toBe(ids.deviceActive);

    await expectCode(
      resolver(repository).resolve({
        request,
        requestedTenantId: ids.tenantA,
        verifiedDevice: { deviceId: ids.deviceRevoked },
      }),
      "DEVICE_REVOKED",
    );
  });

  it("does not trust an unverified Device header", async () => {
    const headerRequest = new Request("https://api.example.test/protected", {
      headers: { "X-Device-ID": ids.deviceRevoked },
    });
    const context = await resolver(new FakeAuthorizationRepository()).resolve({
      request: headerRequest,
      requestedTenantId: ids.tenantA,
    });

    expect(context.device).toBeUndefined();
  });
});
