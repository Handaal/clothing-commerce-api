import { describe, expect, it, vi } from "vitest";

import type { AuthorizationContext } from "../../src/authorization";
import type { OrderDetailResponse } from "../../src/contracts";
import { FulfillmentError } from "../../src/fulfillments/errors";
import type { FulfillmentService } from "../../src/fulfillments/fulfillment-service";
import type { OrderResult } from "../../src/orders/model";
import { OnlineOrderOperationsService } from "../../src/orders/online-order-operations-service";
import type { OrderService } from "../../src/orders/order-service";
import type { OrdersReadService } from "../../src/orders/orders-read-service";

const tenantId = "10000000-0000-4000-8000-000000000001";
const orderId = "40000000-0000-4000-8000-000000000001";
const lineA = "41000000-0000-4000-8000-000000000001";
const lineB = "41000000-0000-4000-8000-000000000002";
const locationA = "70000000-0000-4000-8000-000000000001";
const locationB = "70000000-0000-4000-8000-000000000002";

const context = { tenant: { id: tenantId } } as unknown as AuthorizationContext;
const detail = { header: { id: orderId } } as unknown as OrderDetailResponse;

function order(overrides: Partial<OrderResult> = {}): OrderResult {
  return {
    id: orderId,
    channel: "online",
    status: "placed",
    lines: [
      { id: lineA, lineNumber: 1 },
      { id: lineB, lineNumber: 2 },
    ],
    ...overrides,
  } as unknown as OrderResult;
}

function setup(options: {
  order?: OrderResult;
  holds?: { orderLineId: string; inventoryLocationId: string }[];
}) {
  const orderService = {
    getOrder: vi.fn().mockResolvedValue(options.order ?? order()),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
  };
  const fulfillmentService = { createFulfillment: vi.fn().mockResolvedValue({}) };
  const ordersReadService = { getOrder: vi.fn().mockResolvedValue(detail) };
  const reservations = {
    getReservationLocations: vi.fn().mockResolvedValue(
      options.holds ?? [
        { orderLineId: lineA, inventoryLocationId: locationA },
        { orderLineId: lineB, inventoryLocationId: locationA },
      ],
    ),
  };
  const service = new OnlineOrderOperationsService(
    orderService as unknown as OrderService,
    fulfillmentService as unknown as FulfillmentService,
    ordersReadService as unknown as OrdersReadService,
    reservations,
  );
  return { service, orderService, fulfillmentService, ordersReadService };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(FulfillmentError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("OnlineOrderOperationsService.fulfil", () => {
  it("maps line numbers to order lines and fulfils from the reserved location", async () => {
    const { service, fulfillmentService, ordersReadService } = setup({});
    const result = await service.fulfil(context, orderId, "key-1", {
      lines: [
        { lineNumber: 1, quantity: 2 },
        { lineNumber: 2, quantity: 1 },
      ],
    });
    expect(fulfillmentService.createFulfillment).toHaveBeenCalledWith(context, {
      orderId,
      inventoryLocationId: locationA,
      idempotencyKey: "key-1",
      lines: [
        { orderLineId: lineA, quantity: 2 },
        { orderLineId: lineB, quantity: 1 },
      ],
    });
    expect(ordersReadService.getOrder).toHaveBeenCalledWith(context, orderId);
    expect(result).toBe(detail);
  });

  it("refuses POS orders", async () => {
    const { service, fulfillmentService } = setup({ order: order({ channel: "pos" }) });
    await expectCode(
      service.fulfil(context, orderId, "k", { lines: [{ lineNumber: 1, quantity: 1 }] }),
      "ORDER_CHANNEL_UNSUPPORTED",
    );
    expect(fulfillmentService.createFulfillment).not.toHaveBeenCalled();
  });

  it("refuses cancelled orders", async () => {
    const { service } = setup({ order: order({ status: "cancelled" }) });
    await expectCode(
      service.fulfil(context, orderId, "k", { lines: [{ lineNumber: 1, quantity: 1 }] }),
      "ORDER_CANCELLED",
    );
  });

  it("rejects unknown and duplicate line numbers", async () => {
    const { service } = setup({});
    await expectCode(
      service.fulfil(context, orderId, "k", { lines: [{ lineNumber: 9, quantity: 1 }] }),
      "ORDER_LINE_NOT_FOUND",
    );
    await expectCode(
      service.fulfil(context, orderId, "k", {
        lines: [
          { lineNumber: 1, quantity: 1 },
          { lineNumber: 1, quantity: 1 },
        ],
      }),
      "INVALID_FULFILLMENT",
    );
  });

  it("fails closed when the lines have no reservation or span two locations", async () => {
    const none = setup({ holds: [] });
    await expectCode(
      none.service.fulfil(context, orderId, "k", { lines: [{ lineNumber: 1, quantity: 1 }] }),
      "FULFILLMENT_LOCATION_UNRESOLVED",
    );
    const split = setup({
      holds: [
        { orderLineId: lineA, inventoryLocationId: locationA },
        { orderLineId: lineB, inventoryLocationId: locationB },
      ],
    });
    await expectCode(
      split.service.fulfil(context, orderId, "k", {
        lines: [
          { lineNumber: 1, quantity: 1 },
          { lineNumber: 2, quantity: 1 },
        ],
      }),
      "FULFILLMENT_LOCATION_UNRESOLVED",
    );
    expect(split.fulfillmentService.createFulfillment).not.toHaveBeenCalled();
  });
});

describe("OnlineOrderOperationsService.cancel", () => {
  it("cancels an online order with its reason and returns the refreshed detail", async () => {
    const { service, orderService } = setup({});
    const result = await service.cancel(context, orderId, { reason: "Customer asked" });
    expect(orderService.cancelOrder).toHaveBeenCalledWith(context, {
      orderId,
      reason: "Customer asked",
    });
    expect(result).toBe(detail);
  });

  it("omits an absent reason and refuses POS orders", async () => {
    const online = setup({});
    await online.service.cancel(context, orderId, {});
    expect(online.orderService.cancelOrder).toHaveBeenCalledWith(context, { orderId });

    const pos = setup({ order: order({ channel: "pos" }) });
    await expectCode(pos.service.cancel(context, orderId, {}), "ORDER_CHANNEL_UNSUPPORTED");
    expect(pos.orderService.cancelOrder).not.toHaveBeenCalled();
  });
});
