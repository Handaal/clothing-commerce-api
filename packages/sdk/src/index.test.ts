import { describe, expect, it, vi } from "vitest";

import {
  ApiContractError,
  ApiHttpError,
  ApiNetworkError,
  createCommerceClient,
  SDK_VERSION,
} from "./index";

describe("Commerce SDK", () => {
  it("returns a validated health response and sends client metadata", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(new Response(JSON.stringify({ status: "ok", version: "0.1.0" }))),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test/",
      client: { type: "pos-desktop", version: "0.1.0" },
      fetch: fetchImplementation,
    });

    await expect(client.getHealth()).resolves.toEqual({ status: "ok", version: "0.1.0" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Client-Type": "pos-desktop",
          "X-Client-Version": "0.1.0",
        }),
      }),
    );
  });

  it("rejects invalid successful responses with a typed error", async () => {
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      fetch: async () => new Response(JSON.stringify({ status: "fine", version: 1 })),
    });

    await expect(client.getHealth()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("reports unavailable APIs with a typed network error", async () => {
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      fetch: async () => Promise.reject(new Error("offline")),
    });

    await expect(client.getHealth()).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it("reports unsuccessful HTTP responses with the status", async () => {
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      fetch: async () => new Response(null, { status: 503 }),
    });

    const request = client.getHealth();
    await expect(request).rejects.toBeInstanceOf(ApiHttpError);
    await expect(request).rejects.toMatchObject({ status: 503 });
  });

  it("exposes semantic SDK version metadata", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

const BRAND = "66666666-6666-4666-8666-666666666661";
const PRODUCT = "66666666-6666-4666-8666-666666666662";
const TENANT = "a0000000-0000-4000-8000-000000000001";
const MEMBERSHIP = "b0000000-0000-4000-8000-000000000002";
const REQUEST_ID = "c0000000-0000-4000-8000-000000000003";

describe("Commerce SDK management surface", () => {
  it("injects the token, tenant header, and client metadata on tenant-scoped calls", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [], pageInfo: { nextCursor: null, hasMore: false } })),
      ),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      client: { type: "admin-mobile", version: "1.2.3" },
      getToken: async () => "session-token",
      fetch: fetchImplementation,
    });

    const result = await client.withTenant(TENANT).listProducts({ brandId: BRAND, limit: 10 });
    expect(result).toEqual({ items: [], pageInfo: { nextCursor: null, hasMore: false } });

    const [url, init] = fetchImplementation.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(url).toBe(`https://api.example.test/api/v1/products?brandId=${BRAND}&limit=10`);
    expect(headers).toMatchObject({
      Authorization: "Bearer session-token",
      "X-Tenant-Id": TENANT,
      "X-Client-Type": "admin-mobile",
      "X-Client-Version": "1.2.3",
    });
  });

  it("does not send a tenant header for the identity bootstrap", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify([{ tenantId: TENANT, tenantName: "Acme", membershipId: MEMBERSHIP }]),
        ),
      ),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "session-token",
      fetch: fetchImplementation,
    });

    const tenants = await client.getMyTenants();
    expect(tenants).toHaveLength(1);
    const [, init] = fetchImplementation.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("X-Tenant-Id");
  });

  it("parses the external error envelope into a typed HTTP error", async () => {
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "t",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { code: "SCOPE_DENIED", message: "Out of scope.", requestId: REQUEST_ID },
          }),
          { status: 403, headers: { "X-Request-Id": REQUEST_ID } },
        ),
    });

    const request = client.withTenant(TENANT).getProduct(PRODUCT);
    await expect(request).rejects.toBeInstanceOf(ApiHttpError);
    await expect(request).rejects.toMatchObject({
      status: 403,
      code: "SCOPE_DENIED",
      requestId: REQUEST_ID,
    });
  });

  it("omits the Authorization header when no token is available", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(new Response(JSON.stringify({ status: "ok", version: "0.2.0" }))),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: () => null,
      fetch: fetchImplementation,
    });

    await client.getHealth();
    const [, init] = fetchImplementation.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("returns an immutable per-tenant client", () => {
    const client = createCommerceClient({ baseUrl: "https://api.example.test" });
    const tenantA = client.withTenant("a0000000-0000-4000-8000-00000000000a");
    const tenantB = client.withTenant("a0000000-0000-4000-8000-00000000000b");
    expect(tenantA.tenantId).not.toBe(tenantB.tenantId);
  });
});
