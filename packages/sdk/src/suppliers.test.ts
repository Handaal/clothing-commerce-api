import { describe, expect, it, vi } from "vitest";
import { createCommerceClient, ApiContractError } from "./index";
const id = "11111111-1111-4111-8111-111111111111";
const supplier = {
  id,
  tenantId: id,
  name: "Supplier",
  code: null,
  status: "active",
  contactPerson: null,
  phone: null,
  email: null,
  address: null,
  notes: null,
  createdAt: "2026-09-21T00:00:00Z",
  updatedAt: "2026-09-21T00:00:00Z",
};
describe("Supplier SDK", () => {
  it("uses tenant-scoped, idempotent POST and PATCH bodies", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(supplier)));
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      getToken: () => "session",
      fetch: fetcher,
    }).withTenant(id);
    expect(await client.createSupplier({ name: "Supplier", idempotencyKey: "create-key" })).toEqual(
      supplier,
    );
    await client.updateSupplier({
      supplierId: id,
      status: "inactive",
      phone: null,
      idempotencyKey: "update-key",
    });
    const [path, init] = fetcher.mock.calls[1];
    expect(path).toBe(`https://example.test/api/v1/suppliers/${id}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ status: "inactive", phone: null });
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("update-key");
    expect(new Headers(init?.headers).get("X-Tenant-Id")).toBe(id);
    expect(await client.getSupplier(id)).toEqual(supplier);
  });
  it("encodes search and opaque cursors and validates supplier/history envelopes", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ items: [], pageInfo: { nextCursor: null, hasMore: false } })),
    );
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    }).withTenant(id);
    await client.listSuppliers({ search: "A & B", status: "active", limit: 1, cursor: "opaque" });
    const query = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(query.get("search")).toBe("A & B");
    expect(query.get("cursor")).toBe("opaque");
    await client.listSupplierReceipts(id, { limit: 1 });
    expect(String(fetcher.mock.calls[1][0])).toContain(`/suppliers/${id}/receipts?limit=1`);
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [{ internal: "invalid" }] })),
    );
    await expect(client.listSupplierReceipts(id)).rejects.toBeInstanceOf(ApiContractError);
  });
  it("forwards optional receipt supplier metadata without embedding the idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            operationId: id,
            variantId: id,
            inventoryLocationId: id,
            observedOnHand: 1,
            observedVersion: 1,
            supplierId: id,
            supplierReference: "DN-1",
          }),
        ),
    );
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
    }).withTenant(id);
    const result = await client.receiveInventory({
      variantId: id,
      inventoryLocationId: id,
      quantity: 1,
      supplierId: id,
      supplierReference: "DN-1",
      idempotencyKey: "receipt",
    });
    expect(result.supplierId).toBe(id);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({
      variantId: id,
      inventoryLocationId: id,
      quantity: 1,
      supplierId: id,
      supplierReference: "DN-1",
    });
  });
});
