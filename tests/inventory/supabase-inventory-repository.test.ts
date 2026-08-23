import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthorizationService, type AuthorizedOperationContext } from "../../src/authorization";
import { SupabaseInventoryRepository } from "../../src/inventory/supabase-inventory-repository";
import {
  contextWith,
  defaultResourceTenantMap,
  grant,
  ids,
  location,
  StubResourceRepository,
} from "./fakes";

interface RpcCall {
  readonly fn: string;
  readonly params: Record<string, unknown>;
}

interface StubHandlers {
  rpcResult: { data: unknown; error: { code?: string } | null };
  selectResult: { data: unknown; error: { code?: string } | null };
  rpcCalls: RpcCall[];
}

function stubClient(handlers: StubHandlers): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    limit: async () => handlers.selectResult,
  };
  return {
    from: () => builder,
    schema: () => ({
      rpc: async (fn: string, params: Record<string, unknown>) => {
        handlers.rpcCalls.push({ fn, params });
        return handlers.rpcResult;
      },
    }),
  } as unknown as SupabaseClient;
}

async function issueProof(): Promise<AuthorizedOperationContext> {
  const authService = new AuthorizationService(
    new StubResourceRepository(defaultResourceTenantMap()),
  );
  return authService.authorize(
    contextWith([
      grant(["inventory.receive", "inventory.issue", "inventory.transfer", "inventory.read"]),
    ]),
    { permissionKey: "inventory.receive", resources: [location(ids.locationActive)] },
  );
}

let handlers: StubHandlers;
let proof: AuthorizedOperationContext;

beforeEach(async () => {
  handlers = {
    rpcResult: { data: null, error: null },
    selectResult: { data: [], error: null },
    rpcCalls: [],
  };
  proof = await issueProof();
});

const openingCommand = {
  tenantId: ids.tenant,
  variantId: ids.variantActive,
  inventoryLocationId: ids.locationActive,
  quantity: 5,
  actorMembershipId: ids.membership,
  idempotencyKey: "k",
};

describe("SupabaseInventoryRepository error mapping", () => {
  const cases: Array<[string, string]> = [
    ["IN001", "OPENING_STOCK_ALREADY_EXISTS"],
    ["IN002", "CONCURRENT_MODIFICATION"],
    ["ID409", "IDEMPOTENCY_CONFLICT"],
    ["23514", "INSUFFICIENT_STOCK"],
    ["23503", "TENANT_MISMATCH"],
    ["22023", "INVALID_QUANTITY"],
  ];

  for (const [sqlstate, code] of cases) {
    it(`maps ${sqlstate} to ${code}`, async () => {
      handlers.rpcResult = { data: null, error: { code: sqlstate } };
      const repo = new SupabaseInventoryRepository(stubClient(handlers));
      await expect(repo.recordOpening(proof, openingCommand)).rejects.toMatchObject({
        name: "InventoryError",
        code,
      });
    });
  }

  it("maps an unexpected privilege failure (42501) to a generic, non-inventory error", async () => {
    handlers.rpcResult = { data: null, error: { code: "42501" } };
    const repo = new SupabaseInventoryRepository(stubClient(handlers));
    await expect(repo.recordOpening(proof, openingCommand)).rejects.not.toMatchObject({
      name: "InventoryError",
    });
  });
});

describe("SupabaseInventoryRepository safe-integer boundary", () => {
  // A balance beyond Number.MAX_SAFE_INTEGER (9007199254740991) is a numeric transport/invariant
  // failure, not a business condition. It must surface as a generic internal error, never as a domain
  // error such as TENANT_MISMATCH that would masquerade as a missing/cross-tenant resource.
  const key = {
    tenantId: ids.tenant,
    variantId: ids.variantActive,
    inventoryLocationId: ids.locationActive,
  };

  it("rejects an out-of-safe-range on-hand with an internal error, not TENANT_MISMATCH", async () => {
    handlers.selectResult = {
      data: [{ on_hand_quantity: "9007199254740993", version: 1 }],
      error: null,
    };
    const repo = new SupabaseInventoryRepository(stubClient(handlers));
    const rejection = repo.getBalance(proof, key);
    await expect(rejection).rejects.not.toMatchObject({ name: "InventoryError" });
    await expect(rejection).rejects.toThrow(/supported application range/i);
  });

  it("rejects an out-of-safe-range version with an internal error, not TENANT_MISMATCH", async () => {
    handlers.selectResult = {
      data: [{ on_hand_quantity: 1, version: "9007199254740993" }],
      error: null,
    };
    const repo = new SupabaseInventoryRepository(stubClient(handlers));
    await expect(repo.getBalance(proof, key)).rejects.not.toMatchObject({ name: "InventoryError" });
  });
});

describe("SupabaseInventoryRepository ledger translation", () => {
  it("builds a negative movement for an issue and echoes the resulting balance", async () => {
    handlers.rpcResult = { data: "a0000000-0000-4000-8000-000000000001", error: null };
    handlers.selectResult = { data: [{ on_hand_quantity: 3, version: 4 }], error: null };
    const repo = new SupabaseInventoryRepository(stubClient(handlers));

    const result = await repo.recordIssue(proof, { ...openingCommand, quantity: 2 });

    const call = handlers.rpcCalls.find((c) => c.fn === "record_operation");
    expect(call?.params.p_operation_type).toBe("issue");
    expect(call?.params.p_movements).toEqual([
      {
        variant_id: ids.variantActive,
        inventory_location_id: ids.locationActive,
        quantity_delta: -2,
      },
    ]);
    // The result reports the observed post-commit balance, never a reconstructed before/after snapshot.
    expect(result).toMatchObject({ observedOnHand: 3, observedVersion: 4, changed: true });
    expect(result).not.toHaveProperty("previousOnHand");
    expect(result).not.toHaveProperty("newOnHand");
  });

  it("builds a positive movement for a receipt", async () => {
    handlers.rpcResult = { data: "a0000000-0000-4000-8000-000000000002", error: null };
    handlers.selectResult = { data: [{ on_hand_quantity: 9, version: 1 }], error: null };
    const repo = new SupabaseInventoryRepository(stubClient(handlers));

    await repo.recordReceipt(proof, { ...openingCommand, quantity: 9 });

    const call = handlers.rpcCalls.find((c) => c.fn === "record_operation");
    expect(call?.params.p_movements).toEqual([
      {
        variant_id: ids.variantActive,
        inventory_location_id: ids.locationActive,
        quantity_delta: 9,
      },
    ]);
  });

  it("builds one zero-sum two-line movement for a transfer", async () => {
    handlers.rpcResult = { data: "a0000000-0000-4000-8000-000000000003", error: null };
    handlers.selectResult = { data: [{ on_hand_quantity: 0, version: 2 }], error: null };
    const repo = new SupabaseInventoryRepository(stubClient(handlers));

    await repo.recordTransfer(proof, {
      tenantId: ids.tenant,
      variantId: ids.variantActive,
      sourceInventoryLocationId: ids.locationActive,
      destinationInventoryLocationId: ids.locationDestination,
      quantity: 4,
      actorMembershipId: ids.membership,
      idempotencyKey: "t",
    });

    const call = handlers.rpcCalls.find((c) => c.fn === "record_operation");
    const movements = call?.params.p_movements as Array<{ quantity_delta: number }>;
    expect(call?.params.p_operation_type).toBe("transfer");
    expect(movements).toHaveLength(2);
    expect(movements[0].quantity_delta + movements[1].quantity_delta).toBe(0);
  });

  it("parses a single-key function result including previous on-hand", async () => {
    handlers.rpcResult = {
      data: [
        {
          operation_id: "a0000000-0000-4000-8000-000000000004",
          previous_on_hand: 0,
          on_hand: 5,
          version: 1,
        },
      ],
      error: null,
    };
    const repo = new SupabaseInventoryRepository(stubClient(handlers));
    const result = await repo.recordOpening(proof, openingCommand);
    expect(result).toMatchObject({ previousOnHand: 0, newOnHand: 5, version: 1, changed: true });
  });

  it("returns exists=false with zero on-hand when no balance row exists", async () => {
    handlers.selectResult = { data: [], error: null };
    const repo = new SupabaseInventoryRepository(stubClient(handlers));
    const balance = await repo.getBalance(proof, {
      tenantId: ids.tenant,
      variantId: ids.variantActive,
      inventoryLocationId: ids.locationActive,
    });
    expect(balance).toMatchObject({ onHand: 0, version: 0, exists: false });
  });
});
