// Staff fulfilment / cancellation of ONLINE orders over the REAL HTTP server (Next.js API + disposable
// PostgreSQL), driven through the SDK exactly as the POS "Online orders" tab calls it. Orders are placed through
// the real public storefront checkout (COD), so each carries real stock reservations.
//
//   W1  partial fulfil → stock issued from the reserved location, reservation partly consumed, progress partial
//   W2  fulfilling the rest completes the order; an exact replay (same key + lines) ships nothing more
//   W3  over-fulfilment and a reused key with a different intent are refused with no stock change
//   W4  a partly-shipped order cannot be cancelled (409 ORDER_ALREADY_FULFILLED)
//   W5  cancel releases the reservation, records the reason, replays idempotently, and blocks fulfilment
//   W6  a POS order is refused by both operations (ORDER_CHANNEL_UNSUPPORTED)
//   W7  an operator without the order brand authority is refused (403) with no effect
//   W8  /me/context advertises canFulfill / canCancel / canCollect
//   W9  delivered + cash collected: refused until fully shipped, then captures the COD payment, tracking
//       shows Delivered, the list carries paymentStatus, a repeat replays, and the return becomes refundable
//   W10 a cancelled order, a POS order and an operator without brand authority cannot be collected
//
// Launched exclusively by `pnpm test:online:orders:http` (isolated rt-<hex> stack; never the shared dev DB).
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ApiHttpError, createCommerceClient } from "../../packages/sdk/src/index";

const baseUrl = process.env.POS_TEST_API_BASE_URL;
const dbUrl = process.env.POS_TEST_SUPABASE_URL;
const serviceKey = process.env.POS_TEST_SUPABASE_SERVICE_ROLE_KEY;
const token = process.env.POS_TEST_CLERK_TOKEN;
const restrictedToken = process.env.POS_TEST_CLERK_TOKEN_RESTRICTED;
if (!baseUrl || !dbUrl || !serviceKey || !token || !restrictedToken)
  throw new Error("Run through `pnpm test:online:orders:http` (isolated harness environment).");

const T = "2a000001-0000-4000-8000-000000000001";
const B = "2a000002-0000-4000-8000-000000000001";
const V = "2a000007-0000-4000-8000-000000000001";
const L = "2a000004-0000-4000-8000-000000000001";
const REGISTER = "2a000005-0000-4000-8000-000000000001";

const db = createClient(dbUrl, serviceKey, { auth: { persistSession: false } });
const storefront = createCommerceClient({ baseUrl });
const staff = createCommerceClient({ baseUrl, getToken: () => token }).withTenant(T);
const restricted = createCommerceClient({ baseUrl, getToken: () => restrictedToken }).withTenant(T);

async function onHand(): Promise<number> {
  const { data, error } = await db
    .from("inventory_balances")
    .select("on_hand_quantity")
    .eq("tenant_id", T)
    .eq("variant_id", V)
    .eq("inventory_location_id", L)
    .single();
  if (error) throw error;
  return Number(data.on_hand_quantity);
}

async function reservation(orderId: string) {
  const { data, error } = await db
    .from("stock_reservations")
    .select("status,quantity,consumed_quantity,inventory_location_id")
    .eq("tenant_id", T)
    .eq("order_id", orderId)
    .single();
  if (error) throw error;
  return data as {
    status: string;
    quantity: number;
    consumed_quantity: number;
    inventory_location_id: string;
  };
}

async function placeOnlineOrder(quantity: number): Promise<string> {
  const result = await storefront.checkout({
    idempotencyKey: `web-${randomUUID()}`,
    tenantId: T,
    brandId: B,
    lines: [{ variantId: V, quantity }],
    customer: { name: "Mona Adel", phone: "+201000000001", email: null },
    delivery: {
      recipientName: "Mona Adel",
      phone: "+201000000001",
      line1: "12 Nile St",
      line2: null,
      city: "Giza",
      region: null,
      postalCode: null,
      countryCode: "EG",
      notes: null,
    },
    expectedTotalMinor: 2500 * quantity,
    expectedCurrency: "USD",
    paymentMethod: "cash_on_delivery",
  });
  const list = await staff.listOrders({ channel: "online", limit: 25 });
  const order = list.items.find((item) => item.orderNumber === result.orderReference);
  if (!order) throw new Error("The placed order is not visible to staff.");
  return order.id;
}

async function expectApiError(promise: Promise<unknown>, status: number, code?: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiHttpError);
  expect((error as ApiHttpError).status).toBe(status);
  if (code) expect((error as ApiHttpError).code).toBe(code);
}

describe("online order operations over HTTP", () => {
  it("W1–W3: partial then full fulfilment from the reserved location, idempotent and bounded", async () => {
    const orderId = await placeOnlineOrder(3);
    const held = await reservation(orderId);
    expect(held).toMatchObject({ status: "active", quantity: 3, consumed_quantity: 0 });
    expect(held.inventory_location_id).toBe(L);
    const before = await onHand();

    const partial = await staff.fulfillOrder({
      orderId,
      idempotencyKey: `ff-${randomUUID()}`,
      lines: [{ lineNumber: 1, quantity: 1 }],
    });
    expect(partial.fulfillmentProgress.status).toBe("partially_fulfilled");
    expect(partial.fulfillmentProgress.lines[0]!.fulfilledQuantity).toBe(1);
    expect(await onHand()).toBe(before - 1);
    expect(await reservation(orderId)).toMatchObject({ status: "active", consumed_quantity: 1 });

    // W3: more than is left → refused, nothing moves.
    await expectApiError(
      staff.fulfillOrder({
        orderId,
        idempotencyKey: `ff-${randomUUID()}`,
        lines: [{ lineNumber: 1, quantity: 3 }],
      }),
      409,
      "OVER_FULFILLMENT",
    );
    expect(await onHand()).toBe(before - 1);

    // W4: once anything shipped, the order cannot be cancelled.
    await expectApiError(
      staff.cancelOrder({ orderId, idempotencyKey: `cx-${randomUUID()}` }),
      409,
      "ORDER_ALREADY_FULFILLED",
    );

    const key = `ff-${randomUUID()}`;
    const rest = await staff.fulfillOrder({
      orderId,
      idempotencyKey: key,
      lines: [{ lineNumber: 1, quantity: 2 }],
    });
    expect(rest.fulfillmentProgress.status).toBe("fulfilled");
    expect(await onHand()).toBe(before - 3);
    expect(await reservation(orderId)).toMatchObject({ status: "consumed", consumed_quantity: 3 });

    // W2: exact replay of the same key + lines returns the order and ships nothing more.
    const replay = await staff.fulfillOrder({
      orderId,
      idempotencyKey: key,
      lines: [{ lineNumber: 1, quantity: 2 }],
    });
    expect(replay.fulfillmentProgress.status).toBe("fulfilled");
    expect(await onHand()).toBe(before - 3);

    // W3: the same key with a different intent conflicts.
    await expectApiError(
      staff.fulfillOrder({ orderId, idempotencyKey: key, lines: [{ lineNumber: 1, quantity: 1 }] }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await onHand()).toBe(before - 3);
  });

  it("W5: cancel releases the held stock, keeps the reason, replays, and blocks fulfilment", async () => {
    const orderId = await placeOnlineOrder(2);
    const before = await onHand();
    const key = `cx-${randomUUID()}`;
    const cancelled = await staff.cancelOrder({
      orderId,
      idempotencyKey: key,
      reason: "Customer changed mind",
    });
    expect(cancelled.header.status).toBe("cancelled");
    expect(cancelled.cancellation?.reason).toBe("Customer changed mind");
    expect((await reservation(orderId)).status).toBe("released");
    expect(cancelled.commerce?.payment?.status).toBe("cancelled");
    expect(await onHand()).toBe(before);

    const again = await staff.cancelOrder({ orderId, idempotencyKey: `cx-${randomUUID()}` });
    expect(again.header.status).toBe("cancelled");

    await expectApiError(
      staff.fulfillOrder({
        orderId,
        idempotencyKey: `ff-${randomUUID()}`,
        lines: [{ lineNumber: 1, quantity: 1 }],
      }),
      409,
      "ORDER_CANCELLED",
    );
    expect(await onHand()).toBe(before);
  });

  it("W6: POS orders are refused by both operations", async () => {
    const sale = await staff.createPosSale({
      idempotencyKey: `pos-${randomUUID()}`,
      registerId: REGISTER,
      lines: [{ variantId: V, quantity: 1 }],
      expectedTotalMinor: 2500,
      cashReceivedMinor: 2500,
    });
    const orderId = sale.order.id;
    await expectApiError(
      staff.fulfillOrder({
        orderId,
        idempotencyKey: `ff-${randomUUID()}`,
        lines: [{ lineNumber: 1, quantity: 1 }],
      }),
      409,
      "ORDER_CHANNEL_UNSUPPORTED",
    );
    await expectApiError(
      staff.cancelOrder({ orderId, idempotencyKey: `cx-${randomUUID()}` }),
      409,
      "ORDER_CHANNEL_UNSUPPORTED",
    );
  });

  it("W7: an operator without the brand authority is refused with no effect", async () => {
    const orderId = await placeOnlineOrder(1);
    const before = await onHand();
    const refused = await restricted
      .fulfillOrder({
        orderId,
        idempotencyKey: `ff-${randomUUID()}`,
        lines: [{ lineNumber: 1, quantity: 1 }],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(ApiHttpError);
    expect([403, 404]).toContain((refused as ApiHttpError).status);
    await expectApiError(
      restricted.cancelOrder({ orderId, idempotencyKey: `cx-${randomUUID()}` }),
      (refused as ApiHttpError).status,
    );
    expect(await onHand()).toBe(before);
    expect((await reservation(orderId)).status).toBe("active");
  });

  it("W8: /me/context advertises the order operations", async () => {
    const context = await staff.getContext();
    expect(context.access.orders.canFulfill).toBe(true);
    expect(context.access.orders.canCancel).toBe(true);
    expect(context.access.orders.canCollect).toBe(true);
    const limited = await restricted.getContext();
    expect(limited.access.orders.canCancel).toBe(false);
  });

  it("W9: delivered + cash collected after shipping; tracking shows Delivered; returns refundable", async () => {
    const orderId = await placeOnlineOrder(2);
    const placed = await staff.getOrder(orderId);
    expect(placed.commerce?.payment).toMatchObject({
      method: "cash_on_delivery",
      status: "pending",
    });
    const lookup = {
      tenantId: T,
      orderReference: placed.header.orderNumber,
      phone: "+201000000001",
    };

    // Nothing shipped yet → refused, payment untouched.
    await expectApiError(
      staff.collectOrderPayment({ orderId, idempotencyKey: `cod-${randomUUID()}` }),
      409,
      "ORDER_NOT_FULLY_SHIPPED",
    );
    await staff.fulfillOrder({
      orderId,
      idempotencyKey: `ff-${randomUUID()}`,
      lines: [{ lineNumber: 1, quantity: 1 }],
    });
    // Partly shipped → still refused.
    await expectApiError(
      staff.collectOrderPayment({ orderId, idempotencyKey: `cod-${randomUUID()}` }),
      409,
      "ORDER_NOT_FULLY_SHIPPED",
    );
    await staff.fulfillOrder({
      orderId,
      idempotencyKey: `ff-${randomUUID()}`,
      lines: [{ lineNumber: 1, quantity: 1 }],
    });
    expect((await storefront.trackStorefrontOrder(lookup)).stage).toBe("shipped");
    const before = await staff.getReturnEligibility(orderId);
    expect(before.eligible).toBe(false);
    expect(before.reason).toBe("PAYMENT_NOT_CAPTURED");

    const collected = await staff.collectOrderPayment({
      orderId,
      idempotencyKey: `cod-${randomUUID()}`,
    });
    expect(collected.commerce?.payment).toMatchObject({
      status: "captured",
      amountMinor: placed.header.totalMinor,
    });
    expect(collected.commerce?.payment?.capturedAt).toEqual(expect.any(String));
    const { data: row, error } = await db
      .from("payments")
      .select("status,captured_by_membership_id,captured_at")
      .eq("tenant_id", T)
      .eq("order_id", orderId)
      .single();
    if (error) throw error;
    expect(row.status).toBe("captured");
    expect(row.captured_by_membership_id).not.toBeNull();

    expect((await storefront.trackStorefrontOrder(lookup)).stage).toBe("delivered");
    const list = await staff.listOrders({ channel: "online", limit: 25 });
    expect(list.items.find((item) => item.id === orderId)?.paymentStatus).toBe("captured");

    // A repeat (new key) is a harmless replay; the capture time does not move.
    const again = await staff.collectOrderPayment({
      orderId,
      idempotencyKey: `cod-${randomUUID()}`,
    });
    expect(again.commerce?.payment?.capturedAt).toBe(collected.commerce?.payment?.capturedAt);

    const after = await staff.getReturnEligibility(orderId);
    expect(after.eligible).toBe(true);
    expect(after.maxRefundableMinor).toBe(placed.header.totalMinor);
  });

  it("W10: cancelled, POS and out-of-scope orders cannot be collected", async () => {
    const cancelledId = await placeOnlineOrder(1);
    await staff.cancelOrder({ orderId: cancelledId, idempotencyKey: `cx-${randomUUID()}` });
    await expectApiError(
      staff.collectOrderPayment({ orderId: cancelledId, idempotencyKey: `cod-${randomUUID()}` }),
      409,
      "ORDER_CANCELLED",
    );

    const sale = await staff.createPosSale({
      idempotencyKey: `pos-${randomUUID()}`,
      registerId: REGISTER,
      lines: [{ variantId: V, quantity: 1 }],
      expectedTotalMinor: 2500,
      cashReceivedMinor: 2500,
    });
    await expectApiError(
      staff.collectOrderPayment({ orderId: sale.order.id, idempotencyKey: `cod-${randomUUID()}` }),
      409,
      "ORDER_CHANNEL_UNSUPPORTED",
    );

    const orderId = await placeOnlineOrder(1);
    await staff.fulfillOrder({
      orderId,
      idempotencyKey: `ff-${randomUUID()}`,
      lines: [{ lineNumber: 1, quantity: 1 }],
    });
    const refused = await restricted
      .collectOrderPayment({ orderId, idempotencyKey: `cod-${randomUUID()}` })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(refused).toBeInstanceOf(ApiHttpError);
    expect([403, 404]).toContain((refused as ApiHttpError).status);
    expect((await staff.getOrder(orderId)).commerce?.payment?.status).toBe("pending");
  });
});
