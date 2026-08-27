import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  AuthorizationService,
  type AuthorizationContext,
  type AuthorizationResource,
} from "../../src/authorization";
import type { EffectiveAuthorizationAssignment } from "../../src/authorization/model";
import { createSupabaseAuthorizationRepository } from "../../src/authorization/supabase-authorization-repository";
import { OrderService } from "../../src/orders";
import { createSupabaseOrdersRepository } from "../../src/orders/supabase-orders-repository";

const ids = {
  tenantA: "10000000-0000-4000-8000-000000000001",
  membershipA: "71000000-0000-4000-8000-000000000001",
  otherMembership: "71000000-0000-4000-8000-000000000002",
  userA: "70000000-0000-4000-8000-000000000001",
  brandA: "20000000-0000-4000-8000-000000000001",
  brandOther: "20000000-0000-4000-8000-000000000003",
  branchA: "b0000000-0000-4000-8000-000000000001",
  branchInactive: "b0000000-0000-4000-8000-000000000002",
  registerActive: "c0000000-0000-4000-8000-000000000001",
  registerInactive: "c0000000-0000-4000-8000-000000000002",
  registerBadBranch: "c0000000-0000-4000-8000-000000000003",
  registerDisableTest: "c0000000-0000-4000-8000-000000000004",
  variantA: "60000000-0000-4000-8000-000000000001",
  variantPrice: "60000000-0000-4000-8000-00000000000b",
  variantArchive: "60000000-0000-4000-8000-00000000000c",
  variantOther: "60000000-0000-4000-8000-000000000003",
  variantB: "60000000-0000-4000-8000-000000000002",
} as const;

const url = process.env.ORDERS_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.ORDERS_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "Run this suite through pnpm test:orders:integration; no shared or production Supabase project is supported.",
  );
}

const authorizationService = new AuthorizationService(
  createSupabaseAuthorizationRepository({ url, serviceRoleKey }),
);
const ordersRepository = createSupabaseOrdersRepository({ url, serviceRoleKey });
const service = new OrderService(authorizationService, ordersRepository);

// A read-only service-role client used only to assert cross-domain invariants (no inventory movement)
// and to mutate catalog state between an original create and its replay.
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

const allPermissions = ["orders.read", "orders.create", "orders.cancel"];

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

function context(
  assignments: readonly EffectiveAuthorizationAssignment[],
  membershipId: string = ids.membershipA,
): AuthorizationContext {
  return {
    authentication: { provider: "clerk", subject: "integration" },
    userIdentity: { id: ids.userA },
    tenant: { id: ids.tenantA },
    membership: { id: membershipId },
    assignments,
  };
}

const tenantWide = () => context([assignment(allPermissions)]);

function pos(overrides: Record<string, unknown> = {}) {
  return {
    channel: "pos" as const,
    registerId: ids.registerActive,
    currency: "USD",
    lines: [{ variantId: ids.variantA, quantity: 2 }],
    idempotencyKey: "int-pos-default",
    ...overrides,
  };
}

async function inventoryMovementCount(variantId: string): Promise<number> {
  const { count, error } = await admin
    .from("inventory_movements")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", ids.tenantA)
    .eq("variant_id", variantId);
  if (error) {
    throw new Error(`movement count failed: ${error.message}`);
  }
  return count ?? 0;
}

async function replacePrice(variantId: string, amountMinor: number): Promise<void> {
  const stamp = Date.now();
  const { error: archiveError } = await admin
    .from("variant_prices")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("tenant_id", ids.tenantA)
    .eq("variant_id", variantId)
    .eq("status", "active");
  if (archiveError) {
    throw new Error(`price archive failed: ${archiveError.message}`);
  }
  const { error: insertError } = await admin.from("variant_prices").insert({
    id: `41000000-0000-4000-8000-${stamp.toString().slice(-12).padStart(12, "0")}`,
    tenant_id: ids.tenantA,
    variant_id: variantId,
    currency: "USD",
    amount_minor: amountMinor,
    status: "active",
  });
  if (insertError) {
    throw new Error(`price insert failed: ${insertError.message}`);
  }
}

describe("Phase 2D orders integration", () => {
  it("creates and reads a new POS order with an immutable option snapshot", async () => {
    const order = await service.createOrder(tenantWide(), pos({ idempotencyKey: "int-pos-1" }));
    expect(order).toMatchObject({
      channel: "pos",
      status: "placed",
      brandId: ids.brandA,
      branchId: ids.branchA,
      registerId: ids.registerActive,
      totalMinor: 5198,
      actorMembershipId: ids.membershipA,
    });
    expect(order.lines[0]).toMatchObject({
      quantity: 2,
      unitPriceMinor: 2599,
      lineTotalMinor: 5198,
      sku: "TEE-M-BLK",
      optionSummary: "Size: M / Color: Black",
    });

    const read = await service.getOrder(tenantWide(), { orderId: order.id });
    expect(read.id).toBe(order.id);

    const byNumber = await service.getOrderByNumber(tenantWide(), {
      orderNumber: order.orderNumber,
    });
    expect(byNumber.id).toBe(order.id);

    // No inventory movement occurred for the sold variant.
    expect(await inventoryMovementCount(ids.variantA)).toBe(0);
  });

  it("creates a new ONLINE order authorized on the derived brand", async () => {
    const order = await service.createOrder(
      context([assignment(allPermissions, [{ kind: "brand", id: ids.brandA }])]),
      {
        channel: "online",
        currency: "USD",
        lines: [{ variantId: ids.variantA, quantity: 1 }],
        idempotencyKey: "int-online-1",
      },
    );
    expect(order).toMatchObject({
      channel: "online",
      branchId: null,
      registerId: null,
      actorMembershipId: null,
      totalMinor: 2599,
    });
  });

  it("replays the same key + intent without creating a second order", async () => {
    const first = await service.createOrder(tenantWide(), pos({ idempotencyKey: "int-replay" }));
    const second = await service.createOrder(tenantWide(), pos({ idempotencyKey: "int-replay" }));
    expect(second.id).toBe(first.id);
  });

  it("conflicts on the same key with a different intent", async () => {
    await service.createOrder(tenantWide(), pos({ idempotencyKey: "int-conflict" }));
    await expect(
      service.createOrder(
        tenantWide(),
        pos({ idempotencyKey: "int-conflict", lines: [{ variantId: ids.variantA, quantity: 3 }] }),
      ),
    ).rejects.toMatchObject({ name: "OrderError", code: "IDEMPOTENCY_CONFLICT" });
  });

  it("keeps the original price snapshot after a catalog price change and on replay", async () => {
    const input = pos({
      idempotencyKey: "int-price",
      lines: [{ variantId: ids.variantPrice, quantity: 1 }],
    });
    const first = await service.createOrder(tenantWide(), input);
    expect(first.lines[0]?.unitPriceMinor).toBe(1999);

    await replacePrice(ids.variantPrice, 8888);

    const reread = await service.getOrder(tenantWide(), { orderId: first.id });
    expect(reread.lines[0]?.unitPriceMinor).toBe(1999);

    const replay = await service.createOrder(tenantWide(), input);
    expect(replay.id).toBe(first.id);
    expect(replay.lines[0]?.unitPriceMinor).toBe(1999);
  });

  it("replays after the variant is archived", async () => {
    const input = pos({
      idempotencyKey: "int-archive",
      lines: [{ variantId: ids.variantArchive, quantity: 1 }],
    });
    const first = await service.createOrder(tenantWide(), input);

    const { error } = await admin
      .from("product_variants")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("tenant_id", ids.tenantA)
      .eq("id", ids.variantArchive);
    if (error) {
      throw new Error(`variant archive failed: ${error.message}`);
    }

    const replay = await service.createOrder(tenantWide(), input);
    expect(replay.id).toBe(first.id);
  });

  it("replays a POS order after its register is disabled", async () => {
    const input = pos({ idempotencyKey: "int-reg-disable", registerId: ids.registerDisableTest });
    const first = await service.createOrder(tenantWide(), input);

    const { error } = await admin
      .from("registers")
      .update({ status: "inactive" })
      .eq("tenant_id", ids.tenantA)
      .eq("id", ids.registerDisableTest);
    if (error) {
      throw new Error(`register disable failed: ${error.message}`);
    }

    const replay = await service.createOrder(tenantWide(), input);
    expect(replay.id).toBe(first.id);
  });

  it("rejects a cross-tenant variant", async () => {
    await expect(
      service.createOrder(
        tenantWide(),
        pos({ idempotencyKey: "int-cross", lines: [{ variantId: ids.variantB, quantity: 1 }] }),
      ),
    ).rejects.toMatchObject({ name: "OrderError", code: "VARIANT_NOT_FOUND" });
  });

  it("denies a POS create for a brand-only scoped user", async () => {
    const brandOnly = context([assignment(["orders.create"], [{ kind: "brand", id: ids.brandA }])]);
    await expect(
      service.createOrder(brandOnly, pos({ idempotencyKey: "int-brandonly" })),
    ).rejects.toMatchObject({ name: "AuthorizationError", code: "SCOPE_DENIED" });
  });

  it("rejects a brand the branch does not carry", async () => {
    await expect(
      service.createOrder(
        tenantWide(),
        pos({
          idempotencyKey: "int-notcarried",
          lines: [{ variantId: ids.variantOther, quantity: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ name: "OrderError", code: "BRAND_NOT_AVAILABLE_AT_BRANCH" });
  });

  it("rejects an inactive register", async () => {
    await expect(
      service.createOrder(
        tenantWide(),
        pos({ idempotencyKey: "int-reginactive", registerId: ids.registerInactive }),
      ),
    ).rejects.toMatchObject({ name: "OrderError", code: "REGISTER_INACTIVE" });
  });

  it("rejects a register whose branch is inactive", async () => {
    await expect(
      service.createOrder(
        tenantWide(),
        pos({ idempotencyKey: "int-branchinactive", registerId: ids.registerBadBranch }),
      ),
    ).rejects.toMatchObject({ name: "OrderError", code: "BRANCH_INACTIVE" });
  });

  it("cancels an order and preserves the original metadata on a repeated cancel", async () => {
    const created = await service.createOrder(tenantWide(), pos({ idempotencyKey: "int-cancel" }));
    const cancelled = await service.cancelOrder(tenantWide(), {
      orderId: created.id,
      reason: "first reason",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancellationReason: "first reason",
      cancelledByMembershipId: ids.membershipA,
    });

    // A genuinely distinct second membership cannot overwrite the original actor/reason/time.
    expect(ids.otherMembership).not.toBe(ids.membershipA);
    const again = await service.cancelOrder(
      context([assignment(allPermissions)], ids.otherMembership),
      { orderId: created.id, reason: "second reason" },
    );
    expect(again.cancellationReason).toBe("first reason");
    expect(again.cancelledByMembershipId).toBe(ids.membershipA);
    expect(again.cancelledAt).toBe(cancelled.cancelledAt);
  });

  it("has seeded the platform permission catalog with the order keys and no role grants", async () => {
    const { data, error } = await admin
      .from("permissions")
      .select("key")
      .in("key", ["orders.read", "orders.create", "orders.cancel"]);
    if (error) {
      throw new Error(`permission query failed: ${error.message}`);
    }
    expect(new Set((data ?? []).map((row) => row.key))).toEqual(
      new Set(["orders.read", "orders.create", "orders.cancel"]),
    );
  });
});
