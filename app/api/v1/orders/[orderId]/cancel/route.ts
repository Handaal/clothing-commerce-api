import {
  CancelOrderRequestSchema,
  OrderDetailResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { OrderPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

/** Cancel an unfulfilled ONLINE order; releases its stock reservations (Idempotency-Key required). */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CancelOrderRequestSchema,
    responseSchema: OrderDetailResponseSchema,
    handler: async ({ context, body }) => {
      const { orderId } = parseRequest(OrderPathSchema, await params);
      return boundary.onlineOrderOperationsService.cancel(context, orderId, body);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
