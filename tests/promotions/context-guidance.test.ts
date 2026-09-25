import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationService } from "../../src/authorization";
import { MeContextResponseSchema } from "../../src/contracts";
import { ManagementContextService } from "../../src/management/context-service";
import type {
  OrganizationReadRepository,
  OrgBrand,
  OrgBranch,
  OrgInventoryLocation,
  OrgInventoryLocationCapability,
  OrgTenantSummary,
} from "../../src/management/organization-read-repository";
import { PromotionsRepository } from "../../src/promotions/repository";
import { promotionCapabilities, PromotionsService } from "../../src/promotions/service";
import { contextWith, grant, ids, location, StubResourceRepository } from "../inventory/fakes";

class RecordingOrganizationRepository implements OrganizationReadRepository {
  readonly tenantIds: string[] = [];

  async findTenantSummary(tenantId: string): Promise<OrgTenantSummary> {
    this.tenantIds.push(tenantId);
    return { id: tenantId, name: "Tenant", status: "active" };
  }

  async findBrands(tenantId: string): Promise<OrgBrand[]> {
    this.tenantIds.push(tenantId);
    return [];
  }

  async findBranches(tenantId: string): Promise<OrgBranch[]> {
    this.tenantIds.push(tenantId);
    return [];
  }

  async findInventoryLocations(tenantId: string): Promise<OrgInventoryLocation[]> {
    this.tenantIds.push(tenantId);
    return [];
  }

  async findInventoryLocationCapabilities(
    tenantId: string,
  ): Promise<OrgInventoryLocationCapability[]> {
    this.tenantIds.push(tenantId);
    return [];
  }
}

describe("Promotion /me/context capability guidance", () => {
  it.each([
    { permissions: [], expected: { canRead: false, canManage: false } },
    { permissions: ["promotions.read"], expected: { canRead: true, canManage: false } },
    { permissions: ["promotions.manage"], expected: { canRead: false, canManage: true } },
    {
      permissions: ["promotions.read", "promotions.manage"],
      expected: { canRead: true, canManage: true },
    },
  ])("derives read and manage independently from $permissions", ({ permissions, expected }) => {
    const assignments = permissions.length === 0 ? [] : [grant(permissions)];
    expect(promotionCapabilities(contextWith(assignments))).toEqual(expected);
  });

  it("does not turn an explicitly scoped grant into tenant-wide Promotion guidance or authority", async () => {
    const context = contextWith([
      grant(["promotions.read", "promotions.manage"], [location(ids.locationActive)]),
    ]);
    expect(promotionCapabilities(context)).toEqual({ canRead: false, canManage: false });

    const repository = new PromotionsRepository(createClient("https://example.test", "test-key"));
    const create = vi.spyOn(repository, "create");
    const service = new PromotionsService(
      new AuthorizationService(new StubResourceRepository(new Map())),
      repository,
    );
    await expect(
      service.create(context, "key", {
        name: "Scoped promotion",
        benefitType: "percentage",
        benefitPercentBp: 1000,
        targetType: "order",
        activationType: "automatic",
      }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(create).not.toHaveBeenCalled();
  });

  it("adds Promotion guidance without changing existing access fields or tenant filtering", async () => {
    const repository = new RecordingOrganizationRepository();
    const service = new ManagementContextService(repository);
    const result = await service.resolveContext(
      contextWith([grant(["promotions.read"])], { tenantId: ids.otherTenant }),
    );

    expect(result.access).toEqual({
      suppliers: { canRead: false, canManage: false },
      staff: { canRead: false, canManage: false },
      promotions: { canRead: true, canManage: false },
      catalog: { canRead: false, tenantWide: false, brands: [] },
      inventory: {
        canRead: false,
        tenantWide: false,
        locations: [],
        write: { canReceive: false, canAdjust: false, canTransfer: false, locations: [] },
      },
      orders: { canRead: false, tenantWide: false, brands: [], branches: [] },
    });
    expect(repository.tenantIds).toEqual([ids.otherTenant]);
  });

  it("keeps the additive capability optional so pre-patch context payloads still parse", () => {
    const legacyContext = {
      tenant: { id: ids.tenant, name: "Tenant", status: "active" },
      membership: { id: ids.membership },
      access: {
        catalog: { canRead: false, tenantWide: false, brands: [] },
        inventory: {
          canRead: false,
          tenantWide: false,
          locations: [],
          write: { canReceive: false, canAdjust: false, canTransfer: false, locations: [] },
        },
        orders: { canRead: false, tenantWide: false, brands: [], branches: [] },
      },
    };

    expect(MeContextResponseSchema.parse(legacyContext)).not.toHaveProperty("access.promotions");
    expect(
      MeContextResponseSchema.parse({
        ...legacyContext,
        access: {
          ...legacyContext.access,
          promotions: { canRead: false, canManage: true },
        },
      }).access.promotions,
    ).toEqual({ canRead: false, canManage: true });
  });
});
