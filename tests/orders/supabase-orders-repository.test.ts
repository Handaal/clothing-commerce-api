import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthorizationService, type AuthorizedOperationContext } from "../../src/authorization";
import { SupabaseOrdersRepository } from "../../src/orders/supabase-orders-repository";
import type { CreateOrderCommand } from "../../src/orders/repository";
import { contextWith, defaultResourceTenantMap, grant, ids, StubResourceRepository } from "./fakes";

interface RpcCall {
  readonly fn: string;
  readonly params: Record<string, unknown>;
}

interface StubHandlers {
  rpcResult: { data: unknown; error: { code?: string } | null };
  fromResults: Record<string, { data: unknown; error: { code?: string } | null }>;
  rpcCalls: RpcCall[];
}

function stubClient(handlers: StubHandlers): SupabaseClient {
  const makeBuilder = (table: string) => {
    const result = () => handlers.fromResults[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      order: () => Promise.resolve(result()),
      limit: () => Promise.resolve(result()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR),
    };
    return builder;
  };
  return {
    from: (table: string) => makeBuilder(table),
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
  return authService.authorize(contextWith([grant(["orders.create"])]), {
    permissionKey: "orders.create",
  });
}

const createCommand: CreateOrderCommand = {
  tenantId: ids.tenant,
  channel: "pos",
  currency: "USD",
  brandId: ids.brand,
  branchId: ids.branch,
  registerId: ids.register,
  actorMembershipId: ids.membership,
  idempotencyKey: "k1",
  lines: [
    {
      variantId: ids.variantA,
      productId: ids.productA,
      quantity: 2,
      unitPriceMinor: 2599,
      productName: "Classic Tee",
      variantName: "Classic Tee - M",
      sku: "TEE-M-BLK",
      optionSummary: "Size: M",
    },
  ],
};

let handlers: StubHandlers;
let proof: AuthorizedOperationContext;

beforeEach(async () => {
  handlers = { rpcResult: { data: null, error: null }, fromResults: {}, rpcCalls: [] };
  proof = await issueProof();
});

describe("SupabaseOrdersRepository error mapping", () => {
  const cases: Array<[string, string]> = [
    ["ID409", "IDEMPOTENCY_CONFLICT"],
    ["23514", "INVALID_ORDER"],
    ["23503", "TENANT_MISMATCH"],
    ["22003", "AMOUNT_OUT_OF_RANGE"],
    ["22023", "INVALID_ORDER"],
  ];

  for (const [sqlstate, code] of cases) {
    it(`maps ${sqlstate} to ${code}`, async () => {
      handlers.rpcResult = { data: null, error: { code: sqlstate } };
      const repo = new SupabaseOrdersRepository(stubClient(handlers));
      await expect(repo.createOrder(proof, createCommand)).rejects.toMatchObject({
        name: "OrderError",
        code,
      });
    });
  }

  it("maps an unexpected privilege failure (42501) to a generic, non-order error", async () => {
    handlers.rpcResult = { data: null, error: { code: "42501" } };
    const repo = new SupabaseOrdersRepository(stubClient(handlers));
    await expect(repo.createOrder(proof, createCommand)).rejects.not.toMatchObject({
      name: "OrderError",
    });
  });
});

describe("SupabaseOrdersRepository create_order payload", () => {
  it("passes server-resolved snapshots and a null placed_at (server time)", async () => {
    handlers.rpcResult = { data: "d0000000-0000-4000-8000-000000000001", error: null };
    const repo = new SupabaseOrdersRepository(stubClient(handlers));
    const id = await repo.createOrder(proof, createCommand);
    expect(id).toBe("d0000000-0000-4000-8000-000000000001");

    const call = handlers.rpcCalls.find((c) => c.fn === "create_order");
    expect(call?.params.p_channel).toBe("pos");
    expect(call?.params.p_placed_at).toBeNull();
    expect(call?.params.p_actor_membership_id).toBe(ids.membership);
    expect(call?.params.p_lines).toEqual([
      {
        variant_id: ids.variantA,
        product_id: ids.productA,
        quantity: 2,
        unit_price_minor: 2599,
        product_name: "Classic Tee",
        variant_name: "Classic Tee - M",
        sku: "TEE-M-BLK",
        option_summary: "Size: M",
      },
    ]);
  });
});

describe("SupabaseOrdersRepository replay preflight", () => {
  it("returns none when the preflight yields no rows", async () => {
    handlers.rpcResult = { data: [], error: null };
    const repo = new SupabaseOrdersRepository(stubClient(handlers));
    const result = await repo.resolveIdempotentReplayTarget(ids.tenant, "k", {
      channel: "pos",
      currency: "USD",
      registerId: ids.register,
      lines: [{ variantId: ids.variantA, quantity: 1 }],
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("returns conflict without identifiers when the fingerprint does not match", async () => {
    handlers.rpcResult = {
      data: [
        {
          fingerprint_matches: false,
          order_id: null,
          channel: null,
          brand_id: null,
          branch_id: null,
        },
      ],
      error: null,
    };
    const repo = new SupabaseOrdersRepository(stubClient(handlers));
    const result = await repo.resolveIdempotentReplayTarget(ids.tenant, "k", {
      channel: "pos",
      currency: "USD",
      registerId: ids.register,
      lines: [{ variantId: ids.variantA, quantity: 1 }],
    });
    expect(result).toEqual({ kind: "conflict" });
  });

  it("returns replay routing when the fingerprint matches", async () => {
    handlers.rpcResult = {
      data: [
        {
          fingerprint_matches: true,
          order_id: "d0000000-0000-4000-8000-000000000009",
          channel: "pos",
          brand_id: ids.brand,
          branch_id: ids.branch,
        },
      ],
      error: null,
    };
    const repo = new SupabaseOrdersRepository(stubClient(handlers));
    const result = await repo.resolveIdempotentReplayTarget(ids.tenant, "k", {
      channel: "pos",
      currency: "USD",
      registerId: ids.register,
      lines: [{ variantId: ids.variantA, quantity: 1 }],
    });
    expect(result).toMatchObject({ kind: "replay", brandId: ids.brand, branchId: ids.branch });
  });
});

describe("SupabaseOrdersRepository safe-integer boundary", () => {
  it("rejects an out-of-safe-range order total with a generic internal error", async () => {
    handlers.fromResults.orders = {
      data: [
        {
          id: "d0000000-0000-4000-8000-000000000001",
          order_number: "1",
          channel: "pos",
          status: "placed",
          brand_id: ids.brand,
          branch_id: ids.branch,
          register_id: ids.register,
          currency: "USD",
          total_minor: "9007199254740993",
          actor_membership_id: ids.membership,
          placed_at: "2026-08-25T00:00:00Z",
          cancelled_at: null,
          cancelled_by_membership_id: null,
          cancellation_reason: null,
          notes: null,
          created_at: "2026-08-25T00:00:00Z",
          updated_at: "2026-08-25T00:00:00Z",
        },
      ],
      error: null,
    };
    handlers.fromResults.order_lines = { data: [], error: null };
    const repo = new SupabaseOrdersRepository(stubClient(handlers));
    const rejection = repo.getOrder(proof, ids.tenant, "d0000000-0000-4000-8000-000000000001");
    await expect(rejection).rejects.not.toMatchObject({ name: "OrderError" });
    await expect(rejection).rejects.toThrow(/supported application range/i);
  });
});

describe("SupabaseOrdersRepository proof enforcement", () => {
  it("rejects a forged proof on a commercial read", async () => {
    const repo = new SupabaseOrdersRepository(stubClient(handlers));
    const forged = { permissionKey: "orders.read" } as unknown as AuthorizedOperationContext;
    await expect(repo.getOrder(forged, ids.tenant, ids.variantA)).rejects.toMatchObject({
      name: "AuthorizationError",
      code: "AUTHORIZATION_PROOF_INVALID",
    });
  });
});
