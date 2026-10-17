import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "../../src/authorization";
import {
  CreateSupplierRequestSchema,
  CreateSupplierReminderRequestSchema,
  RecordSupplierPaymentRequestSchema,
  RecordSupplierPurchaseRequestSchema,
  UpdateSupplierRequestSchema,
} from "../../src/contracts/management/suppliers";
import { ReceiveInventoryRequestSchema } from "../../src/contracts";
import { SuppliersRepository } from "../../src/suppliers/repository";
import { SuppliersService, supplierCapabilities } from "../../src/suppliers/service";
import { SupplierListQuerySchema } from "../../src/suppliers/request";
import { contextWith, grant, location, ids, StubResourceRepository } from "../inventory/fakes";

describe("Supplier validation", () => {
  it.each([
    { name: "" },
    { name: "x", email: "no" },
    { name: "x", tenantId: ids.tenant },
    { name: "x", status: "inactive" },
    { name: "x", code: "x".repeat(101) },
  ])("rejects invalid create %j", (value) => {
    expect(CreateSupplierRequestSchema.safeParse(value).success).toBe(false);
  });
  it("trims names and allows clearing contact fields", () => {
    expect(CreateSupplierRequestSchema.parse({ name: "  Supplier  " })).toEqual({
      name: "Supplier",
    });
    expect(UpdateSupplierRequestSchema.parse({ phone: null, status: "inactive" })).toEqual({
      phone: null,
      status: "inactive",
    });
    expect(UpdateSupplierRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateSupplierRequestSchema.safeParse({ status: "deleted" }).success).toBe(false);
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: "abc" },
    { cursor: "" },
    { status: "deleted" },
    { unknown: "value" },
  ])("fails closed for query %j", (value) => {
    expect(SupplierListQuerySchema.safeParse(value).success).toBe(false);
  });
  it("preserves optional supplier receipt metadata and legacy receipt bodies", () => {
    const input = {
      variantId: ids.variantActive,
      inventoryLocationId: ids.locationActive,
      quantity: 1,
    };
    expect(ReceiveInventoryRequestSchema.parse(input)).toEqual(input);
    expect(
      ReceiveInventoryRequestSchema.parse({
        ...input,
        supplierId: ids.tenant,
        supplierReference: " DN-1 ",
      }),
    ).toMatchObject({ supplierId: ids.tenant, supplierReference: "DN-1" });
  });
  it("validates supplier money as safe integer minor units", () => {
    const purchase = {
      supplierId: ids.tenant,
      inventoryLocationId: ids.locationActive,
      paidMinor: 500,
      lines: [{ variantId: ids.variantActive, quantity: 2, unitCostMinor: 300 }],
    };
    expect(RecordSupplierPurchaseRequestSchema.parse(purchase)).toEqual(purchase);
    expect(
      RecordSupplierPurchaseRequestSchema.safeParse({
        ...purchase,
        lines: [{ ...purchase.lines[0], unitCostMinor: 1.5 }],
      }).success,
    ).toBe(false);
    expect(RecordSupplierPaymentRequestSchema.safeParse({ amountMinor: 0 }).success).toBe(false);
    expect(
      CreateSupplierReminderRequestSchema.parse({
        supplierId: ids.tenant,
        dueDate: "2026-10-09",
      }),
    ).toMatchObject({ leadDays: 3, notify: true });
  });
});

describe("Supplier permission coupling", () => {
  const repository = new SuppliersRepository(createClient("https://example.test", "test-key"));
  const service = new SuppliersService(
    new AuthorizationService(new StubResourceRepository(new Map())),
    repository,
  );
  it("denies missing permission before persistence", async () => {
    const spy = vi.spyOn(repository, "write");
    await expect(service.create(contextWith([]), "key", { name: "x" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("does not borrow tenant scope from an unrelated permission", async () => {
    const context = contextWith([
      grant(["suppliers.manage"], [location(ids.locationActive)]),
      grant(["inventory.read"]),
    ]);
    expect(supplierCapabilities(context)).toEqual({ canRead: false, canManage: false });
    await expect(service.create(context, "key", { name: "x" })).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
  });
  it("keeps read and manage independent", async () => {
    const context = contextWith([grant(["suppliers.read"])]);
    expect(supplierCapabilities(context)).toEqual({ canRead: true, canManage: false });
    await expect(
      service.update(context, ids.tenant, "key", { status: "inactive" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
  it("requires both supplier management and destination receive authority for a purchase", async () => {
    const spy = vi.spyOn(repository, "recordPurchase");
    await expect(
      service.recordPurchase(contextWith([grant(["suppliers.manage"])]), "key", {
        supplierId: ids.tenant,
        inventoryLocationId: ids.locationActive,
        lines: [{ variantId: ids.variantActive, quantity: 1, unitCostMinor: 100 }],
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
