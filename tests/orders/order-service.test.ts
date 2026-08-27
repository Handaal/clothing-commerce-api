import { describe, expect, it } from "vitest";

import { AuthorizationService } from "../../src/authorization";
import { OrderPermission, OrderService } from "../../src/orders";
import {
  brand,
  branch,
  contextWith,
  defaultResourceTenantMap,
  FakeOrderRepository,
  grant,
  ids,
  StubResourceRepository,
} from "./fakes";

function build(): { service: OrderService; repo: FakeOrderRepository } {
  const repo = new FakeOrderRepository().seedDefaults();
  const authService = new AuthorizationService(
    new StubResourceRepository(defaultResourceTenantMap()),
  );
  return { service: new OrderService(authService, repo), repo };
}

const allPermissions = [OrderPermission.read, OrderPermission.create, OrderPermission.cancel];

function tenantWide() {
  return contextWith([grant(allPermissions)]);
}

function posInput(overrides: Record<string, unknown> = {}) {
  return {
    channel: "pos" as const,
    registerId: ids.register,
    currency: "USD",
    lines: [{ variantId: ids.variantA, quantity: 2 }],
    idempotencyKey: "pos-key-1",
    ...overrides,
  };
}

function onlineInput(overrides: Record<string, unknown> = {}) {
  return {
    channel: "online" as const,
    currency: "USD",
    lines: [{ variantId: ids.variantA, quantity: 1 }],
    idempotencyKey: "online-key-1",
    ...overrides,
  };
}

async function expectOrderError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "OrderError", code });
}

async function expectAuthorizationError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "AuthorizationError", code });
}

describe("OrderService POS authorization", () => {
  it("creates a POS order for a branch-scoped cashier (no brand scope required)", async () => {
    const { service } = build();
    const context = contextWith([grant([OrderPermission.create], [branch(ids.branch)])]);
    const order = await service.createOrder(context, posInput());
    expect(order).toMatchObject({
      channel: "pos",
      status: "placed",
      brandId: ids.brand,
      branchId: ids.branch,
      registerId: ids.register,
      currency: "USD",
      totalMinor: 5198,
    });
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]).toMatchObject({
      lineNumber: 1,
      quantity: 2,
      unitPriceMinor: 2599,
      lineTotalMinor: 5198,
      sku: "TEE-M-BLK",
      optionSummary: "Size: M / Color: Black",
    });
  });

  it("denies a POS create for a brand-only scoped user (branch authority required)", async () => {
    const { service } = build();
    const context = contextWith([grant([OrderPermission.create], [brand(ids.brand)])]);
    await expectAuthorizationError(service.createOrder(context, posInput()), "SCOPE_DENIED");
  });

  it("denies a POS create without orders.create", async () => {
    const { service } = build();
    const context = contextWith([grant([OrderPermission.read], [branch(ids.branch)])]);
    await expectAuthorizationError(service.createOrder(context, posInput()), "PERMISSION_DENIED");
  });

  it("derives the actor membership from context, never from input", async () => {
    const { service, repo } = build();
    await service.createOrder(tenantWide(), posInput());
    expect(repo.lastCreateCommand().actorMembershipId).toBe(ids.membership);
  });
});

describe("OrderService ONLINE authorization", () => {
  it("creates an ONLINE order authorized on the derived brand with a null actor", async () => {
    const { service, repo } = build();
    const context = contextWith([grant([OrderPermission.create], [brand(ids.brand)])]);
    const order = await service.createOrder(context, onlineInput());
    expect(order).toMatchObject({
      channel: "online",
      branchId: null,
      registerId: null,
      actorMembershipId: null,
      totalMinor: 2599,
    });
    expect(repo.lastCreateCommand().actorMembershipId).toBeNull();
  });

  it("denies an ONLINE create for a branch-only scoped user (brand authority required)", async () => {
    const { service } = build();
    const context = contextWith([grant([OrderPermission.create], [branch(ids.branch)])]);
    await expectAuthorizationError(service.createOrder(context, onlineInput()), "SCOPE_DENIED");
  });
});

describe("OrderService NEW-command validation", () => {
  it("rejects a missing register", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(tenantWide(), posInput({ registerId: ids.registerMissing })),
      "REGISTER_NOT_FOUND",
    );
  });

  it("rejects an inactive register", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(tenantWide(), posInput({ registerId: ids.registerInactive })),
      "REGISTER_INACTIVE",
    );
  });

  it("rejects an inactive branch", async () => {
    const { service, repo } = build();
    repo.branchStatuses.set(ids.branch, "inactive");
    await expectOrderError(service.createOrder(tenantWide(), posInput()), "BRANCH_INACTIVE");
  });

  it("rejects a brand the branch does not carry", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(
        tenantWide(),
        posInput({ lines: [{ variantId: ids.variantOtherBrand, quantity: 1 }] }),
      ),
      "BRAND_NOT_AVAILABLE_AT_BRANCH",
    );
  });

  it("rejects a draft (non-sellable) variant", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(
        tenantWide(),
        posInput({ lines: [{ variantId: ids.variantDraft, quantity: 1 }] }),
      ),
      "VARIANT_INACTIVE",
    );
  });

  it("rejects a missing variant", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(
        tenantWide(),
        posInput({ lines: [{ variantId: ids.variantMissing, quantity: 1 }] }),
      ),
      "VARIANT_NOT_FOUND",
    );
  });

  it("rejects a variant with no active price in the order currency", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(tenantWide(), posInput({ currency: "EUR" })),
      "PRICE_NOT_FOUND",
    );
  });

  it("rejects a cross-brand order", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(
        tenantWide(),
        onlineInput({
          lines: [
            { variantId: ids.variantA, quantity: 1 },
            { variantId: ids.variantOtherBrand, quantity: 1 },
          ],
        }),
      ),
      "CROSS_BRAND_ORDER",
    );
  });

  it("rejects an order whose amount exceeds the safe integer range", async () => {
    const { service, repo } = build();
    repo.prices.set(`${ids.variantA}:USD`, 9_000_000_000_000_000);
    await expectOrderError(
      service.createOrder(
        tenantWide(),
        posInput({ lines: [{ variantId: ids.variantA, quantity: 2 }] }),
      ),
      "AMOUNT_OUT_OF_RANGE",
    );
  });
});

describe("OrderService idempotency and replay", () => {
  it("replays the original order for the same key and intent without a second create", async () => {
    const { service, repo } = build();
    const first = await service.createOrder(tenantWide(), posInput());
    const second = await service.createOrder(tenantWide(), posInput());
    expect(second.id).toBe(first.id);
    expect(repo.calls.filter((c) => c.method === "createOrder")).toHaveLength(1);
  });

  it("returns the original snapshot price on replay after a catalog price change", async () => {
    const { service, repo } = build();
    const first = await service.createOrder(tenantWide(), posInput());
    repo.prices.set(`${ids.variantA}:USD`, 9999);
    const replay = await service.createOrder(tenantWide(), posInput());
    expect(replay.id).toBe(first.id);
    expect(replay.lines[0]?.unitPriceMinor).toBe(2599);
  });

  it("replays after the variant is archived", async () => {
    const { service, repo } = build();
    const first = await service.createOrder(tenantWide(), posInput());
    repo.variants.get(ids.variantA)!.status = "archived";
    const replay = await service.createOrder(tenantWide(), posInput());
    expect(replay.id).toBe(first.id);
  });

  it("replays a POS order after its register is disabled", async () => {
    const { service, repo } = build();
    const first = await service.createOrder(tenantWide(), posInput());
    repo.registers.set(ids.register, { branchId: ids.branch, status: "inactive" });
    const replay = await service.createOrder(tenantWide(), posInput());
    expect(replay.id).toBe(first.id);
  });

  it("conflicts on the same key with a different intent", async () => {
    const { service } = build();
    await service.createOrder(tenantWide(), posInput());
    await expectOrderError(
      service.createOrder(
        tenantWide(),
        posInput({ lines: [{ variantId: ids.variantA, quantity: 3 }] }),
      ),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("still requires authorization on replay (key possession does not bypass)", async () => {
    const { service } = build();
    await service.createOrder(tenantWide(), posInput());
    const unauthorized = contextWith([grant([OrderPermission.read], [branch(ids.branch)])]);
    await expectAuthorizationError(
      service.createOrder(unauthorized, posInput()),
      "PERMISSION_DENIED",
    );
  });

  it("authorizes a replay against the persisted branch after register reassignment", async () => {
    const { service, repo } = build();
    const branchScoped = contextWith([grant([OrderPermission.create], [branch(ids.branch)])]);
    const first = await service.createOrder(
      branchScoped,
      posInput({ idempotencyKey: "reassign-key" }),
    );

    // The register is reassigned to another branch after the original create.
    repo.registers.set(ids.register, { branchId: ids.branchOther, status: "active" });

    // Replay: same key/intent, caller authorized only for the ORIGINAL branch -> succeeds.
    const replay = await service.createOrder(
      branchScoped,
      posInput({ idempotencyKey: "reassign-key" }),
    );
    expect(replay.id).toBe(first.id);
    expect(replay.branchId).toBe(ids.branch);

    // A NEW command on the reassigned register requires the NEW branch's authority.
    await expectAuthorizationError(
      service.createOrder(branchScoped, posInput({ idempotencyKey: "new-key" })),
      "SCOPE_DENIED",
    );
  });
});

describe("OrderService reads", () => {
  it("reads an order after authorizing on its branch", async () => {
    const { service } = build();
    const created = await service.createOrder(tenantWide(), posInput());
    const read = await service.getOrder(tenantWide(), { orderId: created.id });
    expect(read.id).toBe(created.id);
  });

  it("reads an order by number", async () => {
    const { service } = build();
    const created = await service.createOrder(tenantWide(), posInput());
    const read = await service.getOrderByNumber(tenantWide(), { orderNumber: created.orderNumber });
    expect(read.id).toBe(created.id);
  });

  it("returns ORDER_NOT_FOUND for an unknown order", async () => {
    const { service } = build();
    await expectOrderError(
      service.getOrder(tenantWide(), { orderId: ids.variantMissing }),
      "ORDER_NOT_FOUND",
    );
  });

  it("denies a read when the scope does not cover the order branch", async () => {
    const { service } = build();
    const created = await service.createOrder(tenantWide(), posInput());
    const wrongScope = contextWith([grant([OrderPermission.read], [branch(ids.branchOther)])]);
    await expectAuthorizationError(
      service.getOrder(wrongScope, { orderId: created.id }),
      "SCOPE_DENIED",
    );
  });
});

describe("OrderService cancellation", () => {
  it("cancels a placed order with actor and reason", async () => {
    const { service } = build();
    const created = await service.createOrder(tenantWide(), posInput());
    const cancelled = await service.cancelOrder(tenantWide(), {
      orderId: created.id,
      reason: "customer changed mind",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelledByMembershipId: ids.membership,
      cancellationReason: "customer changed mind",
    });
    expect(cancelled.cancelledAt).not.toBeNull();
  });

  it("preserves the original cancellation metadata on a repeated cancel", async () => {
    const { service } = build();
    const created = await service.createOrder(tenantWide(), posInput());
    const firstCancel = await service.cancelOrder(tenantWide(), {
      orderId: created.id,
      reason: "first reason",
    });
    const secondActor = contextWith([grant(allPermissions)], { membershipId: ids.otherMembership });
    const secondCancel = await service.cancelOrder(secondActor, {
      orderId: created.id,
      reason: "second reason",
    });
    expect(secondCancel.cancellationReason).toBe("first reason");
    expect(secondCancel.cancelledByMembershipId).toBe(ids.membership);
    expect(secondCancel.cancelledAt).toBe(firstCancel.cancelledAt);
  });

  it("denies cancellation without orders.cancel", async () => {
    const { service } = build();
    const created = await service.createOrder(tenantWide(), posInput());
    const readOnly = contextWith([grant([OrderPermission.read, OrderPermission.create])]);
    await expectAuthorizationError(
      service.cancelOrder(readOnly, { orderId: created.id }),
      "PERMISSION_DENIED",
    );
  });
});

describe("OrderService input validation", () => {
  it("rejects an online order that supplies a register", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(tenantWide(), { ...onlineInput(), registerId: ids.register }),
      "INVALID_ORDER",
    );
  });

  it("rejects a pos order without a register", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(tenantWide(), {
        channel: "pos",
        currency: "USD",
        lines: [{ variantId: ids.variantA, quantity: 2 }],
        idempotencyKey: "no-register",
      }),
      "INVALID_ORDER",
    );
  });

  it("rejects an empty line list", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(tenantWide(), posInput({ lines: [] })),
      "INVALID_ORDER",
    );
  });

  it("rejects a caller-supplied unknown field", async () => {
    const { service } = build();
    await expectOrderError(
      service.createOrder(tenantWide(), posInput({ brandId: ids.brand })),
      "INVALID_ORDER",
    );
  });
});
