import {
  FulfillOrderRequestSchema,
  OrderDetailResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { OrderPathSchema } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

/** Fulfil lines of an ONLINE order from its reserved stock location (Idempotency-Key required). */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: FulfillOrderRequestSchema,
    responseSchema: OrderDetailResponseSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { orderId } = parseRequest(OrderPathSchema, await params);
      return boundary.onlineOrderOperationsService.fulfil(context, orderId, idempotencyKey, body);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
