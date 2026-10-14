import type { OrderSummary } from "../contracts";
import type { CustomerCursorKey, OrderCursorKey } from "../management/cursor";

/** The persisted customer contact, tenant-scoped. */
export interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly email: string | null;
  readonly createdAt: string;
}

/** Lifetime aggregates over a customer's PLACED orders. */
export interface CustomerAggregate {
  readonly orderCount: number;
  readonly totalSpentMinor: number;
  readonly lastOrderAt: string | null;
  readonly currency: string | null;
}

export interface CustomerListParams {
  readonly tenantId: string;
  readonly search?: string;
  readonly fetchLimit: number;
  readonly cursor: CustomerCursorKey | null;
}

export interface CustomerListRow {
  readonly row: CustomerRow;
  readonly cursor: CustomerCursorKey;
}

export interface CustomerOrdersParams {
  readonly tenantId: string;
  readonly customerId: string;
  readonly fetchLimit: number;
  readonly cursor: OrderCursorKey | null;
}

export interface CustomerOrderListRow {
  readonly summary: OrderSummary;
  readonly cursor: OrderCursorKey;
}

export interface CustomersReadRepository {
  listCustomers(params: CustomerListParams): Promise<CustomerListRow[]>;
  getCustomer(tenantId: string, customerId: string): Promise<CustomerRow | null>;
  findByNormalizedPhone(tenantId: string, normalizedPhone: string): Promise<CustomerRow | null>;
  aggregatesFor(
    tenantId: string,
    customerIds: readonly string[],
  ): Promise<Map<string, CustomerAggregate>>;
  listCustomerOrders(params: CustomerOrdersParams): Promise<CustomerOrderListRow[]>;
}
