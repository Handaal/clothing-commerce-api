import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  AuthorizationService,
  type AuthorizationContext,
  type AuthorizationResource,
} from "../../src/authorization";
import type { EffectiveAuthorizationAssignment } from "../../src/authorization/model";
import { createSupabaseAuthorizationRepository } from "../../src/authorization/supabase-authorization-repository";
import { FulfillmentService } from "../../src/fulfillments";
import { createSupabaseFulfillmentRepository } from "../../src/fulfillments/supabase-fulfillment-repository";
import { OrderService, createSupabaseOrdersRepository } from "../../src/orders";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  membership: "71000000-0000-4000-8000-000000000001",
  user: "70000000-0000-4000-8000-000000000001",
  brand: "20000000-0000-4000-8000-000000000001",
  branch: "b0000000-0000-4000-8000-000000000001",
  variantA: "60000000-0000-4000-8000-000000000001",
  variantArchive: "60000000-0000-4000-8000-00000000000c",
  variantLow: "60000000-0000-4000-8000-0000000000a1",
  loc1: "e0000000-0000-4000-8000-000000000001",
  loc2: "e0000000-0000-4000-8000-000000000002",
  locDisabled: "e0000000-0000-4000-8000-000000000003",
  locInactive: "e0000000-0000-4000-8000-000000000004",
  locReplayInactive: "e0000000-0000-4000-8000-000000000005",
  locReplayDisabled: "e0000000-0000-4000-8000-000000000006",
} as const;

const url = process.env.FULFILLMENT_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.FULFILLMENT_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "Run this suite through pnpm test:fulfillment:integration; no shared or production Supabase project is supported.",
  );
}

const authorizationService = new AuthorizationService(
  createSupabaseAuthorizationRepository({ url, serviceRoleKey }),
);
const repository = createSupabaseFulfillmentRepository({ url, serviceRoleKey });
const service = new FulfillmentService(authorizationService, repository);
// The real sanctioned Orders application path (used to prove the FF030 -> ORDER_ALREADY_FULFILLED
// mapping surfaces through OrderService.cancelOrder, not a raw orders_private RPC).
const orderService = new OrderService(
  authorizationService,
  createSupabaseOrdersRepository({ url, serviceRoleKey }),
);

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

function assignment(
  permissionKeys: readonly string[],
  targets?: readonly AuthorizationResource[],
): EffectiveAuthorizationAssignment {
  return {
    assignmentId: "a2000000-0000-4000-8000-000000000001",
    roleId: "90000000-0000-4000-8000-000000000001",
    isProtectedRole: false,
    accessScopeId: "a1000000-0000-4000-8000-000000000009",
    scopeMode: targets ? "explicit" : "tenant",
    scopeTargets: targets ?? [],
    permissionKeys,
  };
}

function context(assignments: readonly EffectiveAuthorizationAssignment[]): AuthorizationContext {
  return {
    authentication: { provider: "clerk", subject: "integration" },
    userIdentity: { id: ids.user },
    tenant: { id: ids.tenant },
    membership: { id: ids.membership },
    assignments,
  };
}

const tenantWide = () =>
  context([assignment(["orders.fulfill", "inventory.issue", "orders.read"])]);

// Commercial cancellation authority (Phase 2D), used to drive OrderService.cancelOrder.
const cancelContext = () => context([assignment(["orders.cancel", "orders.read"])]);

async function orderIdByKey(key: string): Promise<string> {
  const { data, error } = await admin
    .from("orders")
    .select("id")
    .eq("tenant_id", ids.tenant)
    .eq("normalized_idempotency_key", key)
    .limit(1);
  if (error || !data || data.length === 0) {
    throw new Error(`could not resolve seed order for key ${key}`);
  }
  return (data[0] as { id: string }).id;
}

async function orderLineId(orderId: string, variantId: string): Promise<string> {
  const { data, error } = await admin
    .from("order_lines")
    .select("id")
    .eq("order_id", orderId)
    .eq("variant_id", variantId)
    .limit(1);
  if (error || !data || data.length === 0) {
    throw new Error(`could not resolve order line for ${orderId}/${variantId}`);
  }
  return (data[0] as { id: string }).id;
}

async function movementCount(operationId: string): Promise<number> {
  const { count, error } = await admin
    .from("inventory_movements")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", ids.tenant)
    .eq("operation_id", operationId);
  if (error) {
    throw new Error(`movement count failed: ${error.message}`);
  }
  return count ?? 0;
}

async function fulfillmentCount(orderId: string): Promise<number> {
  const { count, error } = await admin
    .from("fulfillments")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", ids.tenant)
    .eq("order_id", orderId);
  if (error) {
    throw new Error(`fulfillment count failed: ${error.message}`);
  }
  return count ?? 0;
}

async function orderStatus(orderId: string): Promise<string> {
  const { data, error } = await admin.from("orders").select("status").eq("id", orderId).limit(1);
  if (error || !data || data.length === 0) {
    throw new Error("order status lookup failed");
  }
  return (data[0] as { status: string }).status;
}

async function cancellationMetadata(orderId: string): Promise<{
  cancelled_at: string | null;
  cancelled_by_membership_id: string | null;
  cancellation_reason: string | null;
}> {
  const { data, error } = await admin
    .from("orders")
    .select("cancelled_at,cancelled_by_membership_id,cancellation_reason")
    .eq("id", orderId)
    .limit(1);
  if (error || !data || data.length === 0) {
    throw new Error("cancellation metadata lookup failed");
  }
  return data[0] as {
    cancelled_at: string | null;
    cancelled_by_membership_id: string | null;
    cancellation_reason: string | null;
  };
}

async function expectFulfillmentError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "FulfillmentError", code });
}

async function expectOrderError(
  promise: Promise<unknown>,
  code: string,
  httpStatus: number,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "OrderError", code, httpStatus });
}

async function expectAuthorizationError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "AuthorizationError", code });
}

describe("Fulfillment integration: partial, multiple, multi-location, audit link", () => {
  it("fulfills an order across multiple fulfillments and locations, then reports fulfilled", async () => {
    const orderId = await orderIdByKey("seed-online");
    const line = await orderLineId(orderId, ids.variantA);

    const first = await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.loc1,
      lines: [{ orderLineId: line, quantity: 4 }],
      idempotencyKey: "int-online-1",
    });
    expect(first.lines[0]).toMatchObject({ variantId: ids.variantA, quantity: 4 });
    // Audit link: the fulfillment references exactly one inventory operation with one movement.
    expect(await movementCount(first.inventoryOperationId)).toBe(1);

    const partial = await service.getOrderFulfillmentSummary(tenantWide(), { orderId });
    expect(partial.status).toBe("partially_fulfilled");

    // A second fulfillment from the SAME location, then a third from a DIFFERENT location.
    await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.loc1,
      lines: [{ orderLineId: line, quantity: 3 }],
      idempotencyKey: "int-online-2",
    });
    await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.loc2,
      lines: [{ orderLineId: line, quantity: 3 }],
      idempotencyKey: "int-online-3",
    });

    const list = await service.getOrderFulfillments(tenantWide(), { orderId });
    expect(list).toHaveLength(3);
    const locations = list.map((fulfillment) => fulfillment.inventoryLocationId).sort();
    expect(locations).toEqual([ids.loc1, ids.loc1, ids.loc2].sort());

    const summary = await service.getOrderFulfillmentSummary(tenantWide(), { orderId });
    expect(summary.status).toBe("fulfilled");
    expect(summary.lines[0]).toMatchObject({ orderedQuantity: 10, fulfilledQuantity: 10 });

    // No payment/commercial side effect: the order stays placed.
    expect(await orderStatus(orderId)).toBe("placed");
  });
});

describe("Fulfillment integration: two-authority enforcement", () => {
  it("fulfills a POS order authorized against the persisted branch", async () => {
    const orderId = await orderIdByKey("seed-pos");
    const line = await orderLineId(orderId, ids.variantA);
    const branchScoped = context([
      assignment(["orders.fulfill"], [{ kind: "branch", id: ids.branch }]),
      assignment(["inventory.issue"], [{ kind: "inventory_location", id: ids.loc1 }]),
      assignment(["orders.read"], [{ kind: "branch", id: ids.branch }]),
    ]);
    const fulfillment = await service.createFulfillment(branchScoped, {
      orderId,
      inventoryLocationId: ids.loc1,
      lines: [{ orderLineId: line, quantity: 4 }],
      idempotencyKey: "int-pos-1",
    });
    expect(fulfillment.orderId).toBe(orderId);

    // Over-fulfillment: the line is fully fulfilled, so any further request is rejected.
    await expectFulfillmentError(
      service.createFulfillment(branchScoped, {
        orderId,
        inventoryLocationId: ids.loc1,
        lines: [{ orderLineId: line, quantity: 1 }],
        idempotencyKey: "int-pos-over",
      }),
      "OVER_FULFILLMENT",
    );
  });

  it("denies a custody-only caller and a commercial-only caller", async () => {
    const orderId = await orderIdByKey("seed-cancel-zero");
    const line = await orderLineId(orderId, ids.variantA);
    const custodyOnly = context([
      assignment(["inventory.issue"], [{ kind: "inventory_location", id: ids.loc1 }]),
    ]);
    const commercialOnly = context([
      assignment(["orders.fulfill"], [{ kind: "brand", id: ids.brand }]),
    ]);
    await expectAuthorizationError(
      service.createFulfillment(custodyOnly, {
        orderId,
        inventoryLocationId: ids.loc1,
        lines: [{ orderLineId: line, quantity: 1 }],
        idempotencyKey: "int-deny-custody",
      }),
      "PERMISSION_DENIED",
    );
    await expectAuthorizationError(
      service.createFulfillment(commercialOnly, {
        orderId,
        inventoryLocationId: ids.loc1,
        lines: [{ orderLineId: line, quantity: 1 }],
        idempotencyKey: "int-deny-commercial",
      }),
      "PERMISSION_DENIED",
    );
    expect(await fulfillmentCount(orderId)).toBe(0);
  });
});

describe("Fulfillment integration: atomicity and location capability", () => {
  it("rolls back atomically on insufficient stock (no fulfillment, no movement)", async () => {
    const orderId = await orderIdByKey("seed-low");
    const line = await orderLineId(orderId, ids.variantLow);
    await expectFulfillmentError(
      service.createFulfillment(tenantWide(), {
        orderId,
        inventoryLocationId: ids.loc1,
        lines: [{ orderLineId: line, quantity: 5 }],
        idempotencyKey: "int-low",
      }),
      "INSUFFICIENT_STOCK",
    );
    expect(await fulfillmentCount(orderId)).toBe(0);
    // Only the opening movement exists for the low variant.
    const { count } = await admin
      .from("inventory_movements")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", ids.tenant)
      .eq("variant_id", ids.variantLow);
    expect(count).toBe(1);
  });

  it("still fulfills an order whose variant was archived after placement", async () => {
    const orderId = await orderIdByKey("seed-archive");
    const line = await orderLineId(orderId, ids.variantArchive);
    const fulfillment = await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.loc1,
      lines: [{ orderLineId: line, quantity: 2 }],
      idempotencyKey: "int-archive",
    });
    expect(fulfillment.lines[0]).toMatchObject({ variantId: ids.variantArchive, quantity: 2 });
  });

  it("denies a new fulfillment at an inactive or fulfillment-disabled location", async () => {
    const orderId = await orderIdByKey("seed-cancel-zero");
    const line = await orderLineId(orderId, ids.variantA);
    await expectFulfillmentError(
      service.createFulfillment(tenantWide(), {
        orderId,
        inventoryLocationId: ids.locInactive,
        lines: [{ orderLineId: line, quantity: 1 }],
        idempotencyKey: "int-loc-inactive",
      }),
      "LOCATION_INACTIVE",
    );
    await expectFulfillmentError(
      service.createFulfillment(tenantWide(), {
        orderId,
        inventoryLocationId: ids.locDisabled,
        lines: [{ orderLineId: line, quantity: 1 }],
        idempotencyKey: "int-loc-disabled",
      }),
      "LOCATION_CAPABILITY_DENIED",
    );
  });
});

describe("Fulfillment integration: idempotency and replay", () => {
  it("replays the same key + intent and rejects a different intent", async () => {
    const orderId = await orderIdByKey("seed-replay-disabled");
    const line = await orderLineId(orderId, ids.variantA);
    const first = await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.locReplayDisabled,
      lines: [{ orderLineId: line, quantity: 1 }],
      idempotencyKey: "int-replay-key",
    });
    const replay = await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.locReplayDisabled,
      lines: [{ orderLineId: line, quantity: 1 }],
      idempotencyKey: "int-replay-key",
    });
    expect(replay.id).toBe(first.id);
    expect(replay.inventoryOperationId).toBe(first.inventoryOperationId);

    await expectFulfillmentError(
      service.createFulfillment(tenantWide(), {
        orderId,
        inventoryLocationId: ids.locReplayDisabled,
        lines: [{ orderLineId: line, quantity: 999 }],
        idempotencyKey: "int-replay-key",
      }),
      "IDEMPOTENCY_CONFLICT",
    );

    // Disable the location AFTER the original fulfillment; a replay still returns the original and never
    // re-checks capability or re-issues.
    await admin
      .from("inventory_locations")
      .update({ is_fulfillment_enabled: false })
      .eq("tenant_id", ids.tenant)
      .eq("id", ids.locReplayDisabled);
    const afterDisable = await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.locReplayDisabled,
      lines: [{ orderLineId: line, quantity: 1 }],
      idempotencyKey: "int-replay-key",
    });
    expect(afterDisable.id).toBe(first.id);
    expect(await fulfillmentCount(orderId)).toBe(1);
  });

  it("replays after the location becomes inactive", async () => {
    const orderId = await orderIdByKey("seed-replay-inactive");
    const line = await orderLineId(orderId, ids.variantA);
    const first = await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.locReplayInactive,
      lines: [{ orderLineId: line, quantity: 2 }],
      idempotencyKey: "int-replay-inactive-key",
    });
    await admin
      .from("inventory_locations")
      .update({ status: "inactive" })
      .eq("tenant_id", ids.tenant)
      .eq("id", ids.locReplayInactive);
    const replay = await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.locReplayInactive,
      lines: [{ orderLineId: line, quantity: 2 }],
      idempotencyKey: "int-replay-inactive-key",
    });
    expect(replay.id).toBe(first.id);
    expect(await fulfillmentCount(orderId)).toBe(1);
  });
});

describe("Fulfillment integration: order cancellation interaction", () => {
  // Cancellation is exercised through the REAL sanctioned application path
  // (OrderService.cancelOrder -> SupabaseOrdersRepository.cancelOrder), so the FF030 database signal is
  // proven to surface as the stable ORDER_ALREADY_FULFILLED (409) OrderError, not a raw RPC code. The
  // DB-level FF030 emission itself is independently asserted by the SQL persistence/concurrency suites.

  it("allows cancelling an order with zero fulfillments through the order service", async () => {
    const orderId = await orderIdByKey("seed-cancel-zero");
    const result = await orderService.cancelOrder(cancelContext(), {
      orderId,
      reason: "integration",
    });
    expect(result.status).toBe("cancelled");
    expect(await orderStatus(orderId)).toBe("cancelled");
  });

  it("blocks cancelling an order with a partial fulfillment (ORDER_ALREADY_FULFILLED / 409)", async () => {
    const orderId = await orderIdByKey("seed-cancel-partial");
    const line = await orderLineId(orderId, ids.variantA);
    const fulfillment = await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.loc1,
      lines: [{ orderLineId: line, quantity: 2 }],
      idempotencyKey: "int-cancel-partial",
    });

    await expectOrderError(
      orderService.cancelOrder(cancelContext(), { orderId, reason: "integration" }),
      "ORDER_ALREADY_FULFILLED",
      409,
    );

    // The rejected cancellation must not have altered any persisted state.
    expect(await orderStatus(orderId)).toBe("placed");
    expect(await fulfillmentCount(orderId)).toBe(1);
    expect(await movementCount(fulfillment.inventoryOperationId)).toBe(1);
    const metadata = await cancellationMetadata(orderId);
    expect(metadata.cancelled_at).toBeNull();
    expect(metadata.cancelled_by_membership_id).toBeNull();
    expect(metadata.cancellation_reason).toBeNull();
  });

  it("blocks cancelling a fully fulfilled order (ORDER_ALREADY_FULFILLED / 409)", async () => {
    const orderId = await orderIdByKey("seed-cancel-full");
    const line = await orderLineId(orderId, ids.variantA);
    const fulfillment = await service.createFulfillment(tenantWide(), {
      orderId,
      inventoryLocationId: ids.loc1,
      lines: [{ orderLineId: line, quantity: 3 }],
      idempotencyKey: "int-cancel-full",
    });

    await expectOrderError(
      orderService.cancelOrder(cancelContext(), { orderId, reason: "integration" }),
      "ORDER_ALREADY_FULFILLED",
      409,
    );

    expect(await orderStatus(orderId)).toBe("placed");
    expect(await fulfillmentCount(orderId)).toBe(1);
    expect(await movementCount(fulfillment.inventoryOperationId)).toBe(1);
    const metadata = await cancellationMetadata(orderId);
    expect(metadata.cancelled_at).toBeNull();
    expect(metadata.cancelled_by_membership_id).toBeNull();
    expect(metadata.cancellation_reason).toBeNull();
  });
});
