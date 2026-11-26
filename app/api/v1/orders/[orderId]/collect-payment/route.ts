import {
  CollectOrderPaymentRequestSchema,
  OrderDetailResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { OrderPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

/**
 * Delivered + cash collected for a fully shipped ONLINE cash-on-delivery order: captures its payment
 * (Idempotency-Key required; a repeat is a harmless replay). Returns the refreshed order detail.
 */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CollectOrderPaymentRequestSchema,
    responseSchema: OrderDetailResponseSchema,
    handler: async ({ context }) => {
      const { orderId } = parseRequest(OrderPathSchema, await params);
      return boundary.onlineOrderOperationsService.collectPayment(context, orderId);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
