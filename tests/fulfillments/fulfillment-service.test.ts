import { describe, expect, it } from "vitest";

import { AuthorizationService } from "../../src/authorization";
import { FulfillmentPermission, FulfillmentService } from "../../src/fulfillments";
import {
  branch,
  brand,
  contextWith,
  defaultResourceTenantMap,
  FakeFulfillmentRepository,
  grant,
  ids,
  location,
  StubResourceRepository,
} from "./fakes";

function build(): { service: FulfillmentService; repo: FakeFulfillmentRepository } {
  const repo = new FakeFulfillmentRepository().seedDefaults();
  const authService = new AuthorizationService(
    new StubResourceRepository(defaultResourceTenantMap()),
  );
  return { service: new FulfillmentService(authService, repo), repo };
}

const allPermissions = [
  FulfillmentPermission.fulfill,
  FulfillmentPermission.issue,
  FulfillmentPermission.read,
];

function tenantWide() {
  return contextWith([grant(allPermissions)]);
}

function onlineInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ids.orderOnline,
    inventoryLocationId: ids.location,
    lines: [{ orderLineId: ids.orderLine1, quantity: 2 }],
    idempotencyKey: "ff-key-1",
    ...overrides,
  };
}

function posInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ids.orderPos,
    inventoryLocationId: ids.location,
    lines: [{ orderLineId: ids.orderLinePos, quantity: 2 }],
    idempotencyKey: "ff-pos-1",
    ...overrides,
  };
}

async function expectFulfillmentError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "FulfillmentError", code });
}

async function expectAuthorizationError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "AuthorizationError", code });
}

describe("FulfillmentService strict input", () => {
  it("rejects an empty lines array", async () => {
    const { service } = build();
    await expectFulfillmentError(
      service.createFulfillment(tenantWide(), onlineInput({ lines: [] })),
      "INVALID_FULFILLMENT",
    );
  });

  it("rejects a non-positive quantity", async () => {
    const { service } = build();
    await expectFulfillmentError(
      service.createFulfillment(
        tenantWide(),
        onlineInput({ lines: [{ orderLineId: ids.orderLine1, quantity: 0 }] }),
      ),
      "INVALID_FULFILLMENT",
    );
  });

  it("rejects a blank idempotency key", async () => {
    const { service } = build();
    await expectFulfillmentError(
      service.createFulfillment(tenantWide(), onlineInput({ idempotencyKey: "   " })),
      "INVALID_FULFILLMENT",
    );
  });

  it("rejects a duplicate order line in one request", async () => {
    const { service } = build();
    await expectFulfillmentError(
      service.createFulfillment(
        tenantWide(),
        onlineInput({
          lines: [
            { orderLineId: ids.orderLine1, quantity: 1 },
            { orderLineId: ids.orderLine1, quantity: 1 },
          ],
        }),
      ),
      "INVALID_FULFILLMENT",
    );
  });

  it("rejects unknown extra fields (no caller-supplied variant/actor/status)", async () => {
    const { service } = build();
    await expectFulfillmentError(
      service.createFulfillment(tenantWide(), onlineInput({ actorMembershipId: ids.membership })),
      "INVALID_FULFILLMENT",
    );
  });
});

describe("FulfillmentService two-authority creation", () => {
  it("creates a fulfillment when BOTH authorities are granted (ONLINE brand + location)", async () => {
    const { service, repo } = build();
    const context = contextWith([
      grant([FulfillmentPermission.fulfill], [brand(ids.brand)]),
      grant([FulfillmentPermission.issue], [location(ids.location)]),
      grant([FulfillmentPermission.read], [brand(ids.brand)]),
    ]);
    const fulfillment = await service.createFulfillment(context, onlineInput());
    expect(fulfillment).toMatchObject({
      orderId: ids.orderOnline,
      inventoryLocationId: ids.location,
      actorMembershipId: ids.membership,
    });
    expect(fulfillment.lines).toHaveLength(1);
    expect(fulfillment.lines[0]).toMatchObject({
      orderLineId: ids.orderLine1,
      variantId: ids.variant1,
      quantity: 2,
    });
    expect(repo.calls).toContain("recordFulfillment");
  });

  it("creates a fulfillment for a POS order authorized against the persisted BRANCH", async () => {
    const { service } = build();
    const context = contextWith([
      grant([FulfillmentPermission.fulfill], [branch(ids.branch)]),
      grant([FulfillmentPermission.issue], [location(ids.location)]),
      grant([FulfillmentPermission.read], [branch(ids.branch)]),
    ]);
    const fulfillment = await service.createFulfillment(context, posInput());
    expect(fulfillment).toMatchObject({ orderId: ids.orderPos, inventoryLocationId: ids.location });
  });

  it("derives the actor from the verified context, never from input", async () => {
    const { service, repo } = build();
    await service.createFulfillment(tenantWide(), onlineInput());
    const stored = [...repo.fulfillments.values()][0];
    expect(stored?.actorMembershipId).toBe(ids.membership);
  });

  it("denies a custody-only caller (inventory.issue but no orders.fulfill)", async () => {
    const { service, repo } = build();
    const context = contextWith([grant([FulfillmentPermission.issue], [location(ids.location)])]);
    await expectAuthorizationError(
      service.createFulfillment(context, onlineInput()),
      "PERMISSION_DENIED",
    );
    expect(repo.calls).not.toContain("recordFulfillment");
  });

  it("denies a commercial-only caller (orders.fulfill but no inventory.issue)", async () => {
    const { service, repo } = build();
    const context = contextWith([grant([FulfillmentPermission.fulfill], [brand(ids.brand)])]);
    await expectAuthorizationError(
      service.createFulfillment(context, onlineInput()),
      "PERMISSION_DENIED",
    );
    expect(repo.calls).not.toContain("recordFulfillment");
  });

  it("denies commercial authority scoped to the wrong brand", async () => {
    const { service } = build();
    const context = contextWith([
      grant([FulfillmentPermission.fulfill], [brand(ids.orderPos)]),
      grant([FulfillmentPermission.issue], [location(ids.location)]),
    ]);
    await expectAuthorizationError(
      service.createFulfillment(context, onlineInput()),
      "SCOPE_DENIED",
    );
  });

  it("denies custody authority scoped to the wrong location", async () => {
    const { service } = build();
    const context = contextWith([
      grant([FulfillmentPermission.fulfill], [brand(ids.brand)]),
      grant([FulfillmentPermission.issue], [location(ids.locationOther)]),
    ]);
    await expectAuthorizationError(
      service.createFulfillment(context, onlineInput()),
      "SCOPE_DENIED",
    );
  });

  it("returns ORDER_NOT_FOUND when the order does not exist", async () => {
    const { service } = build();
    await expectFulfillmentError(
      service.createFulfillment(tenantWide(), onlineInput({ orderId: ids.missingOrder })),
      "ORDER_NOT_FOUND",
    );
  });
});

describe("FulfillmentService idempotent replay", () => {
  it("replays the original fulfillment on the same key + intent", async () => {
    const { service } = build();
    const first = await service.createFulfillment(tenantWide(), onlineInput());
    const replay = await service.createFulfillment(tenantWide(), onlineInput());
    expect(replay.id).toBe(first.id);
    expect(replay.inventoryOperationId).toBe(first.inventoryOperationId);
  });

  it("reports a conflict on the same key with a different intent", async () => {
    const { service } = build();
    await service.createFulfillment(tenantWide(), onlineInput());
    await expectFulfillmentError(
      service.createFulfillment(
        tenantWide(),
        onlineInput({ lines: [{ orderLineId: ids.orderLine1, quantity: 3 }] }),
      ),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("still requires BOTH authorities on replay", async () => {
    const { service } = build();
    await service.createFulfillment(tenantWide(), onlineInput());
    // A caller who can read but lacks custody cannot replay the create.
    const readOnly = contextWith([
      grant([FulfillmentPermission.fulfill], [brand(ids.brand)]),
      grant([FulfillmentPermission.read], [brand(ids.brand)]),
    ]);
    await expectAuthorizationError(
      service.createFulfillment(readOnly, onlineInput()),
      "PERMISSION_DENIED",
    );
  });

  it("authorizes replay against persisted resources without re-resolving order routing", async () => {
    const { service, repo } = build();
    await service.createFulfillment(tenantWide(), onlineInput());
    repo.calls.length = 0;
    await service.createFulfillment(tenantWide(), onlineInput());
    // Replay uses the preflight's persisted routing; it must not bootstrap current order routing.
    expect(repo.calls).not.toContain("getOrderRouting");
    expect(repo.calls).toContain("resolveReplayTarget");
  });
});

describe("FulfillmentService reads", () => {
  it("reads a fulfillment with orders.read alone (no custody required)", async () => {
    const { service } = build();
    const created = await service.createFulfillment(tenantWide(), onlineInput());
    const readContext = contextWith([grant([FulfillmentPermission.read], [brand(ids.brand)])]);
    const loaded = await service.getFulfillment(readContext, { fulfillmentId: created.id });
    expect(loaded.id).toBe(created.id);
  });

  it("denies a read to a caller with only custody authority", async () => {
    const { service } = build();
    const created = await service.createFulfillment(tenantWide(), onlineInput());
    const custodyOnly = contextWith([
      grant([FulfillmentPermission.issue], [location(ids.location)]),
    ]);
    await expectAuthorizationError(
      service.getFulfillment(custodyOnly, { fulfillmentId: created.id }),
      "PERMISSION_DENIED",
    );
  });

  it("returns FULFILLMENT_NOT_FOUND for an unknown id", async () => {
    const { service } = build();
    await expectFulfillmentError(
      service.getFulfillment(tenantWide(), { fulfillmentId: ids.missingFulfillment }),
      "FULFILLMENT_NOT_FOUND",
    );
  });

  it("derives a per-line fulfillment progress summary", async () => {
    const { service } = build();
    await service.createFulfillment(tenantWide(), onlineInput()); // line1: 2 of 5
    const summary = await service.getOrderFulfillmentSummary(tenantWide(), {
      orderId: ids.orderOnline,
    });
    expect(summary.status).toBe("partially_fulfilled");
    const line1 = summary.lines.find((line) => line.orderLineId === ids.orderLine1);
    expect(line1).toMatchObject({
      orderedQuantity: 5,
      fulfilledQuantity: 2,
      status: "partially_fulfilled",
    });
    const line2 = summary.lines.find((line) => line.orderLineId === ids.orderLine2);
    expect(line2).toMatchObject({ fulfilledQuantity: 0, status: "unfulfilled" });
  });

  it("lists all fulfillments of an order", async () => {
    const { service } = build();
    await service.createFulfillment(tenantWide(), onlineInput());
    await service.createFulfillment(
      tenantWide(),
      onlineInput({
        idempotencyKey: "ff-key-2",
        lines: [{ orderLineId: ids.orderLine2, quantity: 1 }],
      }),
    );
    const list = await service.getOrderFulfillments(tenantWide(), { orderId: ids.orderOnline });
    expect(list).toHaveLength(2);
  });
});
