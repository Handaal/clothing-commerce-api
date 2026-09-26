import { settingsCapabilities } from "../settings/service";
import { supplierCapabilities } from "../suppliers/service";
import { staffCapabilities } from "../staff/service";
import { promotionCapabilities } from "../promotions/service";
import { reportCapabilities } from "../reporting/service";
import type { AuthorizationContext } from "../authorization";
import type { MeContextResponse } from "../contracts";
import type { IdSelector, OrganizationReadRepository } from "./organization-read-repository";
import {
  deriveCatalogReadVisibility,
  deriveInventoryReadVisibility,
  deriveInventoryWriteCapability,
  deriveInventoryWriteScope,
  deriveOrderReadVisibility,
  ManagementWritePermission,
  type InventoryWriteScope,
} from "./visibility";

/**
 * Chooses which locations to hydrate for write-capability derivation. `undefined` means "no write
 * scope at all, skip the query". `null` means "all tenant locations" (some write grant is tenant-wide).
 * Otherwise it is exactly the union of explicitly-targeted locations across the three write permissions,
 * so a scoped caller can never be presented a location outside its authorization scope.
 */
function inventoryWriteLocationSelector(scopes: {
  readonly receive: InventoryWriteScope;
  readonly adjust: InventoryWriteScope;
  readonly transfer: InventoryWriteScope;
}): IdSelector | undefined {
  const all = [scopes.receive, scopes.adjust, scopes.transfer];
  if (!all.some((scope) => scope.hasScope)) {
    return undefined;
  }
  if (all.some((scope) => scope.tenantWide)) {
    return null;
  }
  const ids = new Set<string>();
  for (const scope of all) {
    for (const id of scope.locationIds) {
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Builds the permission-specific /me/context DTO. It derives read visibility and inventory write
 * capability purely from the verified AuthorizationContext, then hydrates ONLY the organization
 * metadata the caller's effective access already covers. It never enumerates the organization and never
 * returns raw permission/scope internals. The inventory write block is UX guidance; it does not and
 * cannot grant access — every mutation endpoint re-authorizes server-side.
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

    // Inventory write capability is UX guidance derived from the same permission+scope+location facts
    // the mutation path authorizes against; it never grants access on its own (see visibility.ts).
    const writeScopes = {
      receive: deriveInventoryWriteScope(context, ManagementWritePermission.receive),
      adjust: deriveInventoryWriteScope(context, ManagementWritePermission.adjust),
      transfer: deriveInventoryWriteScope(context, ManagementWritePermission.transfer),
    };
    const writeLocationSelector = inventoryWriteLocationSelector(writeScopes);

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

    const [catalogBrands, inventoryLocations, orderBrands, orderBranches, writeLocationRows] =
      await Promise.all([
        catalogBrandSelector === undefined
          ? Promise.resolve([])
          : this.organizationRepository.findBrands(context.tenant.id, catalogBrandSelector),
        inventorySelector === undefined
          ? Promise.resolve([])
          : this.organizationRepository.findInventoryLocations(
              context.tenant.id,
              inventorySelector,
            ),
        orderBrandSelector === undefined
          ? Promise.resolve([])
          : this.organizationRepository.findBrands(context.tenant.id, orderBrandSelector),
        orderBranchSelector === undefined
          ? Promise.resolve([])
          : this.organizationRepository.findBranches(context.tenant.id, orderBranchSelector),
        writeLocationSelector === undefined
          ? Promise.resolve([])
          : this.organizationRepository.findInventoryLocationCapabilities(
              context.tenant.id,
              writeLocationSelector,
            ),
      ]);

    const inventoryWrite = deriveInventoryWriteCapability(writeScopes, writeLocationRows);

    return {
      tenant: { id: tenant.id, name: tenant.name, status: tenant.status },
      membership: { id: context.membership.id },
      access: {
        settings: settingsCapabilities(context),
        suppliers: supplierCapabilities(context),
        staff: staffCapabilities(context),
        promotions: promotionCapabilities(context),
        reports: reportCapabilities(context),
        catalog: {
          canRead: catalog.canRead,
          tenantWide: catalog.tenantWide,
          brands: catalogBrands,
        },
        inventory: {
          canRead: inventory.canRead,
          tenantWide: inventory.tenantWide,
          locations: inventoryLocations,
          write: {
            canReceive: inventoryWrite.canReceive,
            canAdjust: inventoryWrite.canAdjust,
            canTransfer: inventoryWrite.canTransfer,
            locations: inventoryWrite.locations.map((location) => ({
              id: location.id,
              name: location.name,
              canReceive: location.canReceive,
              canAdjust: location.canAdjust,
              canTransferOrigin: location.canTransferOrigin,
              canTransferDestination: location.canTransferDestination,
            })),
          },
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
