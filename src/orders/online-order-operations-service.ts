import type { AuthorizationContext } from "../authorization";
import type { CancelOrderRequest, FulfillOrderRequest, OrderDetailResponse } from "../contracts";
import { FulfillmentError } from "../fulfillments/errors";
import type { FulfillmentService } from "../fulfillments/fulfillment-service";
import type { OrderService } from "./order-service";
import type { OrdersReadService } from "./orders-read-service";

export interface ReservationLocationReader {
  getReservationLocations(
    tenantId: string,
    orderId: string,
  ): Promise<readonly { orderLineId: string; inventoryLocationId: string }[]>;
}

/**
 * Staff operations on ONLINE (Storefront) orders: fulfil and cancel. A thin orchestration over the
 * existing canonical services; it adds no new persistence or authority:
 *   - fulfil: FulfillmentService.createFulfillment (orders.fulfill on the order brand + inventory.issue
 *     on the location, idempotent, consumes the order stock reservations atomically);
 *   - cancel: OrderService.cancelOrder (orders.cancel; refused once any fulfillment exists; the database
 *     trigger releases the reservations and cancels the pending payment).
 * The stock location is never client-chosen: it is the location the order reservations hold stock at.
 * Both return the refreshed order detail so a client can redraw without a second round trip.
 */
export class OnlineOrderOperationsService {
  constructor(
    private readonly orderService: OrderService,
    private readonly fulfillmentService: FulfillmentService,
    private readonly ordersReadService: OrdersReadService,
    private readonly reservations: ReservationLocationReader,
  ) {}

  async fulfil(
    context: AuthorizationContext,
    orderId: string,
    idempotencyKey: string,
    request: FulfillOrderRequest,
  ): Promise<OrderDetailResponse> {
    // getOrder authorizes orders.read and maps a foreign/missing order to 404 before anything else.
    const order = await this.orderService.getOrder(context, { orderId });
    if (order.channel !== "online") throw new FulfillmentError("ORDER_CHANNEL_UNSUPPORTED");
    if (order.status === "cancelled") throw new FulfillmentError("ORDER_CANCELLED");

    const lineIdByNumber = new Map(order.lines.map((line) => [line.lineNumber, line.id]));
    const seen = new Set<number>();
    const lines = request.lines.map((line) => {
      const orderLineId = lineIdByNumber.get(line.lineNumber);
      if (orderLineId === undefined) throw new FulfillmentError("ORDER_LINE_NOT_FOUND");
      if (seen.has(line.lineNumber)) throw new FulfillmentError("INVALID_FULFILLMENT");
      seen.add(line.lineNumber);
      return { orderLineId, quantity: line.quantity };
    });

    const holds = await this.reservations.getReservationLocations(context.tenant.id, orderId);
    const locationByLine = new Map(holds.map((row) => [row.orderLineId, row.inventoryLocationId]));
    const locations = new Set(lines.map((line) => locationByLine.get(line.orderLineId)));
    const [inventoryLocationId] = [...locations];
    if (locations.size !== 1 || inventoryLocationId === undefined) {
      throw new FulfillmentError("FULFILLMENT_LOCATION_UNRESOLVED");
    }

    await this.fulfillmentService.createFulfillment(context, {
      orderId,
      inventoryLocationId,
      idempotencyKey,
      lines,
    });
    return this.ordersReadService.getOrder(context, orderId);
  }

  /**
   * Delivered + cash collected (cash on delivery). OrderService authorizes orders.fulfill on the brand
   * and the database refuses until every line has shipped; a repeat is a harmless replay.
   */
  async collectPayment(
    context: AuthorizationContext,
    orderId: string,
  ): Promise<OrderDetailResponse> {
    const order = await this.orderService.getOrder(context, { orderId });
    if (order.channel !== "online") throw new FulfillmentError("ORDER_CHANNEL_UNSUPPORTED");
    await this.orderService.collectCashOnDelivery(context, { orderId });
    return this.ordersReadService.getOrder(context, orderId);
  }

  async cancel(
    context: AuthorizationContext,
    orderId: string,
    request: CancelOrderRequest,
  ): Promise<OrderDetailResponse> {
    const order = await this.orderService.getOrder(context, { orderId });
    if (order.channel !== "online") throw new FulfillmentError("ORDER_CHANNEL_UNSUPPORTED");
    // cancel_order is idempotent (an already-cancelled order replays) and refuses fulfilled orders.
    await this.orderService.cancelOrder(context, {
      orderId,
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    });
    return this.ordersReadService.getOrder(context, orderId);
  }
}
