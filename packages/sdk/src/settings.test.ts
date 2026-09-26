import { describe, expect, it, vi } from "vitest";
import { createCommerceClient } from "./index";

const id = "11111111-1111-4111-8111-111111111111";
const ts = "2026-09-27T00:00:00Z";

function headersOf(init: RequestInit | undefined) {
  return new Headers(init?.headers);
}

describe("Settings SDK", () => {
  it("edits the business profile with a tenant-scoped, idempotent PATCH", async () => {
    const business = {
      id,
      slug: "acme",
      normalizedSlug: "acme",
      displayName: "Acme",
      legalName: null,
      status: "active",
      onboardingState: "completed",
      defaultLocale: "en",
      defaultTimezone: "UTC",
      defaultCurrency: "USD",
      countryCode: null,
      contactEmail: null,
      contactPhone: null,
      taxIdentifier: "TAX-1",
      createdAt: ts,
      updatedAt: ts,
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(business)));
    const client = createCommerceClient({
      baseUrl: "https://example.test",
      getToken: () => "session",
      fetch: fetcher,
    }).withTenant(id);

    expect(await client.getBusinessSettings()).toEqual(business);
    await client.updateBusinessSettings({ taxIdentifier: "TAX-1", idempotencyKey: "biz" });
    const [path, init] = fetcher.mock.calls[1];
    expect(path).toBe("https://example.test/api/v1/settings/business");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ taxIdentifier: "TAX-1" });
    expect(headersOf(init).get("Idempotency-Key")).toBe("biz");
    expect(headersOf(init).get("X-Tenant-Id")).toBe(id);
  });

  it("routes brand eligibility, storefront upsert and device assignment to the right verbs/paths", async () => {
    const branch = {
      id,
      tenantId: id,
      code: "MAIN",
      displayName: "Main",
      timezone: "UTC",
      status: "active",
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      countryCode: null,
      contactEmail: null,
      contactPhone: null,
      isFulfillmentEnabled: false,
      isClickAndCollectEnabled: false,
      defaultInventoryLocationId: null,
      receiptFooter: null,
      archivedAt: null,
      archiveReason: null,
      createdAt: ts,
      updatedAt: ts,
      eligibleBrandIds: [id],
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(branch)));
    const client = createCommerceClient({ baseUrl: "https://example.test", fetch: fetcher }).withTenant(id);

    await client.setBranchBrands({ branchId: id, brandIds: [id], idempotencyKey: "elig" });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe(`https://example.test/api/v1/settings/branches/${id}/brands`);
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ brandIds: [id] });
  });

  it("encodes lifecycle and location filters on list queries", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ items: [], pageInfo: { nextCursor: null, hasMore: false } })),
    );
    const client = createCommerceClient({ baseUrl: "https://example.test", fetch: fetcher }).withTenant(id);

    await client.listInventoryLocations({ status: "active", branchId: id, limit: 5 });
    const query = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(query.get("status")).toBe("active");
    expect(query.get("branchId")).toBe(id);
    expect(query.get("limit")).toBe("5");
    expect(String(fetcher.mock.calls[0][0])).toContain("/api/v1/settings/inventory-locations?");
  });

  it("assigns a device with an idempotent PUT that carries the register in the body", async () => {
    const device = {
      id,
      tenantId: id,
      installationId: "inst-1",
      deviceType: "pos-terminal",
      displayName: "Till 1",
      status: "active",
      clientVersion: null,
      platform: null,
      osVersion: null,
      activatedAt: null,
      revokedAt: null,
      revocationReason: null,
      lastSeenAt: null,
      createdAt: ts,
      updatedAt: ts,
      currentAssignment: { assignmentId: id, registerId: id, registerName: "R1", assignedAt: ts },
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(device)));
    const client = createCommerceClient({ baseUrl: "https://example.test", fetch: fetcher }).withTenant(id);

    await client.assignDevice({ deviceId: id, registerId: id, idempotencyKey: "assign" });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe(`https://example.test/api/v1/settings/devices/${id}/assignment`);
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ registerId: id });
    expect(headersOf(init).get("Idempotency-Key")).toBe("assign");
  });
});
