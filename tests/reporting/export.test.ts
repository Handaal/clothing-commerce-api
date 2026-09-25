import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "../../src/authorization";
import { ReportingRepository } from "../../src/reporting/repository";
import { ReportingService } from "../../src/reporting/service";
import { ExportQuerySchema } from "../../src/reporting/request";
import { renderExportCsv } from "../../src/reporting/export";
import { contextWith, grant, location, ids, StubResourceRepository } from "../inventory/fakes";

describe("Export query validation", () => {
  it("rejects an unsupported dataset, missing dates, and unknown keys", () => {
    expect(
      ExportQuerySchema.safeParse({ startDate: "2026-06-01", endDate: "2026-06-30" }).success,
    ).toBe(false);
    expect(
      ExportQuerySchema.safeParse({
        dataset: "everything",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      }).success,
    ).toBe(false);
    expect(
      ExportQuerySchema.safeParse({ dataset: "returns", startDate: "2026-06-01" }).success,
    ).toBe(false);
    expect(
      ExportQuerySchema.safeParse({
        dataset: "returns",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        rogue: "x",
      }).success,
    ).toBe(false);
  });

  it("defaults level to variant for the valid datasets", () => {
    for (const dataset of [
      "sales-products",
      "inventory-movements",
      "returns",
      "supplier-receipts",
    ]) {
      expect(
        ExportQuerySchema.parse({ dataset, startDate: "2026-06-01", endDate: "2026-06-30" }).level,
      ).toBe("variant");
    }
  });
});

describe("Export authorization + bounds (tenant-wide reports.read)", () => {
  const repository = new ReportingRepository(createClient("https://example.test", "test-key"));
  const service = new ReportingService(
    new AuthorizationService(new StubResourceRepository(new Map())),
    repository,
  );
  const base = {
    dataset: "sales-products" as const,
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    level: "variant" as const,
  };

  it("denies a caller without reports.read before any persistence", async () => {
    const spy = vi.spyOn(repository, "export");
    await expect(service.export(contextWith([]), base)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects a brand/branch-scoped reports.read grant (export is tenant-wide only)", async () => {
    const context = contextWith([grant(["reports.read"], [location(ids.locationActive)])]);
    const spy = vi.spyOn(repository, "export");
    await expect(service.export(context, base)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects an over-long date range with an explicit error (never truncates)", async () => {
    const context = contextWith([grant(["reports.read"])]);
    const spy = vi.spyOn(repository, "export");
    await expect(
      service.export(context, { ...base, startDate: "2026-01-01", endDate: "2027-01-05" }),
    ).rejects.toMatchObject({ code: "EXPORT_RANGE_TOO_LARGE", httpStatus: 422 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("passes the maximum row bound to the repository and renders the CSV document", async () => {
    const context = contextWith([grant(["reports.read"])]);
    const spy = vi.spyOn(repository, "export").mockResolvedValue({
      period: { timezone: "UTC", fromInclusive: "x", toExclusive: "y" },
      rows: [],
    } as unknown as Awaited<ReturnType<typeof repository.export>>);
    const result = await service.export(context, base);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dataset: "sales-products", maxRows: 50_000, level: "variant" }),
    );
    expect(result.mediaType).toBe("text/csv");
    expect(result.filename).toBe("sales-products_2026-06-01_2026-06-30.csv");
    // Header row present even with no data.
    expect(result.body.startsWith("productId,productName,variantId,sku,level,currency")).toBe(true);
    spy.mockRestore();
  });
});

describe("Export CSV projections", () => {
  it("keeps mixed currencies as separate explicit rows in sales-products", () => {
    const csv = renderExportCsv("sales-products", [
      {
        productId: "11111111-1111-4111-8111-111111111111",
        productName: "Tee",
        variantId: "22222222-2222-4222-8222-222222222222",
        sku: "TEE-M",
        level: "variant",
        currency: "USD",
        unitsSold: 2,
        grossSalesMinor: 5198,
        allocatedDiscountsMinor: 1000,
        netSalesMinor: 4198,
      },
      {
        productId: "33333333-3333-4333-8333-333333333333",
        productName: "Cap",
        variantId: "44444444-4444-4444-8444-444444444444",
        sku: "CAP-1",
        level: "variant",
        currency: "EUR",
        unitsSold: 2,
        grossSalesMinor: 3000,
        allocatedDiscountsMinor: 0,
        netSalesMinor: 3000,
      },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[1]).toContain(",USD,");
    expect(lines[2]).toContain(",EUR,");
    // No combined/total row is ever produced.
    expect(lines).toHaveLength(3);
  });

  it("neutralizes a malicious product name while leaving numbers intact", () => {
    const csv = renderExportCsv("inventory-movements", [
      {
        occurredAt: "2026-06-05T13:00:00.000Z",
        operationType: "receipt",
        operationId: "55555555-5555-4555-8555-555555555555",
        productId: "66666666-6666-4666-8666-666666666666",
        productName: "=HYPERLINK(evil)",
        variantId: "77777777-7777-4777-8777-777777777777",
        sku: "TEE-M",
        inventoryLocationId: "88888888-8888-4888-8888-888888888888",
        locationName: "Sales Floor",
        quantityDelta: -2,
        notes: null,
        supplierId: null,
        supplierName: null,
      },
    ]);
    expect(csv).toContain("'=HYPERLINK(evil)");
    // The negative delta is an exact number, not neutralized or quoted.
    expect(csv).toContain(",-2,");
  });

  it("supplier-receipts exposes no cost/spend/value/COGS column", () => {
    const csv = renderExportCsv("supplier-receipts", []);
    const header = csv.trimEnd();
    for (const forbidden of ["spend", "value", "cost", "cogs", "acquisition"]) {
      expect(header.toLowerCase()).not.toContain(forbidden);
    }
    expect(header).toContain("unitsReceived");
  });
});
