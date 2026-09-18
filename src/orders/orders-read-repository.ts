import type { OrderChannel, OrderStatus, OrderSummary } from "../contracts";
import type { OrderCursorKey } from "../management/cursor";
import type { OrderReadVisibility } from "../management/visibility";

export interface OrderListFilters {
  readonly channel?: OrderChannel;
  readonly brandId?: string;
  readonly branchId?: string;
  readonly status?: OrderStatus;
}

export interface OrderListQuery {
  readonly tenantId: string;
  readonly visibility: OrderReadVisibility;
  readonly filters: OrderListFilters;
  readonly fetchLimit: number;
  readonly cursor: OrderCursorKey | null;
}

export interface OrderListRow {
  readonly summary: OrderSummary;
  readonly cursor: OrderCursorKey;
}

/**
 * The orders list read surface for the management API. The list applies the channel-split order
 * visibility predicate (ONLINE orders by authorized brand, POS orders by authorized branch) before the
 * ORDER BY / cursor condition / LIMIT. Order DETAIL is composed by the read service from the existing
 * OrderService + FulfillmentService, not from this repository.
 */
export interface OrdersReadRepository {
  brandExistsInTenant(tenantId: string, brandId: string): Promise<boolean>;
  branchExistsInTenant(tenantId: string, branchId: string): Promise<boolean>;
  getCommerceDetails(
    tenantId: string,
    orderId: string,
  ): Promise<import("../contracts").OrderCommerceDetails>;
  listOrders(query: OrderListQuery): Promise<OrderListRow[]>;
}
