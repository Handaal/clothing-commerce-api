import type { InventoryBalance } from "../contracts";
import type { InventoryCursorKey } from "../management/cursor";
import type { InventoryReadVisibility } from "../management/visibility";

export interface InventoryListFilters {
  readonly inventoryLocationId?: string;
  readonly variantId?: string;
}

export interface InventoryListQuery {
  readonly tenantId: string;
  readonly visibility: InventoryReadVisibility;
  readonly filters: InventoryListFilters;
  readonly fetchLimit: number;
  readonly cursor: InventoryCursorKey | null;
}

export interface InventoryListRow {
  readonly balance: InventoryBalance;
  readonly cursor: InventoryCursorKey;
}

/**
 * The inventory read surface for the management API. The list applies the derived location visibility
 * predicate before the ORDER BY / cursor condition / LIMIT and joins the balance to variant/product
 * display data in one statement. It exposes the authoritative balance `version` (the optimistic-
 * concurrency token adjustInventory guards against) but no movement, operation, or signed-delta detail.
 */
export interface InventoryReadRepository {
  inventoryLocationExistsInTenant(tenantId: string, inventoryLocationId: string): Promise<boolean>;
  listBalances(query: InventoryListQuery): Promise<InventoryListRow[]>;
}
