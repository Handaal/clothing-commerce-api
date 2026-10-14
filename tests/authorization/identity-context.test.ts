import { describe, expect, it } from "vitest";

import {
  ClerkRequestVerifier,
  isClerkAuthorizedPartyAllowed,
} from "../../src/authentication/clerk-request-verifier";
import { AuthorizationContextResolver } from "../../src/authorization/context-resolver";
import { AuthorizationError, authorizationErrorResponse } from "../../src/authorization/errors";
import {
  FakeAuthorizationRepository,
  FakeExternalIdentityVerifier,
  ids,
  verifiedClerkIdentity,
} from "./fakes";

const request = new Request("https://api.example.test/protected", {
  headers: { "X-User-Identity-ID": ids.otherUser },
});

function resolver(repository = new FakeAuthorizationRepository()) {
  return new AuthorizationContextResolver(
    new FakeExternalIdentityVerifier(),
    repository,
    () => new Date("2026-08-19T00:00:00.000Z"),
  );
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("Clerk request verification", () => {
  it("derives the Clerk subject and session from a verified request", async () => {
    const verifier = new ClerkRequestVerifier(async () => ({
      isAuthenticated: true,
      toAuth: () => ({ userId: verifiedClerkIdentity.subject, sessionId: "sess_verified" }),
    }));

    await expect(verifier.verifyRequest(request)).resolves.toEqual({
      provider: "clerk",
      subject: verifiedClerkIdentity.subject,
      sessionId: "sess_verified",
    });
  });

  it("fails closed for signed-out, subjectless, and verifier-error results", async () => {
    const signedOut = new ClerkRequestVerifier(async () => ({
      isAuthenticated: false,
      toAuth: () => null,
    }));
    const subjectless = new ClerkRequestVerifier(async () => ({
      isAuthenticated: true,
      toAuth: () => ({ userId: null, sessionId: null }),
    }));
    const failed = new ClerkRequestVerifier(async () => Promise.reject(new Error("token detail")));

    await expectCode(signedOut.verifyRequest(request), "UNAUTHENTICATED");
    await expectCode(subjectless.verifyRequest(request), "UNAUTHENTICATED");
    await expectCode(failed.verifyRequest(request), "UNAUTHENTICATED");
  });

  it("requires configured browser authorized parties while allowing native tokens without azp", () => {
    const allowed = ["https://admin.example.test"];

    expect(isClerkAuthorizedPartyAllowed(undefined, allowed)).toBe(true);
    expect(isClerkAuthorizedPartyAllowed("https://admin.example.test", allowed)).toBe(true);
    expect(isClerkAuthorizedPartyAllowed("https://attacker.example.test", allowed)).toBe(false);
    expect(isClerkAuthorizedPartyAllowed(null, allowed)).toBe(false);
    expect(isClerkAuthorizedPartyAllowed(["https://admin.example.test"], allowed)).toBe(false);
  });
});

describe("identity provenance and authorization context", () => {
  it("maps verified provider plus subject to the bound internal identity", async () => {
    const context = await resolver().resolve({ request, requestedTenantId: ids.tenantA });

    expect(context.authentication).toEqual({
      provider: "clerk",
      subject: verifiedClerkIdentity.subject,
      sessionId: "sess_test",
    });
    expect(context.userIdentity.id).toBe(ids.user);
  });

  it("ignores a client-supplied internal UserIdentity value", async () => {
    const context = await resolver().resolve({ request, requestedTenantId: ids.tenantA });

    expect(request.headers.get("X-User-Identity-ID")).toBe(ids.otherUser);
    expect(context.userIdentity.id).toBe(ids.user);
  });

  it("denies an unknown or wrong-provider subject", async () => {
    const repository = new FakeAuthorizationRepository();
    const wrongProviderResolver = new AuthorizationContextResolver(
      new FakeExternalIdentityVerifier({
        provider: "other",
        subject: verifiedClerkIdentity.subject,
      }),
      repository,
    );
    const unknownSubjectResolver = new AuthorizationContextResolver(
      new FakeExternalIdentityVerifier({ provider: "clerk", subject: "unknown" }),
      repository,
    );

    await expectCode(
      wrongProviderResolver.resolve({ request, requestedTenantId: ids.tenantA }),
      "PROVIDER_BINDING_MISSING",
    );
    await expectCode(
      unknownSubjectResolver.resolve({ request, requestedTenantId: ids.tenantA }),
      "PROVIDER_BINDING_MISSING",
    );
  });

  it("denies unlinked and duplicate provider bindings", async () => {
    const unlinked = new FakeAuthorizationRepository();
    unlinked.bindings = [{ ...unlinked.bindings[0], unlinkedAt: "2026-08-18T00:00:00.000Z" }];
    await expectCode(
      resolver(unlinked).resolve({ request, requestedTenantId: ids.tenantA }),
      "PROVIDER_BINDING_INVALID",
    );

    const duplicate = new FakeAuthorizationRepository();
    duplicate.bindings.push({
      ...duplicate.bindings[0],
      id: "71000000-0000-4000-8000-000000000002",
    });
    await expectCode(
      resolver(duplicate).resolve({ request, requestedTenantId: ids.tenantA }),
      "PROVIDER_BINDING_INVALID",
    );
  });

  it.each(["suspended", "deactivated"] as const)("denies a %s global identity", async (status) => {
    const repository = new FakeAuthorizationRepository();
    repository.identities = [{ id: ids.user, status }];

    await expectCode(
      resolver(repository).resolve({ request, requestedTenantId: ids.tenantA }),
      "IDENTITY_INACTIVE",
    );
  });

  it("uses stable safe errors without provider or tenant internals", () => {
    const error = new AuthorizationError("TENANT_ACCESS_DENIED");
    expect(error.httpStatus).toBe(403);
    expect(error.message).not.toContain(ids.tenantA);
    expect(error.message).not.toContain(verifiedClerkIdentity.subject);
  });

  it("maps authentication to 401 and authorization denial to a safe 403 shape", () => {
    expect(authorizationErrorResponse(new AuthorizationError("UNAUTHENTICATED"))).toMatchObject({
      status: 401,
      body: { error: { code: "UNAUTHENTICATED" } },
    });
    expect(
      authorizationErrorResponse(new AuthorizationError("PROVIDER_BINDING_MISSING")),
    ).toMatchObject({
      status: 403,
      body: { error: { code: "PROVIDER_BINDING_MISSING" } },
    });
  });
});
