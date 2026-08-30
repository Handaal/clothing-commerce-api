import type { AuthorizationContext } from "../authorization";
import { AuthorizationError } from "../authorization/errors";
import type { InventoryBalance, Paginated } from "../contracts";
import { decodeInventoryCursor, encodeInventoryCursor } from "../management/cursor";
import { ManagementNotFoundError } from "../management/errors";
import { buildPage, emptyPage } from "../management/pagination";
import { ManagementReadPermission, deriveInventoryReadVisibility } from "../management/visibility";
import type { InventoryReadRepository } from "./inventory-read-repository";

export interface InventoryListParams {
  readonly inventoryLocationId?: string;
  readonly variantId?: string;
  readonly limit: number;
  readonly cursor: string | null;
}

/**
 * Inventory read application service for the management API. Location visibility gates every row; an
 * explicit inventoryLocationId filter follows the 404-then-403 containment sequence. A variantId filter
 * is a plain narrowing filter (not an authorization resource) and never affects status codes.
 */
export class InventoryReadService {
  constructor(private readonly repository: InventoryReadRepository) {}

  async listBalances(
    context: AuthorizationContext,
    params: InventoryListParams,
  ): Promise<Paginated<InventoryBalance>> {
    const cursorKey = params.cursor !== null ? decodeInventoryCursor(params.cursor) : null;

    const visibility = deriveInventoryReadVisibility(context);
    const hasPermission = context.assignments.some((assignment) =>
      assignment.permissionKeys.includes(ManagementReadPermission.inventory),
    );

    if (params.inventoryLocationId !== undefined) {
      const exists = await this.repository.inventoryLocationExistsInTenant(
        context.tenant.id,
        params.inventoryLocationId,
      );
      if (!exists) {
        throw new ManagementNotFoundError();
      }
      const authorized =
        hasPermission &&
        (visibility.tenantWide || visibility.locationIds.includes(params.inventoryLocationId));
      if (!authorized) {
        throw new AuthorizationError(hasPermission ? "SCOPE_DENIED" : "PERMISSION_DENIED");
      }
    } else {
      if (!hasPermission) {
        throw new AuthorizationError("PERMISSION_DENIED");
      }
      if (!visibility.canRead) {
        return emptyPage();
      }
    }

    const rows = await this.repository.listBalances({
      tenantId: context.tenant.id,
      visibility,
      filters: {
        ...(params.inventoryLocationId !== undefined
          ? { inventoryLocationId: params.inventoryLocationId }
          : {}),
        ...(params.variantId !== undefined ? { variantId: params.variantId } : {}),
      },
      fetchLimit: params.limit + 1,
      cursor: cursorKey,
    });

    return buildPage(
      rows,
      params.limit,
      (row) => row.balance,
      (row) => encodeInventoryCursor(row.cursor),
    );
  }
}
