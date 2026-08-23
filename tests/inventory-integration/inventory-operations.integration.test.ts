import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  AuthorizationService,
  type AuthorizationContext,
  type AuthorizationResource,
} from "../../src/authorization";
import type { EffectiveAuthorizationAssignment } from "../../src/authorization/model";
import { createSupabaseAuthorizationRepository } from "../../src/authorization/supabase-authorization-repository";
import { InventoryService } from "../../src/inventory";
import { createSupabaseInventoryRepository } from "../../src/inventory/supabase-inventory-repository";

const ids = {
  tenantA: "10000000-0000-4000-8000-000000000001",
  tenantB: "10000000-0000-4000-8000-000000000002",
  membershipA: "71000000-0000-4000-8000-000000000001",
  userA: "70000000-0000-4000-8000-000000000001",
  variantA: "60000000-0000-4000-8000-000000000001",
  // Each test uses a dedicated location so there is no cross-test state coupling.
  locationLifecycle: "50000000-0000-4000-8000-000000000001",
  locationSecondOpening: "50000000-0000-4000-8000-000000000002",
  locationReplay: "50000000-0000-4000-8000-000000000003",
  locationStaleCount: "50000000-0000-4000-8000-000000000004",
  locationNoop: "50000000-0000-4000-8000-000000000005",
  locationTransferSource: "50000000-0000-4000-8000-000000000006",
  locationTransferDestination: "50000000-0000-4000-8000-000000000007",
  locationTenantB: "50000000-0000-4000-8000-00000000000b",
} as const;

const url = process.env.INVENTORY_TEST_SUPABASE_URL;
const serviceRoleKey = process.env.INVENTORY_TEST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "Run this suite through pnpm test:inventory:operations:integration; no shared or production Supabase project is supported.",
  );
}

const authorizationRepository = createSupabaseAuthorizationRepository({ url, serviceRoleKey });
const authorizationService = new AuthorizationService(authorizationRepository);
const inventoryRepository = createSupabaseInventoryRepository({ url, serviceRoleKey });
const service = new InventoryService(authorizationService, inventoryRepository);

// A read-only service-role client used only to assert ledger cardinality (operations/movements) that
// the narrow application surface intentionally does not expose. service_role holds SELECT only.
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

async function operationCountForKey(key: string): Promise<number> {
  // The ledger stores a case-insensitive normalized key (lower(btrim(...))); match that here.
  const { count, error } = await admin
    .from("inventory_operations")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", ids.tenantA)
    .eq("normalized_idempotency_key", key.trim().toLowerCase());
  if (error) {
    throw new Error(`operation count query failed: ${error.message}`);
  }
  return count ?? 0;
}

async function movementCountForKey(variantId: string, locationId: string): Promise<number> {
  const { count, error } = await admin
    .from("inventory_movements")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", ids.tenantA)
    .eq("variant_id", variantId)
    .eq("inventory_location_id", locationId);
  if (error) {
    throw new Error(`movement count query failed: ${error.message}`);
  }
  return count ?? 0;
}

const allInventoryPermissions = [
  "inventory.read",
  "inventory.adjust",
  "inventory.receive",
  "inventory.issue",
  "inventory.transfer",
];

function assignment(
  permissionKeys: readonly string[],
  targets?: readonly AuthorizationResource[],
): EffectiveAuthorizationAssignment {
  return {
    assignmentId: "b2000000-0000-4000-8000-000000000001",
    roleId: "90000000-0000-4000-8000-000000000001",
    isProtectedRole: false,
    accessScopeId: "b0000000-0000-4000-8000-000000000001",
    scopeMode: targets ? "explicit" : "tenant",
    scopeTargets: targets ?? [],
    permissionKeys,
  };
}

function context(
  assignments: readonly EffectiveAuthorizationAssignment[],
  tenantId: string = ids.tenantA,
): AuthorizationContext {
  return {
    authentication: { provider: "clerk", subject: "integration" },
    userIdentity: { id: ids.userA },
    tenant: { id: tenantId },
    membership: { id: ids.membershipA },
    assignments,
  };
}

const tenantWide = () => context([assignment(allInventoryPermissions)]);

function location(id: string): AuthorizationResource {
  return { kind: "inventory_location", id };
}

describe("Phase 2C inventory operations integration", () => {
  it("opens, reads, adjusts, receives, and issues against the real ledger", async () => {
    const loc = ids.locationLifecycle;
    const opening = await service.setOpeningStock(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      quantity: 10,
      idempotencyKey: "int-open-1",
    });
    expect(opening).toMatchObject({ changed: true, previousOnHand: 0, newOnHand: 10, version: 1 });

    const balance = await service.getInventoryBalance(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
    });
    expect(balance).toMatchObject({ onHand: 10, version: 1, exists: true });

    const adjusted = await service.adjustInventory(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      countedQuantity: 12,
      expectedVersion: 1,
      idempotencyKey: "int-adj-1",
    });
    expect(adjusted).toMatchObject({
      changed: true,
      previousOnHand: 10,
      newOnHand: 12,
      version: 2,
    });

    const received = await service.receiveInventory(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      quantity: 3,
      idempotencyKey: "int-rcv-1",
    });
    // Receipt reports observed post-commit state, not an atomic before/after snapshot.
    expect(received).toMatchObject({ changed: true, observedOnHand: 15 });
    expect(received).not.toHaveProperty("newOnHand");

    const issued = await service.issueInventory(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      quantity: 5,
      idempotencyKey: "int-iss-1",
    });
    expect(issued).toMatchObject({ changed: true, observedOnHand: 10 });
  });

  it("rejects a second opening of an established key", async () => {
    const loc = ids.locationSecondOpening;
    await service.setOpeningStock(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      quantity: 4,
      idempotencyKey: "int-open-2a",
    });
    await expect(
      service.setOpeningStock(tenantWide(), {
        variantId: ids.variantA,
        inventoryLocationId: loc,
        quantity: 9,
        idempotencyKey: "int-open-2b",
      }),
    ).rejects.toMatchObject({ name: "InventoryError", code: "OPENING_STOCK_ALREADY_EXISTS" });
  });

  it("replays an idempotent opening to a single operation and movement", async () => {
    const loc = ids.locationReplay;
    const first = await service.setOpeningStock(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      quantity: 4,
      idempotencyKey: "int-replay-open",
    });
    const replay = await service.setOpeningStock(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      quantity: 4,
      idempotencyKey: "int-replay-open",
    });
    expect(replay.operationId).toBe(first.operationId);
    expect(await operationCountForKey("int-replay-open")).toBe(1);
    expect(await movementCountForKey(ids.variantA, loc)).toBe(1);
  });

  it("rejects a stale count with CONCURRENT_MODIFICATION and applies nothing", async () => {
    const loc = ids.locationStaleCount;
    await service.setOpeningStock(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      quantity: 5,
      idempotencyKey: "int-stale-open",
    });
    // Advance the version so the caller's expectedVersion of 1 is now stale.
    const advanced = await service.adjustInventory(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      countedQuantity: 8,
      expectedVersion: 1,
      idempotencyKey: "int-stale-advance",
    });
    expect(advanced).toMatchObject({ changed: true, newOnHand: 8, version: 2 });

    await expect(
      service.adjustInventory(tenantWide(), {
        variantId: ids.variantA,
        inventoryLocationId: loc,
        countedQuantity: 6,
        expectedVersion: 1,
        idempotencyKey: "int-stale-retry",
      }),
    ).rejects.toMatchObject({ name: "InventoryError", code: "CONCURRENT_MODIFICATION" });

    // Nothing from the stale count was applied; the winning count still stands.
    const balance = await service.getInventoryBalance(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
    });
    expect(balance).toMatchObject({ onHand: 8, version: 2 });
  });

  it("treats a no-op count as durably idempotent (persisted envelope, no movement)", async () => {
    const loc = ids.locationNoop;
    await service.setOpeningStock(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      quantity: 10,
      idempotencyKey: "int-noop-open",
    });

    // The count already matches: a durable no-op persists one operation, writes no movement, and
    // leaves the balance and version unchanged.
    const noop = await service.adjustInventory(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      countedQuantity: 10,
      expectedVersion: 1,
      idempotencyKey: "int-noop-K",
    });
    expect(noop).toMatchObject({ changed: false, previousOnHand: 10, newOnHand: 10, version: 1 });
    expect(noop.operationId).toBeTruthy();
    expect(await operationCountForKey("int-noop-K")).toBe(1);
    // One movement total for the key: the opening only; the no-op added none.
    expect(await movementCountForKey(ids.variantA, loc)).toBe(1);

    // Same key + same payload replays the original no-op operation.
    const replay = await service.adjustInventory(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      countedQuantity: 10,
      expectedVersion: 1,
      idempotencyKey: "int-noop-K",
    });
    expect(replay.operationId).toBe(noop.operationId);
    expect(replay.changed).toBe(false);
    expect(await operationCountForKey("int-noop-K")).toBe(1);

    // Same key + different payload is a deterministic conflict, not a fresh adjustment.
    await expect(
      service.adjustInventory(tenantWide(), {
        variantId: ids.variantA,
        inventoryLocationId: loc,
        countedQuantity: 9,
        expectedVersion: 1,
        idempotencyKey: "int-noop-K",
      }),
    ).rejects.toMatchObject({ name: "InventoryError", code: "IDEMPOTENCY_CONFLICT" });

    // A later real stock change advances the version.
    await service.receiveInventory(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      quantity: 5,
      idempotencyKey: "int-noop-receive",
    });

    // Retrying the original no-op key still replays (lookup precedes the version guard), never
    // CONCURRENT_MODIFICATION, and never a new mutation.
    const retry = await service.adjustInventory(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: loc,
      countedQuantity: 10,
      expectedVersion: 1,
      idempotencyKey: "int-noop-K",
    });
    expect(retry.operationId).toBe(noop.operationId);
    expect(retry.changed).toBe(false);
    expect(await operationCountForKey("int-noop-K")).toBe(1);
  });

  it("relocates stock as one atomic transfer with observed balances on both sides", async () => {
    const source = ids.locationTransferSource;
    const destination = ids.locationTransferDestination;
    await service.setOpeningStock(tenantWide(), {
      variantId: ids.variantA,
      inventoryLocationId: source,
      quantity: 10,
      idempotencyKey: "int-transfer-open",
    });

    const transfer = await service.transferInventory(tenantWide(), {
      variantId: ids.variantA,
      sourceInventoryLocationId: source,
      destinationInventoryLocationId: destination,
      quantity: 4,
      idempotencyKey: "int-transfer-1",
    });
    expect(transfer.source).toMatchObject({ inventoryLocationId: source, observedOnHand: 6 });
    expect(transfer.destination).toMatchObject({
      inventoryLocationId: destination,
      observedOnHand: 4,
    });
    // Exactly one operation carrying two movements (one per side).
    expect(await operationCountForKey("int-transfer-1")).toBe(1);
    expect(await movementCountForKey(ids.variantA, source)).toBe(2); // opening + transfer-out
    expect(await movementCountForKey(ids.variantA, destination)).toBe(1); // transfer-in
  });

  it("denies a mutation without the required permission", async () => {
    await expect(
      service.receiveInventory(context([assignment(["inventory.read"])]), {
        variantId: ids.variantA,
        inventoryLocationId: ids.locationLifecycle,
        quantity: 1,
        idempotencyKey: "int-noperm",
      }),
    ).rejects.toMatchObject({ name: "AuthorizationError", code: "PERMISSION_DENIED" });
  });

  it("denies when an explicit scope does not cover the location", async () => {
    await expect(
      service.getInventoryBalance(
        context([assignment(["inventory.read"], [location(ids.locationSecondOpening)])]),
        { variantId: ids.variantA, inventoryLocationId: ids.locationLifecycle },
      ),
    ).rejects.toMatchObject({ name: "AuthorizationError", code: "SCOPE_DENIED" });
  });

  it("rejects a cross-tenant location without leaking existence", async () => {
    // locationTenantB belongs to tenant B; a tenant-A context must be rejected on the resource tenant.
    await expect(
      service.getInventoryBalance(tenantWide(), {
        variantId: ids.variantA,
        inventoryLocationId: ids.locationTenantB,
      }),
    ).rejects.toMatchObject({ name: "AuthorizationError", code: "TENANT_ACCESS_DENIED" });
  });
});
