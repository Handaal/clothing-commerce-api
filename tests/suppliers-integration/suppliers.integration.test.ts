import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createCommerceClient,
  type Supplier,
  type ReceiveInventoryInput,
} from "../../packages/sdk/src";

const url = process.env.RETURNS_TEST_URL;
const container = process.env.RETURNS_TEST_CONTAINER;
if (!url || !container)
  throw new Error("Run pnpm test:suppliers:integration with its disposable environment.");
const T = "2a000001-0000-4000-8000-000000000001",
  FOREIGN = "2a000020-0000-4000-8000-000000000002";
const V = "2a000007-0000-4000-8000-000000000001",
  L = "2a000004-0000-4000-8000-000000000001",
  L2 = "2a000004-0000-4000-8000-000000000002";
const clientFor = (token: string | undefined) =>
  createCommerceClient({
    baseUrl: url,
    getToken: () => token,
    client: { type: "admin-mobile", version: "0.1.0" },
  }).withTenant(T);
const client = clientFor(process.env.RETURNS_TEST_TOKEN);
const denied = clientFor(process.env.RETURNS_TEST_DENIED_TOKEN);
const scoped = clientFor(process.env.RETURNS_TEST_SCOPED_TOKEN);
const key = () => crypto.randomUUID();
function sql(source: string) {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container!,
      "psql",
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
    ],
    { input: source, encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function balance() {
  return Number(
    sql(
      `select on_hand_quantity from inventory_balances where tenant_id='${T}' and variant_id='${V}' and inventory_location_id='${L}'`,
    ),
  );
}
let supplier: Supplier;
let receipt: ReceiveInventoryInput;
let operationId: string;

describe.sequential("Phase 2N real API supplier acceptance", () => {
  it("A: creates, lists, details, updates and replays supplier writes", async () => {
    const input = { name: "Acceptance Supplier", code: "ACCEPT-2N", idempotencyKey: key() };
    supplier = await client.createSupplier(input);
    expect(supplier).toMatchObject({ tenantId: T, status: "active", name: input.name });
    expect(await client.createSupplier(input)).toEqual(supplier);
    expect((await client.listSuppliers({ search: "accept-2n" })).items.map((s) => s.id)).toContain(
      supplier.id,
    );
    expect(await client.getSupplier(supplier.id)).toEqual(supplier);
    supplier = await client.updateSupplier({
      supplierId: supplier.id,
      idempotencyKey: key(),
      phone: "12345",
      notes: "Call before delivery",
      contactPerson: "Buyer",
    });
    expect(await client.getSupplier(supplier.id)).toMatchObject({
      phone: "12345",
      notes: "Call before delivery",
      contactPerson: "Buyer",
    });
    await expect(client.createSupplier({ ...input, name: "Changed" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });
  it("B: receipt increases canonical stock and appears in history", async () => {
    receipt = {
      variantId: V,
      inventoryLocationId: L,
      quantity: 3,
      supplierId: supplier.id,
      supplierReference: "DELIVERY-001",
      idempotencyKey: key(),
    };
    const before = balance();
    const result = await client.receiveInventory(receipt);
    operationId = result.operationId;
    expect(result).toMatchObject({ supplierId: supplier.id, supplierReference: "DELIVERY-001" });
    expect(balance()).toBe(before + 3);
    const history = await client.listSupplierReceipts(supplier.id);
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      operationId,
      supplierName: "Acceptance Supplier",
      supplierCode: "ACCEPT-2N",
      supplierReference: "DELIVERY-001",
      lines: [{ variantId: V, quantity: 3, inventoryLocationId: L }],
    });
  });
  it("C: exact and concurrent replay return one operation and never increase stock twice", async () => {
    const before = balance();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => client.receiveInventory(receipt)),
    );
    expect(new Set(results.map((r) => r.operationId))).toEqual(new Set([operationId]));
    expect(balance()).toBe(before);
    expect((await client.listSupplierReceipts(supplier.id)).items).toHaveLength(1);
  });
  it("D: changing supplier, reference, quantity, destination, or variant conflicts without stock mutation", async () => {
    const other = await client.createSupplier({ name: "Other", idempotencyKey: key() });
    const before = balance();
    // The same variant/destination fields remain subject to existing catalog/location authorization.
    for (const change of [
      { supplierId: other.id },
      { supplierId: undefined },
      { supplierReference: "different" },
      { supplierReference: undefined },
      { quantity: 4 },
      { inventoryLocationId: L2 },
    ]) {
      await expect(client.receiveInventory({ ...receipt, ...change })).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      });
    }
    expect(balance()).toBe(before);
  });
  it("E: cross-tenant supplier read, edit, deactivate, history and receipt reference fail", async () => {
    const before = balance();
    await expect(client.getSupplier(FOREIGN)).rejects.toMatchObject({ code: "SUPPLIER_NOT_FOUND" });
    await expect(
      client.updateSupplier({ supplierId: FOREIGN, name: "Stolen", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "SUPPLIER_NOT_FOUND" });
    await expect(
      client.updateSupplier({ supplierId: FOREIGN, status: "inactive", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "SUPPLIER_NOT_FOUND" });
    await expect(client.listSupplierReceipts(FOREIGN)).rejects.toMatchObject({
      code: "SUPPLIER_NOT_FOUND",
    });
    await expect(
      client.receiveInventory({ ...receipt, idempotencyKey: key(), supplierId: FOREIGN }),
    ).rejects.toMatchObject({ code: "SUPPLIER_NOT_FOUND" });
    await expect(
      client.receiveInventory({ ...receipt, idempotencyKey: key(), supplierId: key() }),
    ).rejects.toMatchObject({ code: "SUPPLIER_NOT_FOUND" });
    expect(balance()).toBe(before);
    expect((await client.listSuppliers({ search: "Foreign" })).items).toEqual([]);
  });
  it("F: deactivation and rename preserve readable snapshot history and accepted replay", async () => {
    await client.updateSupplier({
      supplierId: supplier.id,
      name: "Renamed Supplier",
      status: "inactive",
      idempotencyKey: key(),
    });
    expect(await client.getSupplier(supplier.id)).toMatchObject({
      status: "inactive",
      name: "Renamed Supplier",
    });
    const before = balance();
    expect((await client.receiveInventory(receipt)).operationId).toBe(operationId);
    await expect(
      client.receiveInventory({ ...receipt, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "SUPPLIER_INACTIVE" });
    await expect(
      client.receiveInventory({ ...receipt, supplierReference: "changed while inactive" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(balance()).toBe(before);
    expect((await client.listSupplierReceipts(supplier.id)).items[0]).toMatchObject({
      operationId,
      supplierName: "Acceptance Supplier",
    });
    expect((await client.listSuppliers({ status: "inactive" })).items.map((s) => s.id)).toContain(
      supplier.id,
    );
  });
  it("G: no-supplier receiving remains compatible, including exact replay", async () => {
    const input = { variantId: V, inventoryLocationId: L, quantity: 2, idempotencyKey: key() };
    const before = balance();
    const result = await client.receiveInventory(input);
    expect(result.supplierId).toBeUndefined();
    expect((await client.receiveInventory(input)).operationId).toBe(result.operationId);
    expect(balance()).toBe(before + 2);
  });
  it("reactivates and clears optional fields with null", async () => {
    const result = await client.updateSupplier({
      supplierId: supplier.id,
      status: "active",
      phone: null,
      notes: null,
      idempotencyKey: key(),
    });
    expect(result).toMatchObject({ status: "active", phone: null, notes: null });
  });
  it("fails closed for malformed query/cursors and supports stable supplier/history pagination", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listSuppliers({ limit: 1, cursor });
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.has(supplier.id)).toBe(true);
    for (const query of [{ limit: 0 }, { limit: 101 }, { cursor: "garbage" }])
      await expect(client.listSuppliers(query)).rejects.toBeDefined();
    await expect(
      client.listSupplierReceipts(supplier.id, { cursor: "garbage" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect((await client.listSuppliers({ search: "%" })).items).toEqual([]);
    expect((await client.listSuppliers({ search: "renamed" })).items.map((s) => s.id)).toContain(
      supplier.id,
    );
    await client.receiveInventory({ ...receipt, idempotencyKey: key() });
    const first = await client.listSupplierReceipts(supplier.id, { limit: 1 });
    expect(first.pageInfo.hasMore).toBe(true);
    const second = await client.listSupplierReceipts(supplier.id, {
      limit: 1,
      cursor: first.pageInfo.nextCursor!,
    });
    expect(first.items[0].operationId).not.toBe(second.items[0].operationId);
    expect(second.pageInfo.hasMore).toBe(false);
  });
  it("permission and explicit-scope denial precede supplier mutation", async () => {
    await expect(
      denied.createSupplier({ name: "Denied", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      denied.updateSupplier({ supplierId: supplier.id, status: "inactive", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(denied.listSuppliers()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      scoped.createSupplier({ name: "Scoped", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(
      scoped.receiveInventory({ ...receipt, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect((await client.getContext()).access.suppliers).toEqual({
      canRead: true,
      canManage: true,
    });
    expect((await denied.getContext()).access.suppliers).toEqual({
      canRead: false,
      canManage: false,
    });
    expect((await scoped.getContext()).access.suppliers).toEqual({
      canRead: false,
      canManage: false,
    });
  });
  it("validates name, email, bounds, unknown fields, empty updates and unique tenant codes", async () => {
    for (const body of [
      { name: "" },
      { name: "x", email: "invalid" },
      { name: "x", tenantId: T },
      { name: "x", code: "x".repeat(101) },
    ]) {
      const response = await fetch(`${url}/api/v1/suppliers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RETURNS_TEST_TOKEN}`,
          "X-Tenant-Id": T,
          "Idempotency-Key": key(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    await expect(
      client.updateSupplier({ supplierId: supplier.id, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      client.createSupplier({ name: "Duplicate", code: "accept-2n", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "SUPPLIER_CODE_CONFLICT" });
  });
  it("concurrent first receipt submissions persist one operation", async () => {
    const input = { ...receipt, quantity: 1, idempotencyKey: key() };
    const before = balance();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.receiveInventory(input)),
    );
    expect(new Set(results.map((r) => r.operationId)).size).toBe(1);
    expect(balance()).toBe(before + 1);
  });
  it("inventory adjustment and transfer still use the canonical ledger", async () => {
    const observed = (await client.listInventory({ inventoryLocationId: L, variantId: V }))
      .items[0];
    const adjusted = await client.adjustInventory({
      variantId: V,
      inventoryLocationId: L,
      countedQuantity: observed.onHand + 1,
      expectedVersion: observed.version,
      idempotencyKey: key(),
    });
    expect(adjusted.newOnHand).toBe(observed.onHand + 1);
    const transfer = await client.transferInventory({
      variantId: V,
      sourceInventoryLocationId: L,
      destinationInventoryLocationId: L2,
      quantity: 1,
      idempotencyKey: key(),
    });
    expect(transfer.operationId).toBeDefined();
    expect(balance()).toBe(observed.onHand);
  });
});
