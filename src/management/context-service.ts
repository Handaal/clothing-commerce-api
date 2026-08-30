import type { AuthorizationContext } from "../authorization";
import type { MeContextResponse } from "../contracts";
import type { IdSelector, OrganizationReadRepository } from "./organization-read-repository";
import {
  deriveCatalogReadVisibility,
  deriveInventoryReadVisibility,
  deriveOrderReadVisibility,
} from "./visibility";

/**
 * Builds the permission-specific /me/context DTO. It derives read visibility purely from the verified
 * AuthorizationContext, then hydrates ONLY the organization metadata the caller's effective access
 * already covers. It never enumerates the organization and never returns raw permission/scope internals.
 */
export class ManagementContextService {
  constructor(private readonly organizationRepository: OrganizationReadRepository) {}

  async resolveContext(context: AuthorizationContext): Promise<MeContextResponse> {
    const tenant = await this.organizationRepository.findTenantSummary(context.tenant.id);
    if (tenant === null) {
      // The context resolver already confirmed an active tenant; a missing row here is a server
      // invariant violation, not a client condition.
      throw new Error("Tenant metadata is unavailable for a resolved authorization context.");
    }

    const catalog = deriveCatalogReadVisibility(context);
    const inventory = deriveInventoryReadVisibility(context);
    const orders = deriveOrderReadVisibility(context);

    const catalogBrandSelector: IdSelector | undefined = catalog.canRead
      ? catalog.tenantWide
        ? null
        : catalog.brandIds
      : undefined;
    const inventorySelector: IdSelector | undefined = inventory.canRead
      ? inventory.tenantWide
        ? null
        : inventory.locationIds
      : undefined;
    const orderBrandSelector: IdSelector | undefined = orders.canRead
      ? orders.tenantWide
        ? null
        : orders.brandIds
      : undefined;
    const orderBranchSelector: IdSelector | undefined = orders.canRead
      ? orders.tenantWide
        ? null
        : orders.branchIds
      : undefined;

    const [catalogBrands, inventoryLocations, orderBrands, orderBranches] = await Promise.all([
      catalogBrandSelector === undefined
        ? Promise.resolve([])
        : this.organizationRepository.findBrands(context.tenant.id, catalogBrandSelector),
      inventorySelector === undefined
        ? Promise.resolve([])
        : this.organizationRepository.findInventoryLocations(context.tenant.id, inventorySelector),
      orderBrandSelector === undefined
        ? Promise.resolve([])
        : this.organizationRepository.findBrands(context.tenant.id, orderBrandSelector),
      orderBranchSelector === undefined
        ? Promise.resolve([])
        : this.organizationRepository.findBranches(context.tenant.id, orderBranchSelector),
    ]);

    return {
      tenant: { id: tenant.id, name: tenant.name, status: tenant.status },
      membership: { id: context.membership.id },
      access: {
        catalog: {
          canRead: catalog.canRead,
          tenantWide: catalog.tenantWide,
          brands: catalogBrands,
        },
        inventory: {
          canRead: inventory.canRead,
          tenantWide: inventory.tenantWide,
          locations: inventoryLocations,
        },
        orders: {
          canRead: orders.canRead,
          tenantWide: orders.tenantWide,
          brands: orderBrands,
          branches: orderBranches,
        },
      },
    };
  }
}
