import { describe, expect, it } from "vitest";

import { AuthorizationService, type AuthorizedOperationContext } from "../../src/authorization";
import type {
  ChannelStockMode,
  InventoryChannelBalance,
} from "../../src/contracts/management/inventory-channels";
import {
  InventoryChannelService,
  type ChannelAllocationLineCommand,
  type InventoryChannelRepository,
} from "../../src/inventory/channel-service";
import { InventoryPermission } from "../../src/inventory";
import { contextWith, defaultResourceTenantMap, grant, ids, StubResourceRepository } from "./fakes";

const otherVariant = "77777777-0000-4000-8000-000000000099";

function balance(variantId: string, overrides: Partial<InventoryChannelBalance> = {}) {
  return {
    variantId,
    canonicalOnHand: 9,
    websiteOnHand: 4,
    websiteReserved: 0,
    websiteAvailable: 4,
    posOnHand: 5,
    posReserved: 0,
    posAvailable: 5,
    unallocatedOnHand: 0,
    mismatch: 0,
    explicitlyAllocated: true,
    balanceVersion: 2,
    allocationVersion: 0,
    ...overrides,
  } satisfies InventoryChannelBalance;
}

class FakeChannelRepository implements InventoryChannelRepository {
  mode: ChannelStockMode | null = "legacy";
  initialized = false;
  calls: string[] = [];
  lastAllocation: {
    tenantId: string;
    actorMembershipId: string;
    lines: readonly ChannelAllocationLineCommand[];
  } | null = null;

  async getMode() {
    return this.mode;
  }
  async listBalances() {
    this.calls.push("list");
    return [balance(ids.variantActive), balance(otherVariant)];
  }
  async initialize() {
    this.calls.push("initialize");
    if (this.initialized) return null;
    this.initialized = true;
    this.mode = "shadow";
    return "aaaaaaaa-0000-4000-8000-000000000001";
  }
  async allocate(
    proof: AuthorizedOperationContext,
    command: {
      tenantId: string;
      actorMembershipId: string;
      lines: readonly ChannelAllocationLineCommand[];
    },
  ) {
    expect(proof).toBeDefined();
    this.calls.push("allocate");
    this.lastAllocation = command;
    return "bbbbbbbb-0000-4000-8000-000000000001";
  }
}

function build() {
  const repo = new FakeChannelRepository();
  const service = new InventoryChannelService(
    new AuthorizationService(new StubResourceRepository(defaultResourceTenantMap())),
    repo,
  );
  return { service, repo };
}

const readContext = () => contextWith([grant([InventoryPermission.read])]);
const adjustContext = () =>
  contextWith([grant([InventoryPermission.read, InventoryPermission.adjust])]);

// ADR-042 §13 (owner decision 2026-11-14 night): there is no Website/POS split. The service keeps its
// authorization boundary but refuses every channel operation with CHANNEL_STOCK_SUPERSEDED before any
// repository call, so no code path can read, initialise or allocate channel buckets.
describe("InventoryChannelService (superseded by ADR-042 §13)", () => {
  it("refuses the channel read without touching the repository", async () => {
    const { service, repo } = build();
    repo.mode = "shadow";
    await expect(
      service.getChannelState(readContext(), { inventoryLocationId: ids.locationActive }),
    ).rejects.toMatchObject({ name: "InventoryError", code: "CHANNEL_STOCK_SUPERSEDED" });
    expect(repo.calls).toEqual([]);
  });

  it("refuses initialisation and allocation before any DB write", async () => {
    const { service, repo } = build();
    await expect(
      service.initializeChannels(adjustContext(), { inventoryLocationId: ids.locationActive }),
    ).rejects.toMatchObject({ code: "CHANNEL_STOCK_SUPERSEDED" });
    await expect(
      service.allocateChannels(adjustContext(), {
        inventoryLocationId: ids.locationActive,
        reason: "split",
        idempotencyKey: "k-1",
        lines: [
          {
            variantId: ids.variantActive,
            websiteQuantity: 1,
            posQuantity: 1,
            expectedBalanceVersion: 1,
            expectedAllocationVersion: 0,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "CHANNEL_STOCK_SUPERSEDED" });
    expect(repo.calls).toEqual([]);
    expect(repo.lastAllocation).toBeNull();
    expect(repo.initialized).toBe(false);
  });

  it("still denies callers without inventory permissions (authorization runs first)", async () => {
    const { service } = build();
    await expect(
      service.getChannelState(contextWith([grant([InventoryPermission.adjust])]), {
        inventoryLocationId: ids.locationActive,
      }),
    ).rejects.toMatchObject({ name: "AuthorizationError", code: "PERMISSION_DENIED" });
    await expect(
      service.initializeChannels(readContext(), { inventoryLocationId: ids.locationActive }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
