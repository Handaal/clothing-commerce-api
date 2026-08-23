import { describe, expect, it } from "vitest";

import { AuthorizationService } from "../../src/authorization";
import { InventoryError, InventoryPermission, InventoryService } from "../../src/inventory";
import {
  contextWith,
  defaultResourceTenantMap,
  FakeInventoryRepository,
  grant,
  ids,
  location,
  StubResourceRepository,
} from "./fakes";

function build(): { service: InventoryService; repo: FakeInventoryRepository } {
  const repo = new FakeInventoryRepository().seedDefaults();
  const authService = new AuthorizationService(
    new StubResourceRepository(defaultResourceTenantMap()),
  );
  return { service: new InventoryService(authService, repo), repo };
}

const allPermissions = [
  InventoryPermission.read,
  InventoryPermission.adjust,
  InventoryPermission.receive,
  InventoryPermission.issue,
  InventoryPermission.transfer,
];

function tenantWideContext() {
  return contextWith([grant(allPermissions)]);
}

async function expectInventoryError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "InventoryError", code });
}

async function expectAuthorizationError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "AuthorizationError", code });
}

describe("InventoryService authorization", () => {
  it("denies a read without inventory.read", async () => {
    const { service } = build();
    const context = contextWith([grant([InventoryPermission.adjust])]);
    await expectAuthorizationError(
      service.getInventoryBalance(context, {
        variantId: ids.variantActive,
        inventoryLocationId: ids.locationActive,
      }),
      "PERMISSION_DENIED",
    );
  });

  it("denies when an explicit scope does not cover the target location", async () => {
    const { service } = build();
    const context = contextWith([
      grant([InventoryPermission.read], [location(ids.locationDestination)]),
    ]);
    await expectAuthorizationError(
      service.getInventoryBalance(context, {
        variantId: ids.variantActive,
        inventoryLocationId: ids.locationActive,
      }),
      "SCOPE_DENIED",
    );
  });

  it("allows a read when an explicit scope covers the target location", async () => {
    const { service } = build();
    const context = contextWith([
      grant([InventoryPermission.read], [location(ids.locationActive)]),
    ]);
    const result = await service.getInventoryBalance(context, {
      variantId: ids.variantActive,
      inventoryLocationId: ids.locationActive,
    });
    expect(result).toMatchObject({ onHand: 0, version: 0, exists: false });
  });

  it("rejects a location that belongs to another tenant", async () => {
    const { service } = build();
    await expectAuthorizationError(
      service.getInventoryBalance(tenantWideContext(), {
        variantId: ids.variantActive,
        inventoryLocationId: ids.locationForeign,
      }),
      "TENANT_ACCESS_DENIED",
    );
  });

  it("requires the correct permission per command (receive needs inventory.receive)", async () => {
    const { service } = build();
    const context = contextWith([grant([InventoryPermission.adjust])]);
    await expectAuthorizationError(
      service.receiveInventory(context, {
        variantId: ids.variantActive,
        inventoryLocationId: ids.locationActive,
        quantity: 5,
        idempotencyKey: "k",
      }),
      "PERMISSION_DENIED",
    );
  });
});

describe("InventoryService transfer authorization (both locations)", () => {
  const transferInput = {
    variantId: ids.variantActive,
    sourceInventoryLocationId: ids.locationActive,
    destinationInventoryLocationId: ids.locationDestination,
    quantity: 3,
    idempotencyKey: "t",
  };

  it("denies when only the source location is in scope", async () => {
    const { service } = build();
    const context = contextWith([
      grant([InventoryPermission.transfer], [location(ids.locationActive)]),
    ]);
    await expectAuthorizationError(
      service.transferInventory(context, transferInput),
      "SCOPE_DENIED",
    );
  });

  it("denies when only the destination location is in scope", async () => {
    const { service } = build();
    const context = contextWith([
      grant([InventoryPermission.transfer], [location(ids.locationDestination)]),
    ]);
    await expectAuthorizationError(
      service.transferInventory(context, transferInput),
      "SCOPE_DENIED",
    );
  });

  it("allows when both locations are covered (one explicit scope listing both)", async () => {
    const { service, repo } = build();
    const context = contextWith([
      grant(
        [InventoryPermission.transfer],
        [location(ids.locationActive), location(ids.locationDestination)],
      ),
    ]);
    const result = await service.transferInventory(context, transferInput);
    expect(result.source.inventoryLocationId).toBe(ids.locationActive);
    expect(result.destination.inventoryLocationId).toBe(ids.locationDestination);
    expect(repo.lastCall().method).toBe("recordTransfer");
  });

  it("allows when two assignments each carry the permission and cover one location", async () => {
    const { service } = build();
    const context = contextWith([
      grant([InventoryPermission.transfer], [location(ids.locationActive)], {
        assignmentId: "b2000000-0000-4000-8000-000000000001",
      }),
      grant([InventoryPermission.transfer], [location(ids.locationDestination)], {
        assignmentId: "b2000000-0000-4000-8000-000000000002",
      }),
    ]);
    const result = await service.transferInventory(context, transferInput);
    expect(result.operationId).toBeTruthy();
  });

  it("rejects an identical source and destination before any privileged access", async () => {
    const { service, repo } = build();
    await expectInventoryError(
      service.transferInventory(tenantWideContext(), {
        ...transferInput,
        destinationInventoryLocationId: ids.locationActive,
      }),
      "SAME_TRANSFER_LOCATION",
    );
    expect(repo.calls).toHaveLength(0);
  });
});

describe("InventoryService actor + idempotency derivation", () => {
  it("derives the actor Membership from context, never from input", async () => {
    const { service, repo } = build();
    await service.setOpeningStock(tenantWideContext(), {
      variantId: ids.variantActive,
      inventoryLocationId: ids.locationActive,
      quantity: 10,
      idempotencyKey: "open-1",
    });
    expect(repo.lastCall().command).toMatchObject({
      actorMembershipId: ids.membership,
      idempotencyKey: "open-1",
      quantity: 10,
    });
  });

  it("rejects an attempt to smuggle actorMembershipId through input", async () => {
    const { service } = build();
    await expectInventoryError(
      service.setOpeningStock(tenantWideContext(), {
        variantId: ids.variantActive,
        inventoryLocationId: ids.locationActive,
        quantity: 10,
        idempotencyKey: "open-1",
        actorMembershipId: "99999999-0000-4000-8000-000000000000",
      } as never),
      "INVALID_QUANTITY",
    );
  });

  it("requires an idempotency key for mutations", async () => {
    const { service } = build();
    await expectInventoryError(
      service.receiveInventory(tenantWideContext(), {
        variantId: ids.variantActive,
        inventoryLocationId: ids.locationActive,
        quantity: 5,
      } as never),
      "INVALID_QUANTITY",
    );
  });
});

describe("InventoryService opening stock", () => {
  const base = {
    variantId: ids.variantActive,
    inventoryLocationId: ids.locationActive,
    quantity: 10,
    idempotencyKey: "open-1",
  };

  it("records an opening for an active variant at an active location", async () => {
    const { service, repo } = build();
    const result = await service.setOpeningStock(tenantWideContext(), base);
    expect(result.newOnHand).toBe(10);
    expect(repo.lastCall().method).toBe("recordOpening");
  });

  it("rejects a draft variant", async () => {
    const { service, repo } = build();
    await expectInventoryError(
      service.setOpeningStock(tenantWideContext(), { ...base, variantId: ids.variantDraft }),
      "VARIANT_INACTIVE",
    );
    expect(repo.calls).toHaveLength(0);
  });

  it("rejects an archived variant", async () => {
    const { service } = build();
    await expectInventoryError(
      service.setOpeningStock(tenantWideContext(), { ...base, variantId: ids.variantArchived }),
      "VARIANT_INACTIVE",
    );
  });

  it("rejects a missing variant", async () => {
    const { service } = build();
    await expectInventoryError(
      service.setOpeningStock(tenantWideContext(), { ...base, variantId: ids.variantMissing }),
      "VARIANT_NOT_FOUND",
    );
  });

  it("rejects an inactive location", async () => {
    const { service } = build();
    await expectInventoryError(
      service.setOpeningStock(tenantWideContext(), {
        ...base,
        inventoryLocationId: ids.locationInactive,
      }),
      "LOCATION_INACTIVE",
    );
  });

  it("rejects a non-positive opening quantity", async () => {
    const { service } = build();
    await expectInventoryError(
      service.setOpeningStock(tenantWideContext(), { ...base, quantity: 0 }),
      "INVALID_QUANTITY",
    );
  });
});

describe("InventoryService count adjustment", () => {
  const base = {
    variantId: ids.variantActive,
    inventoryLocationId: ids.locationActive,
    countedQuantity: 12,
    expectedVersion: 1,
    idempotencyKey: "adj-1",
  };

  it("forwards counted quantity and expected version", async () => {
    const { service, repo } = build();
    repo.balances.set(`${ids.variantActive}:${ids.locationActive}`, { onHand: 15, version: 1 });
    const result = await service.adjustInventory(tenantWideContext(), base);
    expect(repo.lastCall().command).toMatchObject({ countedQuantity: 12, expectedVersion: 1 });
    expect(result.changed).toBe(true);
    expect(result.newOnHand).toBe(12);
  });

  it("reports a durable no-op (operation persisted, unchanged) when the count already matches", async () => {
    const { service, repo } = build();
    repo.balances.set(`${ids.variantActive}:${ids.locationActive}`, { onHand: 12, version: 1 });
    const result = await service.adjustInventory(tenantWideContext(), base);
    // A no-op still persists an operation envelope, so operationId is present; nothing changed.
    expect(result).toMatchObject({ changed: false, previousOnHand: 12, newOnHand: 12, version: 1 });
    expect(result.operationId).toBeTruthy();
  });

  it("allows reconciliation on an inactive location", async () => {
    const { service, repo } = build();
    const result = await service.adjustInventory(tenantWideContext(), {
      ...base,
      inventoryLocationId: ids.locationInactive,
    });
    expect(result.changed).toBe(true);
    expect(repo.lastCall().method).toBe("recordCountAdjustment");
  });

  it("rejects an archived location", async () => {
    const { service } = build();
    await expectInventoryError(
      service.adjustInventory(tenantWideContext(), {
        ...base,
        inventoryLocationId: ids.locationArchived,
      }),
      "LOCATION_INACTIVE",
    );
  });

  it("rejects a negative counted quantity", async () => {
    const { service } = build();
    await expectInventoryError(
      service.adjustInventory(tenantWideContext(), { ...base, countedQuantity: -1 }),
      "INVALID_QUANTITY",
    );
  });

  it("does not accept a raw signed delta field", async () => {
    const { service } = build();
    await expectInventoryError(
      service.adjustInventory(tenantWideContext(), { ...base, quantityDelta: -3 } as never),
      "INVALID_QUANTITY",
    );
  });
});

describe("InventoryService receive", () => {
  const base = {
    variantId: ids.variantActive,
    inventoryLocationId: ids.locationActive,
    quantity: 7,
    idempotencyKey: "rcv-1",
  };

  it("records a positive receipt and returns observed state", async () => {
    const { service, repo } = build();
    const result = await service.receiveInventory(tenantWideContext(), base);
    expect(result).toMatchObject({ changed: true, observedOnHand: 7 });
    expect(result).not.toHaveProperty("newOnHand");
    expect(result).not.toHaveProperty("previousOnHand");
    expect(repo.lastCall()).toMatchObject({ method: "recordReceipt", command: { quantity: 7 } });
  });

  it("denies a location without receiving capability", async () => {
    const repo = new FakeInventoryRepository().seedDefaults();
    repo.locationStates.set(ids.locationActive, {
      status: "active",
      isReceivingEnabled: false,
      isTransferOriginEnabled: true,
      isTransferDestinationEnabled: true,
    });
    const authService = new AuthorizationService(
      new StubResourceRepository(defaultResourceTenantMap()),
    );
    const service = new InventoryService(authService, repo);
    await expectInventoryError(
      service.receiveInventory(tenantWideContext(), base),
      "LOCATION_CAPABILITY_DENIED",
    );
  });

  it("rejects an inactive location", async () => {
    const { service } = build();
    await expectInventoryError(
      service.receiveInventory(tenantWideContext(), {
        ...base,
        inventoryLocationId: ids.locationInactive,
      }),
      "LOCATION_INACTIVE",
    );
  });

  it("rejects zero quantity before any repository call", async () => {
    const { service, repo } = build();
    await expectInventoryError(
      service.receiveInventory(tenantWideContext(), { ...base, quantity: 0 }),
      "INVALID_QUANTITY",
    );
    expect(repo.calls).toHaveLength(0);
  });
});

describe("InventoryService issue", () => {
  const base = {
    variantId: ids.variantActive,
    inventoryLocationId: ids.locationActive,
    quantity: 4,
    idempotencyKey: "iss-1",
  };

  it("maps a positive command to a stock exit and returns observed state", async () => {
    const { service, repo } = build();
    const result = await service.issueInventory(tenantWideContext(), base);
    expect(result).toMatchObject({ changed: true, observedOnHand: 0 });
    expect(result).not.toHaveProperty("newOnHand");
    expect(repo.lastCall()).toMatchObject({ method: "recordIssue", command: { quantity: 4 } });
  });

  it("rejects a draft variant", async () => {
    const { service } = build();
    await expectInventoryError(
      service.issueInventory(tenantWideContext(), { ...base, variantId: ids.variantDraft }),
      "VARIANT_INACTIVE",
    );
  });

  it("allows an archived variant to write off remaining stock", async () => {
    const { service, repo } = build();
    const result = await service.issueInventory(tenantWideContext(), {
      ...base,
      variantId: ids.variantArchived,
    });
    expect(result.operationId).toBeTruthy();
    expect(repo.lastCall().method).toBe("recordIssue");
  });

  it("allows issuing out of an inactive location (evacuation)", async () => {
    const { service, repo } = build();
    await service.issueInventory(tenantWideContext(), {
      ...base,
      inventoryLocationId: ids.locationInactive,
    });
    expect(repo.lastCall().method).toBe("recordIssue");
  });

  it("rejects an archived location", async () => {
    const { service } = build();
    await expectInventoryError(
      service.issueInventory(tenantWideContext(), {
        ...base,
        inventoryLocationId: ids.locationArchived,
      }),
      "LOCATION_INACTIVE",
    );
  });

  it("propagates a repository InventoryError (insufficient stock) unchanged", async () => {
    const { service, repo } = build();
    repo.failWith = new InventoryError("INSUFFICIENT_STOCK");
    await expectInventoryError(
      service.issueInventory(tenantWideContext(), base),
      "INSUFFICIENT_STOCK",
    );
  });
});

describe("InventoryService transfer construction and lifecycle", () => {
  const base = {
    variantId: ids.variantActive,
    sourceInventoryLocationId: ids.locationActive,
    destinationInventoryLocationId: ids.locationDestination,
    quantity: 6,
    idempotencyKey: "t-1",
  };

  it("builds one transfer command with source and destination", async () => {
    const { service, repo } = build();
    await service.transferInventory(tenantWideContext(), base);
    expect(repo.lastCall()).toMatchObject({
      method: "recordTransfer",
      command: {
        sourceInventoryLocationId: ids.locationActive,
        destinationInventoryLocationId: ids.locationDestination,
        quantity: 6,
      },
    });
  });

  it("allows an inactive source for evacuation", async () => {
    const { service, repo } = build();
    await service.transferInventory(tenantWideContext(), {
      ...base,
      sourceInventoryLocationId: ids.locationInactive,
    });
    expect(repo.lastCall().method).toBe("recordTransfer");
  });

  it("rejects an archived source", async () => {
    const { service } = build();
    await expectInventoryError(
      service.transferInventory(tenantWideContext(), {
        ...base,
        sourceInventoryLocationId: ids.locationArchived,
      }),
      "LOCATION_INACTIVE",
    );
  });

  it("rejects an inactive destination", async () => {
    const { service } = build();
    await expectInventoryError(
      service.transferInventory(tenantWideContext(), {
        ...base,
        destinationInventoryLocationId: ids.locationInactive,
      }),
      "LOCATION_INACTIVE",
    );
  });

  it("denies when the source cannot originate transfers", async () => {
    const repo = new FakeInventoryRepository().seedDefaults();
    repo.locationStates.set(ids.locationActive, {
      status: "active",
      isReceivingEnabled: true,
      isTransferOriginEnabled: false,
      isTransferDestinationEnabled: true,
    });
    const authService = new AuthorizationService(
      new StubResourceRepository(defaultResourceTenantMap()),
    );
    const service = new InventoryService(authService, repo);
    await expectInventoryError(
      service.transferInventory(tenantWideContext(), base),
      "LOCATION_CAPABILITY_DENIED",
    );
  });

  it("denies when the destination cannot receive transfers", async () => {
    const repo = new FakeInventoryRepository().seedDefaults();
    repo.locationStates.set(ids.locationDestination, {
      status: "active",
      isReceivingEnabled: true,
      isTransferOriginEnabled: true,
      isTransferDestinationEnabled: false,
    });
    const authService = new AuthorizationService(
      new StubResourceRepository(defaultResourceTenantMap()),
    );
    const service = new InventoryService(authService, repo);
    await expectInventoryError(
      service.transferInventory(tenantWideContext(), base),
      "LOCATION_CAPABILITY_DENIED",
    );
  });
});
