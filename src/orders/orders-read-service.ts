import type { AuthorizationContext } from "../authorization";
import { AuthorizationError } from "../authorization/errors";
import type { OrderDetailResponse, OrderSummary, Paginated } from "../contracts";
import type { OrderFulfillmentSummary } from "../fulfillments/model";
import type { FulfillmentService } from "../fulfillments/fulfillment-service";
import { decodeOrderCursor, encodeOrderCursor } from "../management/cursor";
import { normalizeTimestampUtc } from "../management/db-serialization";
import { ManagementNotFoundError } from "../management/errors";
import { buildPage, emptyPage } from "../management/pagination";
import { ManagementReadPermission, deriveOrderReadVisibility } from "../management/visibility";
import type { OrderResult } from "./model";
import type { OrderService } from "./order-service";
import type { OrdersReadRepository } from "./orders-read-repository";
import type { OrderChannel, OrderStatus } from "../contracts";

export interface OrderListParams {
  readonly channel?: OrderChannel;
  readonly brandId?: string;
  readonly branchId?: string;
  readonly status?: OrderStatus;
  readonly limit: number;
  readonly cursor: string | null;
}

/**
 * Orders read application service for the management API. The list derives channel-split order
 * visibility and enforces the 404-then-403 containment sequence for explicit brand/branch filters. The
 * detail composes exactly one Order (OrderService.getOrder, which performs its own routing +
 * authorization) with its FulfillmentService progress summary â€” never exposing inventory-operation ids,
 * idempotency, fingerprints, or routing internals.
 */
export class OrdersReadService {
  constructor(
    private readonly repository: OrdersReadRepository,
    private readonly orderService: OrderService,
    private readonly fulfillmentService: FulfillmentService,
  ) {}

  async listOrders(
    context: AuthorizationContext,
    params: OrderListParams,
  ): Promise<Paginated<OrderSummary>> {
    const cursorKey = params.cursor !== null ? decodeOrderCursor(params.cursor) : null;

    const visibility = deriveOrderReadVisibility(context);
    const hasPermission = context.assignments.some((assignment) =>
      assignment.permissionKeys.includes(ManagementReadPermission.orders),
    );

    const hasExplicitFilter = params.brandId !== undefined || params.branchId !== undefined;

    if (params.brandId !== undefined) {
      const exists = await this.repository.brandExistsInTenant(context.tenant.id, params.brandId);
      if (!exists) {
        throw new ManagementNotFoundError();
      }
      const authorized =
        hasPermission && (visibility.tenantWide || visibility.brandIds.includes(params.brandId));
      if (!authorized) {
        throw new AuthorizationError(hasPermission ? "SCOPE_DENIED" : "PERMISSION_DENIED");
      }
    }

    if (params.branchId !== undefined) {
      const exists = await this.repository.branchExistsInTenant(context.tenant.id, params.branchId);
      if (!exists) {
        throw new ManagementNotFoundError();
      }
      const authorized =
        hasPermission && (visibility.tenantWide || visibility.branchIds.includes(params.branchId));
      if (!authorized) {
        throw new AuthorizationError(hasPermission ? "SCOPE_DENIED" : "PERMISSION_DENIED");
      }
    }

    if (!hasExplicitFilter) {
      if (!hasPermission) {
        throw new AuthorizationError("PERMISSION_DENIED");
      }
      if (!visibility.canRead) {
        return emptyPage();
      }
    }

    const rows = await this.repository.listOrders({
      tenantId: context.tenant.id,
      visibility,
      filters: {
        ...(params.channel !== undefined ? { channel: params.channel } : {}),
        ...(params.brandId !== undefined ? { brandId: params.brandId } : {}),
        ...(params.branchId !== undefined ? { branchId: params.branchId } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
      },
      fetchLimit: params.limit + 1,
      cursor: cursorKey,
    });

    return buildPage(
      rows,
      params.limit,
      (row) => row.summary,
      (row) => encodeOrderCursor(row.cursor),
    );
  }

  async getOrder(context: AuthorizationContext, orderId: string): Promise<OrderDetailResponse> {
    // OrderService.getOrder performs its own tenant-filtered routing and orders.read authorization: a
    // foreign/missing order surfaces as OrderError ORDER_NOT_FOUND (404); an out-of-scope in-tenant
    // order surfaces as AuthorizationError (403).
    const order = await this.orderService.getOrder(context, { orderId });
    const summary = await this.fulfillmentService.getOrderFulfillmentSummary(context, { orderId });
    const commerce = await this.repository.getCommerceDetails(context.tenant.id, orderId);
    return { ...this.mapDetail(order, summary), commerce };
  }

  private mapDetail(order: OrderResult, summary: OrderFulfillmentSummary): OrderDetailResponse {
    const lineNumberByOrderLineId = new Map(order.lines.map((line) => [line.id, line.lineNumber]));

    return {
      header: {
        id: order.id,
        orderNumber: order.orderNumber,
        channel: order.channel,
        status: order.status,
        brandId: order.brandId,
        branchId: order.branchId,
        currency: order.currency,
        totalMinor: order.totalMinor,
        placedAt: normalizeTimestampUtc(order.placedAt),
      },
      lines: order.lines.map((line) => ({
        lineNumber: line.lineNumber,
        variantId: line.variantId,
        productName: line.productName,
        sku: line.sku,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.lineTotalMinor,
      })),
      cancellation:
        order.cancelledAt !== null
          ? {
              cancelledAt: normalizeTimestampUtc(order.cancelledAt),
              reason: order.cancellationReason,
            }
          : null,
      fulfillmentProgress: {
        status: summary.status,
        lines: summary.lines.map((line) => {
          const lineNumber = lineNumberByOrderLineId.get(line.orderLineId);
          if (lineNumber === undefined) {
            throw new Error("A fulfillment summary line does not match an order line.");
          }
          return {
            lineNumber,
            variantId: line.variantId,
            orderedQuantity: line.orderedQuantity,
            fulfilledQuantity: line.fulfilledQuantity,
            status: line.status,
          };
        }),
      },
    };
  }
}
