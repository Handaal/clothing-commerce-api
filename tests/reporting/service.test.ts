import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "../../src/authorization";
import { ReportingRepository } from "../../src/reporting/repository";
import { ReportingService, reportCapabilities } from "../../src/reporting/service";
import {
  InventoryQuerySchema,
  ProductsQuerySchema,
  SalesQuerySchema,
  SummaryQuerySchema,
} from "../../src/reporting/request";
import { contextWith, grant, location, ids, StubResourceRepository } from "../inventory/fakes";

describe("Reporting query validation", () => {
  it.each([
    {},
    { startDate: "2026-13-01", endDate: "2026-01-31" },
    { startDate: "2026-01-01" },
    { startDate: "2026-01-01", endDate: "2026-01-31", unknown: "x" },
  ])("fails closed for summary query %j", (value) => {
    expect(SummaryQuerySchema.safeParse(value).success).toBe(false);
  });

  it("applies defaults and coerces the page limit", () => {
    expect(
      SalesQuerySchema.parse({ startDate: "2026-01-01", endDate: "2026-01-31" }),
    ).toMatchObject({
      view: "trend",
      bucket: "day",
    });
    expect(
      ProductsQuerySchema.parse({ startDate: "2026-01-01", endDate: "2026-01-31" }),
    ).toMatchObject({ level: "variant", view: "sales", limit: 50 });
    expect(
      ProductsQuerySchema.parse({ startDate: "2026-01-01", endDate: "2026-01-31", limit: "5" })
        .limit,
    ).toBe(5);
  });

  it.each([{ limit: 0 }, { limit: 201 }, { view: "bogus" }, { bucket: "hour" }])(
    "rejects invalid sales query %j",
    (value) => {
      expect(
        SalesQuerySchema.safeParse({ startDate: "2026-01-01", endDate: "2026-01-31", ...value })
          .success,
      ).toBe(false);
    },
  );

  it("allows a period-less inventory balances query but rejects unknown views", () => {
    expect(InventoryQuerySchema.parse({}).view).toBe("balances");
    expect(InventoryQuerySchema.safeParse({ view: "as_of" }).success).toBe(false);
  });
});

describe("Reporting authorization (tenant-wide reports.read)", () => {
  const repository = new ReportingRepository(createClient("https://example.test", "test-key"));
  const service = new ReportingService(
    new AuthorizationService(new StubResourceRepository(new Map())),
    repository,
  );
  const period = { startDate: "2026-01-01", endDate: "2026-01-31" };

  it("denies a caller without reports.read before any persistence", async () => {
    const spy = vi.spyOn(repository, "summary");
    await expect(service.summary(contextWith([]), period)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not let a brand/branch-scoped reports.read grant become tenant-wide reporting", async () => {
    const context = contextWith([grant(["reports.read"], [location(ids.locationActive)])]);
    expect(reportCapabilities(context)).toEqual({ canRead: false });
    const spy = vi.spyOn(repository, "sales");
    await expect(
      service.sales(context, { ...period, view: "trend", bucket: "day" }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("authorizes a tenant-wide reports.read grant and reaches the repository", async () => {
    const context = contextWith([grant(["reports.read"])]);
    expect(reportCapabilities(context)).toEqual({ canRead: true });
    const spy = vi
      .spyOn(repository, "summary")
      .mockResolvedValue({ ok: true } as unknown as Awaited<ReturnType<typeof repository.summary>>);
    await service.summary(context, period);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("requires a period for non-balances inventory views", async () => {
    const context = contextWith([grant(["reports.read"])]);
    await expect(
      service.inventory(context, { view: "movements", limit: 50 }),
    ).rejects.toMatchObject({
      code: "INVALID_REPORT_QUERY",
    });
  });
});
