import { describe, expect, it, vi } from "vitest";

import type { AuthorizationContext, AuthorizationService } from "../../src/authorization";
import {
  StorefrontReturnRequestSchema,
  StorefrontTrackOrderRequestSchema,
  StorefrontTrackedOrderSchema,
} from "../../src/contracts";
import {
  AfterPurchaseError,
  AfterPurchaseService,
  trackingStage,
  type AfterPurchaseRepository,
  type TrackedOrderRow,
} from "../../src/orders/after-purchase";

const TENANT = "11111111-1111-4111-8111-111111111111";
const BRAND = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";

function row(overrides: Partial<TrackedOrderRow> = {}): TrackedOrderRow {
  return {
    orderReference: "1042",
    status: "placed",
    placedAt: "2026-11-19T10:00:00.000+00:00",
    cancelledAt: null,
    lastFulfilledAt: null,
    currency: "EGP",
    totalMinor: 130000,
    grossSubtotalMinor: 120000,
    discountTotalMinor: 0,
    deliveryFeeMinor: 10000,
    payment: { method: "cash_on_delivery", status: "pending" },
    recipientName: "Omar",
    deliveryCity: "Nasr City",
    deliveryRegion: "Cairo",
    lines: [
      {
        lineNumber: 1,
        productName: "Linen shirt",
        variantName: "M / Sand",
        optionSummary: "M · Sand",
        quantity: 2,
        unitPriceMinor: 60000,
        lineTotalMinor: 120000,
        fulfilledQuantity: 0,
        returnedQuantity: 0,
        requestedQuantity: 0,
        returnableQuantity: 0,
      },
    ],
    returns: { accepting: false, reason: "NOT_YET_DELIVERED", windowDays: 14, windowEndsAt: null },
    returnRequests: [],
    ...overrides,
  };
}

function setup(permissionKeys: string[] = []) {
  const repository: AfterPurchaseRepository = {
    track: vi.fn(async () => row()),
    requestReturn: vi.fn(async () => ({
      request: { reference: "1042-R1", status: "requested" as const },
    })),
    list: vi.fn(async () => ({ requests: [], awaitingDecision: 0 })),
    requestBrand: vi.fn(async () => BRAND),
    setStatus: vi.fn(async () => ({}) as never),
  };
  const authorization = {
    authorize: vi.fn(async () => ({ authorization: { membership: { id: MEMBERSHIP } } })),
  } as unknown as AuthorizationService;
  const context = {
    tenant: { id: TENANT },
    assignments: [{ permissionKeys }],
  } as unknown as AuthorizationContext;
  return {
    repository,
    authorization,
    context,
    service: new AfterPurchaseService(authorization, repository),
  };
}

describe("tracking stage", () => {
  it("follows the order from confirmed to delivered", () => {
    expect(trackingStage(row())).toBe("confirmed");
    const line = row().lines[0]!;
    expect(trackingStage(row({ lines: [{ ...line, fulfilledQuantity: 1 }] }))).toBe(
      "partially_shipped",
    );
    expect(trackingStage(row({ lines: [{ ...line, fulfilledQuantity: 2 }] }))).toBe("shipped");
    expect(
      trackingStage(
        row({
          lines: [{ ...line, fulfilledQuantity: 2 }],
          payment: { method: "cash_on_delivery", status: "captured" },
        }),
      ),
    ).toBe("delivered");
    expect(trackingStage(row({ status: "cancelled" }))).toBe("cancelled");
  });
});

describe("public tracking", () => {
  it("returns the contract shape with normalised dates", async () => {
    const { service } = setup();
    const tracked = await service.track(
      StorefrontTrackOrderRequestSchema.parse({
        tenantId: TENANT,
        orderReference: " #1042 ",
        phone: "+20 100 000 0001",
      }),
    );
    expect(StorefrontTrackedOrderSchema.parse(tracked)).toEqual(tracked);
    expect(tracked.placedAt).toBe("2026-11-19T10:00:00.000Z");
    expect(tracked.lines[0]!.shippedQuantity).toBe(0);
    expect(tracked).not.toHaveProperty("status");
  });

  it("answers ORDER_NOT_FOUND for any miss", async () => {
    const { service, repository } = setup();
    vi.mocked(repository.track).mockResolvedValueOnce(null);
    await expect(
      service.track({ tenantId: TENANT, orderReference: "1", phone: "+201000000000" }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND", httpStatus: 404 });
  });

  it("rejects phones with letters and unknown fields", () => {
    expect(
      StorefrontTrackOrderRequestSchema.safeParse({
        tenantId: TENANT,
        orderReference: "1",
        phone: "call me",
      }).success,
    ).toBe(false);
    expect(
      StorefrontTrackOrderRequestSchema.safeParse({
        tenantId: TENANT,
        orderReference: "1",
        phone: "+201000000000",
        email: "x@y.co",
      }).success,
    ).toBe(false);
  });
});

describe("public return request", () => {
  const body = {
    tenantId: TENANT,
    orderReference: "1042",
    phone: "+201000000001",
    note: "  ",
    lines: [{ lineNumber: 1, quantity: 1, reason: "too_small" as const }],
  };

  it("defaults to refund and drops a blank note", async () => {
    const { service, repository } = setup();
    await expect(service.requestReturn(body)).resolves.toEqual({
      reference: "1042-R1",
      status: "requested",
    });
    expect(repository.requestReturn).toHaveBeenCalledWith(
      expect.objectContaining({ preference: "refund", note: null, brandId: null }),
    );
  });

  it("turns database refusals into typed errors", async () => {
    const { service, repository } = setup();
    vi.mocked(repository.requestReturn).mockResolvedValueOnce({ refusal: "RETURN_WINDOW_EXPIRED" });
    await expect(service.requestReturn(body)).rejects.toMatchObject({
      code: "RETURN_WINDOW_EXPIRED",
      httpStatus: 422,
    });
    vi.mocked(repository.requestReturn).mockResolvedValueOnce({ refusal: "SOMETHING_NEW" });
    await expect(service.requestReturn(body)).rejects.toBeInstanceOf(AfterPurchaseError);
  });

  it("refuses bad reasons and zero quantities before the database", async () => {
    const { service, repository } = setup();
    expect(
      StorefrontReturnRequestSchema.safeParse({
        ...body,
        lines: [{ lineNumber: 1, quantity: 0, reason: "too_small" }],
      }).success,
    ).toBe(false);
    await expect(
      service.requestReturn({
        ...body,
        lines: [{ lineNumber: 1, quantity: 1, reason: "meh" as never }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_RETURN_REQUEST" });
    expect(repository.requestReturn).not.toHaveBeenCalled();
  });
});

describe("staff return requests", () => {
  it("lists only with returns.read", async () => {
    await expect(setup([]).service.list(setup([]).context, {})).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    const allowed = setup(["returns.read"]);
    await allowed.service.list(allowed.context, { status: "all" });
    expect(allowed.repository.list).toHaveBeenCalledWith(TENANT, {
      status: "all",
      limit: 50,
    });
  });

  it("authorizes the decision on the order brand and records the actor", async () => {
    const { service, repository, authorization, context } = setup();
    await service.setStatus(context, REQUEST, { status: "approved", note: "" });
    expect(authorization.authorize).toHaveBeenCalledWith(context, {
      permissionKey: "returns.create",
      resources: [{ kind: "brand", id: BRAND }],
    });
    expect(repository.setStatus).toHaveBeenCalledWith({
      tenantId: TENANT,
      requestId: REQUEST,
      actorMembershipId: MEMBERSHIP,
      status: "approved",
      note: null,
    });
  });

  it("is not found when the request belongs to nobody in the tenant", async () => {
    const { service, repository, context } = setup();
    vi.mocked(repository.requestBrand).mockResolvedValueOnce(null);
    await expect(service.setStatus(context, REQUEST, { status: "declined" })).rejects.toMatchObject(
      {
        code: "RETURN_REQUEST_NOT_FOUND",
      },
    );
  });
});
