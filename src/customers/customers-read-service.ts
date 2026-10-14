import type { AuthorizationContext } from "../authorization";
import { AuthorizationError } from "../authorization/errors";
import type {
  CustomerDetailResponse,
  CustomerLookupResponse,
  CustomerSummary,
  OrderSummary,
  Paginated,
} from "../contracts";
import {
  decodeCustomerCursor,
  decodeOrderCursor,
  encodeCustomerCursor,
  encodeOrderCursor,
} from "../management/cursor";
import { ManagementNotFoundError } from "../management/errors";
import { buildPage } from "../management/pagination";
import { ManagementReadPermission } from "../management/visibility";
import type {
  CustomerAggregate,
  CustomerRow,
  CustomersReadRepository,
} from "./customers-read-repository";

export interface CustomerListParams {
  readonly search?: string;
  readonly limit: number;
  readonly cursor: string | null;
}

export interface CustomerOrdersParams {
  readonly limit: number;
  readonly cursor: string | null;
}

const EMPTY_AGGREGATE: CustomerAggregate = {
  orderCount: 0,
  totalSpentMinor: 0,
  lastOrderAt: null,
  currency: null,
};

/**
 * Customers read service. Customers are tenant-global commerce contacts (no brand/branch scope), so the
 * authorization gate is simply the commerce read permission (`orders.read`); there is no channel-split
 * visibility to apply. The list and detail attach lifetime order aggregates; order history reuses the
 * shared order summary shape.
 */
export class CustomersReadService {
  constructor(private readonly repository: CustomersReadRepository) {}

  private requireRead(context: AuthorizationContext): void {
    const permitted = context.assignments.some((assignment) =>
      assignment.permissionKeys.includes(ManagementReadPermission.orders),
    );
    if (!permitted) throw new AuthorizationError("PERMISSION_DENIED");
  }

  private toSummary(row: CustomerRow, aggregate: CustomerAggregate): CustomerSummary {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      createdAt: row.createdAt,
      orderCount: aggregate.orderCount,
      totalSpentMinor: aggregate.totalSpentMinor,
      lastOrderAt: aggregate.lastOrderAt,
      currency: aggregate.currency,
    };
  }

  async listCustomers(
    context: AuthorizationContext,
    params: CustomerListParams,
  ): Promise<Paginated<CustomerSummary>> {
    this.requireRead(context);
    const rows = await this.repository.listCustomers({
      tenantId: context.tenant.id,
      ...(params.search !== undefined ? { search: params.search } : {}),
      fetchLimit: params.limit + 1,
      cursor: params.cursor !== null ? decodeCustomerCursor(params.cursor) : null,
    });
    const aggregates = await this.repository.aggregatesFor(
      context.tenant.id,
      rows.map((entry) => entry.row.id),
    );
    return buildPage(
      rows,
      params.limit,
      (entry) => this.toSummary(entry.row, aggregates.get(entry.row.id) ?? EMPTY_AGGREGATE),
      (entry) => encodeCustomerCursor(entry.cursor),
    );
  }

  async getCustomer(
    context: AuthorizationContext,
    customerId: string,
  ): Promise<CustomerDetailResponse> {
    this.requireRead(context);
    const row = await this.repository.getCustomer(context.tenant.id, customerId);
    if (row === null) throw new ManagementNotFoundError();
    const aggregates = await this.repository.aggregatesFor(context.tenant.id, [row.id]);
    return this.toSummary(row, aggregates.get(row.id) ?? EMPTY_AGGREGATE);
  }

  async lookupByPhone(
    context: AuthorizationContext,
    phone: string,
  ): Promise<CustomerLookupResponse> {
    this.requireRead(context);
    const normalized = phone.replace(/[^+0-9]/g, "");
    if (!/^\+[1-9][0-9]{6,14}$/.test(normalized)) return { customer: null };
    const row = await this.repository.findByNormalizedPhone(context.tenant.id, normalized);
    if (row === null) return { customer: null };
    const aggregates = await this.repository.aggregatesFor(context.tenant.id, [row.id]);
    return { customer: this.toSummary(row, aggregates.get(row.id) ?? EMPTY_AGGREGATE) };
  }

  async listCustomerOrders(
    context: AuthorizationContext,
    customerId: string,
    params: CustomerOrdersParams,
  ): Promise<Paginated<OrderSummary>> {
    this.requireRead(context);
    const customer = await this.repository.getCustomer(context.tenant.id, customerId);
    if (customer === null) throw new ManagementNotFoundError();
    const rows = await this.repository.listCustomerOrders({
      tenantId: context.tenant.id,
      customerId,
      fetchLimit: params.limit + 1,
      cursor: params.cursor !== null ? decodeOrderCursor(params.cursor) : null,
    });
    return buildPage(
      rows,
      params.limit,
      (entry) => entry.summary,
      (entry) => encodeOrderCursor(entry.cursor),
    );
  }
}
