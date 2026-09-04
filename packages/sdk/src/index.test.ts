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

const VARIANT = "66666666-6666-4666-8666-666666666671";
const LOCATION = "66666666-6666-4666-8666-666666666681";
const LOCATION_DEST = "66666666-6666-4666-8666-666666666682";
const OPERATION = "77777777-7777-4777-8777-777777777701";

describe("Commerce SDK inventory write surface", () => {
  it("receives stock via POST with the idempotency-key header and a JSON body (key not in body)", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            operationId: OPERATION,
            variantId: VARIANT,
            inventoryLocationId: LOCATION,
            observedOnHand: 12,
            observedVersion: 3,
          }),
        ),
      ),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      client: { type: "admin-mobile", version: "1.2.3" },
      getToken: async () => "session-token",
      fetch: fetchImplementation,
    });

    const result = await client.withTenant(TENANT).receiveInventory({
      variantId: VARIANT,
      inventoryLocationId: LOCATION,
      quantity: 12,
      idempotencyKey: "recv-key-1",
      note: "pallet 7",
    });
    expect(result.observedOnHand).toBe(12);

    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/v1/inventory/receipts");
    expect(init!.method).toBe("POST");
    const headers = init!.headers as Record<string, string>;
    expect(headers).toMatchObject({
      Authorization: "Bearer session-token",
      "X-Tenant-Id": TENANT,
      "Idempotency-Key": "recv-key-1",
      "Content-Type": "application/json",
    });
    const sentBody = JSON.parse(init!.body as string);
    expect(sentBody).toEqual({
      variantId: VARIANT,
      inventoryLocationId: LOCATION,
      quantity: 12,
      note: "pallet 7",
    });
    // The idempotency key travels in the header only, never in the fingerprinted payload.
    expect(sentBody).not.toHaveProperty("idempotencyKey");
  });

  it("adjusts stock to a route/body/response contract", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            operationId: OPERATION,
            changed: true,
            variantId: VARIANT,
            inventoryLocationId: LOCATION,
            previousOnHand: 5,
            newOnHand: 8,
            version: 2,
          }),
        ),
      ),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: async () => "t",
      fetch: fetchImplementation,
    });

    const result = await client.withTenant(TENANT).adjustInventory({
      variantId: VARIANT,
      inventoryLocationId: LOCATION,
      countedQuantity: 8,
      expectedVersion: 1,
      idempotencyKey: "adj-key-1",
    });
    expect(result).toMatchObject({ changed: true, newOnHand: 8 });

    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/v1/inventory/adjustments");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      variantId: VARIANT,
      inventoryLocationId: LOCATION,
      countedQuantity: 8,
      expectedVersion: 1,
    });
  });

  it("transfers stock between two locations", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            operationId: OPERATION,
            variantId: VARIANT,
            source: { inventoryLocationId: LOCATION, observedOnHand: 3, observedVersion: 4 },
            destination: {
              inventoryLocationId: LOCATION_DEST,
              observedOnHand: 9,
              observedVersion: 4,
            },
          }),
        ),
      ),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: async () => "t",
      fetch: fetchImplementation,
    });

    const result = await client.withTenant(TENANT).transferInventory({
      variantId: VARIANT,
      sourceInventoryLocationId: LOCATION,
      destinationInventoryLocationId: LOCATION_DEST,
      quantity: 6,
      idempotencyKey: "xfer-key-1",
    });
    expect(result.source.observedOnHand).toBe(3);
    expect(result.destination.observedOnHand).toBe(9);

    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/v1/inventory/transfers");
    expect((init!.headers as Record<string, string>)["Idempotency-Key"]).toBe("xfer-key-1");
  });

  it("surfaces an idempotency conflict as a typed 409 HTTP error", async () => {
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: async () => "t",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "The idempotency key was reused with a different payload.",
              requestId: REQUEST_ID,
            },
          }),
          { status: 409, headers: { "X-Request-Id": REQUEST_ID } },
        ),
    });

    const request = client.withTenant(TENANT).receiveInventory({
      variantId: VARIANT,
      inventoryLocationId: LOCATION,
      quantity: 1,
      idempotencyKey: "dup",
    });
    await expect(request).rejects.toBeInstanceOf(ApiHttpError);
    await expect(request).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("Commerce SDK Connected POS surface", () => {
  it("gets trusted context and sends one composed sale command", async () => {
    const ORDER = "77777777-7777-4777-8777-777777777711";
    const PAYMENT = "77777777-7777-4777-8777-777777777712";
    const FULFILLMENT = "77777777-7777-4777-8777-777777777713";
    const LINE = "77777777-7777-4777-8777-777777777714";
    const FULFILLMENT_LINE = "77777777-7777-4777-8777-777777777715";
    const BRANCH = "77777777-7777-4777-8777-777777777716";
    const BRAND_ID = "77777777-7777-4777-8777-777777777717";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/context")) {
        return new Response(
          JSON.stringify({
            registers: [
              {
                registerId: "77777777-7777-4777-8777-777777777718",
                registerName: "Front",
                branchId: BRANCH,
                branchName: "Main",
                defaultInventoryLocationId: LOCATION,
                defaultInventoryLocationName: "Floor",
                sellingCurrency: "USD",
                canSell: true,
              },
            ],
          }),
        );
      }
      const now = "2026-09-04T00:00:00.000Z";
      return new Response(
        JSON.stringify({
          saleStatus: "completed",
          order: {
            id: ORDER,
            orderNumber: "1",
            channel: "pos",
            status: "placed",
            brandId: BRAND_ID,
            branchId: BRANCH,
            registerId: "77777777-7777-4777-8777-777777777718",
            currency: "USD",
            totalMinor: 2500,
            actorMembershipId: MEMBERSHIP,
            placedAt: now,
            cancelledAt: null,
            cancelledByMembershipId: null,
            cancellationReason: null,
            notes: null,
            createdAt: now,
            updatedAt: now,
            lines: [
              {
                id: LINE,
                lineNumber: 1,
                variantId: VARIANT,
                quantity: 1,
                unitPriceMinor: 2500,
                lineTotalMinor: 2500,
                productName: "Tee",
                variantName: null,
                sku: "TEE",
                optionSummary: null,
              },
            ],
          },
          payment: {
            id: PAYMENT,
            orderId: ORDER,
            method: "cash",
            status: "captured",
            currency: "USD",
            amountMinor: 2500,
            cashReceivedMinor: 3000,
            changeMinor: 500,
            capturedByMembershipId: MEMBERSHIP,
            capturedAt: now,
            createdAt: now,
            updatedAt: now,
          },
          fulfillment: {
            id: FULFILLMENT,
            orderId: ORDER,
            inventoryLocationId: LOCATION,
            inventoryOperationId: OPERATION,
            actorMembershipId: MEMBERSHIP,
            fulfilledAt: now,
            createdAt: now,
            lines: [
              {
                id: FULFILLMENT_LINE,
                lineNumber: 1,
                orderLineId: LINE,
                variantId: VARIANT,
                quantity: 1,
              },
            ],
          },
        }),
      );
    });
    const scoped = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "clerk-token",
      fetch: fetchImplementation,
    }).withTenant(TENANT);

    await expect(scoped.getPosContext()).resolves.toMatchObject({
      registers: [{ sellingCurrency: "USD" }],
    });
    await expect(
      scoped.createPosSale({
        idempotencyKey: "sale-1",
        registerId: "77777777-7777-4777-8777-777777777718",
        expectedTotalMinor: 2500,
        cashReceivedMinor: 3000,
        lines: [{ variantId: VARIANT, quantity: 1 }],
      }),
    ).resolves.toMatchObject({ saleStatus: "completed", payment: { changeMinor: 500 } });

    expect(calls[0]?.url).toBe("https://api.example.test/api/v1/pos/context");
    expect(calls[1]?.url).toBe("https://api.example.test/api/v1/pos/sales");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.headers).toMatchObject({
      Authorization: "Bearer clerk-token",
      "X-Tenant-Id": TENANT,
      "Idempotency-Key": "sale-1",
    });
    expect(JSON.parse(calls[1]?.init?.body as string)).not.toHaveProperty("idempotencyKey");
  });
});
