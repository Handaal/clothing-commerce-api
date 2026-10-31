import { describe, expect, it, vi } from "vitest";

import {
  ApiContractError,
  ApiHttpError,
  ApiNetworkError,
  createCommerceClient,
  SDK_VERSION,
} from "./index";

describe("Commerce SDK", () => {
  it("sends return intent through scoped, idempotent commands without embedding keys in bodies", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const result = {
      id,
      orderId: id,
      channel: "pos",
      source: "management",
      actorMembershipId: id,
      status: "accepted",
      currency: "USD",
      amountMinor: 2500,
      inventoryLocationId: null,
      inventoryOperationId: null,
      createdAt: "2026-09-19T00:00:00.000Z",
      lines: [
        {
          orderLineId: id,
          lineNumber: 1,
          variantId: id,
          quantity: 1,
          reason: "size",
          disposition: "non_restock",
          amountMinor: 2500,
        },
      ],
      refund: {
        id,
        paymentId: id,
        returnId: id,
        method: "cash",
        status: "pending",
        amountMinor: 2500,
        currency: "USD",
        settlementReference: null,
        settledAt: null,
      },
    };
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify(result)),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "session",
      fetch: fetchImplementation,
    }).withTenant(id);
    const lines = [
      { orderLineId: id, quantity: 1, reason: "size", disposition: "non_restock" as const },
    ];
    await expect(
      client.createReturn({ orderId: id, idempotencyKey: "stable-return", lines }),
    ).resolves.toEqual(result);
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      `https://api.example.test/api/v1/orders/${id}/returns`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": "stable-return",
          "X-Tenant-Id": id,
          Authorization: "Bearer session",
        }),
        body: JSON.stringify({ lines }),
      }),
    );
    await client.settleRefund({
      returnId: id,
      idempotencyKey: "stable-settlement",
      settlementReference: "cash evidence",
    });
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      `https://api.example.test/api/v1/returns/${id}/refund`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ settlementReference: "cash evidence" }),
        headers: expect.objectContaining({ "Idempotency-Key": "stable-settlement" }),
      }),
    );
    await client.getReturn(id);
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      `https://api.example.test/api/v1/returns/${id}`,
      expect.objectContaining({ headers: expect.objectContaining({ "X-Tenant-Id": id }) }),
    );
  });
  it("exposes non-consuming quotes and idempotent promotion management", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const breakdown = {
      currency: "USD",
      grossSubtotalMinor: 2000,
      discountTotalMinor: 200,
      totalMinor: 1800,
      codeStatus: "valid",
      promotion: {
        promotionId: id,
        name: "Ten",
        benefitType: "percentage",
        activation: "code",
        code: "SAVE",
        discountTotalMinor: 200,
      },
    };
    const detail = {
      id,
      name: "Ten",
      status: "active",
      benefitType: "percentage",
      targetType: "order",
      activationType: "code",
      channel: null,
      redemptionCount: 0,
      globalRedemptionLimit: null,
      economicsLocked: false,
      createdAt: "2026-09-24T00:00:00.000Z",
      description: null,
      benefitPercentBp: 1000,
      benefitAmountMinor: null,
      benefitCurrency: null,
      minSubtotalMinor: null,
      maxDiscountMinor: null,
      startsAt: null,
      endsAt: null,
      brandId: null,
      branchId: null,
      remainingRedemptions: null,
      targets: [],
      codes: [],
    };
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Response(
          JSON.stringify(
            (init?.method ?? "GET") === "GET" &&
              String(_url).endsWith("/promotions?limit=10&offset=0")
              ? { total: 1, items: [detail] }
              : String(_url).includes("/quote")
                ? breakdown
                : detail,
          ),
        ),
    );
    const root = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "session",
      fetch: fetchImplementation,
    });

    // Public storefront quote: POST, no tenant header, no idempotency key.
    await expect(
      root.quote({
        tenantId: id,
        brandId: id,
        lines: [{ variantId: id, quantity: 1 }],
        promotionCode: "SAVE",
      }),
    ).resolves.toEqual(breakdown);
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      "https://api.example.test/api/v1/storefront/quote",
      expect.objectContaining({ method: "POST" }),
    );
    const lastHeaders = (fetchImplementation.mock.lastCall?.[1]?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(lastHeaders["Idempotency-Key"]).toBeUndefined();
    expect(lastHeaders["X-Tenant-Id"]).toBeUndefined();

    const tenant = root.withTenant(id);
    // Connected POS quote: tenant header, no idempotency.
    await tenant.posQuote({ registerId: id, lines: [{ variantId: id, quantity: 1 }] });
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      "https://api.example.test/api/v1/pos/quote",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Tenant-Id": id }),
      }),
    );

    // Create promotion: idempotency key carried out of band, not in the body.
    await tenant.createPromotion({
      idempotencyKey: "promo-key",
      name: "Ten",
      benefitType: "percentage",
      benefitPercentBp: 1000,
      targetType: "order",
      activationType: "automatic",
    });
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      "https://api.example.test/api/v1/promotions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": "promo-key", "X-Tenant-Id": id }),
        body: JSON.stringify({
          name: "Ten",
          benefitType: "percentage",
          benefitPercentBp: 1000,
          targetType: "order",
          activationType: "automatic",
        }),
      }),
    );

    await tenant.listPromotions({ limit: 10, offset: 0 });
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      "https://api.example.test/api/v1/promotions?limit=10&offset=0",
      expect.objectContaining({ headers: expect.objectContaining({ "X-Tenant-Id": id }) }),
    );

    await tenant.setPromotionStatus({ promotionId: id, status: "inactive", idempotencyKey: "s" });
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      `https://api.example.test/api/v1/promotions/${id}/status`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ status: "inactive" }) }),
    );
  });
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
    expect(SDK_VERSION).toBe("0.25.0");
  });

  it("posPinLogin POSTs username+PIN publicly (no tenant header, no bearer) and returns the session", async () => {
    const operator = {
      membershipId: "b0000000-0000-4000-8000-000000000002",
      tenantId: "a0000000-0000-4000-8000-000000000001",
      username: "mariam",
      displayName: "Mariam",
      role: "cashier" as const,
      permissions: ["orders"],
    };
    const body = {
      accessToken: "pos.jwt.token",
      expiresAt: "2026-11-01T20:00:00.000Z",
      operator,
    };
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(new Response(JSON.stringify(body))),
    );
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      client: { type: "pos-desktop", version: "0.1.0" },
      getToken: async () => "should-not-be-sent",
      fetch: fetchImplementation,
    });

    await expect(client.posPinLogin({ username: "mariam", pin: "1234" })).resolves.toEqual(body);
    const [, init] = fetchImplementation.mock.calls[0];
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/pos/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "mariam", pin: "1234" }),
      }),
    );
    // Public endpoint: the SDK still attaches the bearer if a token exists, but NO tenant header is sent.
    expect((init?.headers as Record<string, string>)["X-Tenant-Id"]).toBeUndefined();
  });
});

const BRAND = "66666666-6666-4666-8666-666666666661";
const PRODUCT = "66666666-6666-4666-8666-666666666662";
const TENANT = "a0000000-0000-4000-8000-000000000001";
const MEMBERSHIP = "b0000000-0000-4000-8000-000000000002";
const REQUEST_ID = "c0000000-0000-4000-8000-000000000003";

describe("Commerce SDK management surface", () => {
  it("parses independent Promotion capabilities while accepting legacy context responses", async () => {
    const baseContext = {
      tenant: { id: TENANT, name: "Acme", status: "active" },
      membership: { id: MEMBERSHIP },
      access: {
        catalog: { canRead: false, tenantWide: false, brands: [] },
        inventory: {
          canRead: false,
          tenantWide: false,
          locations: [],
          write: { canReceive: false, canAdjust: false, canTransfer: false, locations: [] },
        },
        orders: { canRead: false, tenantWide: false, brands: [], branches: [] },
      },
    } as const;
    const responses = [
      baseContext,
      {
        ...baseContext,
        access: {
          ...baseContext.access,
          promotions: { canRead: true, canManage: false },
        },
      },
    ];
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "session-token",
      fetch: async () => new Response(JSON.stringify(responses.shift())),
    }).withTenant(TENANT);

    await expect(client.getContext()).resolves.not.toHaveProperty("access.promotions");
    await expect(client.getContext()).resolves.toMatchObject({
      access: { promotions: { canRead: true, canManage: false } },
    });
  });

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
        const branchIdentity = {
          displayName: "Main",
          addressLine1: null,
          addressLine2: null,
          city: null,
          region: null,
          postalCode: null,
          countryCode: null,
          contactEmail: null,
          contactPhone: null,
          receiptFooter: null,
        };
        return new Response(
          JSON.stringify({
            business: {
              tenant: { displayName: "Acme", legalName: null, taxIdentifier: null },
            },
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
                branch: branchIdentity,
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
          payments: [
            {
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
          ],
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
    // An input without promotionCode omits it from the forwarded body entirely.
    expect(JSON.parse(calls[1]?.init?.body as string)).not.toHaveProperty("promotionCode");

    // A typed CreatePosSaleInput may carry an optional promotionCode, forwarded verbatim in the body.
    await expect(
      scoped.createPosSale({
        idempotencyKey: "sale-2",
        registerId: "77777777-7777-4777-8777-777777777718",
        expectedTotalMinor: 2500,
        cashReceivedMinor: 3000,
        lines: [{ variantId: VARIANT, quantity: 1 }],
        promotionCode: "SAVE20",
      }),
    ).resolves.toMatchObject({ saleStatus: "completed" });
    expect(calls[2]?.url).toBe("https://api.example.test/api/v1/pos/sales");
    expect(JSON.parse(calls[2]?.init?.body as string)).toMatchObject({ promotionCode: "SAVE20" });
    expect(JSON.parse(calls[2]?.init?.body as string)).not.toHaveProperty("idempotencyKey");
  });
});

describe("Commerce SDK reporting export surface", () => {
  it("downloads a CSV export with its media type and filename, preserving JSON report methods", async () => {
    const csv = "productId,level\r\n11111111-1111-4111-8111-111111111111,variant\r\n";
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).includes("/reports/export")) {
        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="sales-products_2026-06-01_2026-06-30.csv"',
          },
        });
      }
      // A JSON report method must remain a validated JSON call, unaffected by the export addition.
      return new Response(
        JSON.stringify({
          period: {
            timezone: "UTC",
            fromInclusive: "2026-06-01T00:00:00.000Z",
            toExclusive: "2026-07-01T00:00:00.000Z",
          },
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
      );
    });
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "session",
      fetch: fetchImplementation,
    }).withTenant(TENANT);

    const result = await client.exportReport({
      dataset: "sales-products",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      level: "variant",
    });
    expect(result).toEqual({
      body: csv,
      mediaType: "text/csv",
      filename: "sales-products_2026-06-01_2026-06-30.csv",
    });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "https://api.example.test/api/v1/reports/export?dataset=sales-products&startDate=2026-06-01&endDate=2026-06-30&level=variant",
    );
    const headers = init!.headers as Record<string, string>;
    expect(headers).toMatchObject({ "X-Tenant-Id": TENANT, Accept: "text/csv" });
    expect(init!.method).toBe("GET");

    // Old JSON reporting method still round-trips through validated JSON, not the document path.
    await expect(
      client.getSuppliersReport({ startDate: "2026-06-01", endDate: "2026-06-30" }),
    ).resolves.toMatchObject({ items: [] });
  });

  it("surfaces the explicit row-limit 413 as a typed HTTP error", async () => {
    const client = createCommerceClient({
      baseUrl: "https://api.example.test",
      getToken: () => "session",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "EXPORT_TOO_MANY_ROWS",
              message: "The export exceeds the maximum row count; narrow the date range.",
              requestId: REQUEST_ID,
            },
          }),
          { status: 413, headers: { "X-Request-Id": REQUEST_ID } },
        ),
    }).withTenant(TENANT);

    const request = client.exportReport({
      dataset: "inventory-movements",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    await expect(request).rejects.toBeInstanceOf(ApiHttpError);
    await expect(request).rejects.toMatchObject({ status: 413, code: "EXPORT_TOO_MANY_ROWS" });
  });
});

describe("Commerce SDK Offline POS surface", () => {
  it("sends the stable sync identity in both header and signed body", async () => {
    const now = "2026-09-06T00:00:00.000Z";
    const syncCommandId = "77777777-7777-4777-8777-777777777791";
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            syncStatus: "needs_reconciliation",
            ingestionId: "77777777-7777-4777-8777-777777777792",
            localSaleId: "local-1",
            receivedAt: now,
            order: {
              id: "77777777-7777-4777-8777-777777777793",
              orderNumber: "1",
              channel: "pos",
              status: "placed",
              brandId: BRAND,
              branchId: "77777777-7777-4777-8777-777777777794",
              registerId: "77777777-7777-4777-8777-777777777795",
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
                  id: "77777777-7777-4777-8777-777777777796",
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
              id: "77777777-7777-4777-8777-777777777797",
              orderId: "77777777-7777-4777-8777-777777777793",
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
            fulfillment: null,
            reconciliation: {
              id: "77777777-7777-4777-8777-777777777798",
              reason: "insufficient_stock_at_ingestion",
              status: "open",
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
    );
    const scoped = createCommerceClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImplementation,
    }).withTenant(TENANT);
    await scoped.ingestOfflineSale({
      idempotencyKey: syncCommandId,
      command: {
        schemaVersion: 1,
        localSaleId: "local-1",
        syncCommandId,
        grantId: "77777777-7777-4777-8777-777777777799",
        deviceId: "77777777-7777-4777-8777-777777777790",
        registerId: "77777777-7777-4777-8777-777777777795",
        acceptedAt: now,
        currency: "USD",
        lines: [
          {
            variantId: VARIANT,
            quantity: 1,
            grantedUnitPriceMinor: 2500,
            priceId: "77777777-7777-4777-8777-777777777789",
          },
        ],
        totalMinor: 2500,
        cashReceivedMinor: 3000,
        changeMinor: 500,
        offlineSaleOrdinal: 1,
        cumulativeExposureMinor: 2500,
      },
      signature: {
        algorithm: "Ed25519",
        credentialId: "77777777-7777-4777-8777-777777777788",
        value: "YWJj",
      },
    });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/v1/pos/offline-sales");
    expect((init!.headers as Record<string, string>)["Idempotency-Key"]).toBe(syncCommandId);
    expect(JSON.parse(init!.body as string).command.syncCommandId).toBe(syncCommandId);
  });
});
