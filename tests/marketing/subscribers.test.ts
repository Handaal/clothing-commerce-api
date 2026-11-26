import { describe, expect, it, vi } from "vitest";

import type { AuthorizationContext } from "../../src/authorization";
import { StorefrontSubscribeRequestSchema } from "../../src/contracts";
import { SubscriberService, type SubscriberRepository } from "../../src/marketing/subscribers";

const TENANT = "11111111-1111-4111-8111-111111111111";

function contextWith(permissionKeys: string[]) {
  return {
    tenant: { id: TENANT },
    assignments: [{ permissionKeys }],
  } as unknown as AuthorizationContext;
}

function service() {
  const repository: SubscriberRepository = {
    subscribe: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ subscribers: [], total: 0 })),
  };
  return { repository, service: new SubscriberService(repository) };
}

describe("storefront subscribe", () => {
  it("normalises the email and defaults the source", async () => {
    const { repository, service: subject } = service();
    const body = StorefrontSubscribeRequestSchema.parse({
      tenantId: TENANT,
      email: "  Shopper@Example.COM ",
    });
    await expect(subject.subscribe(body)).resolves.toEqual({ subscribed: true });
    expect(repository.subscribe).toHaveBeenCalledWith({
      tenantId: TENANT,
      brandId: null,
      email: "shopper@example.com",
      source: "website",
    });
  });

  it("rejects malformed emails and unknown fields", () => {
    expect(
      StorefrontSubscribeRequestSchema.safeParse({ tenantId: TENANT, email: "nope" }).success,
    ).toBe(false);
    expect(
      StorefrontSubscribeRequestSchema.safeParse({
        tenantId: TENANT,
        email: "a@b.co",
        name: "x",
      }).success,
    ).toBe(false);
  });

  it("lists sign-ups only for commerce readers", async () => {
    const { repository, service: subject } = service();
    await expect(subject.list(contextWith(["catalog.read"]), 50)).rejects.toThrow();
    await expect(subject.list(contextWith(["orders.read"]), 50)).resolves.toEqual({
      subscribers: [],
      total: 0,
    });
    expect(repository.list).toHaveBeenCalledWith(TENANT, 50);
  });
});
