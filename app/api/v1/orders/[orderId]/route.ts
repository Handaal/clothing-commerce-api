import { OrderDetailResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { OrderPathSchema } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: OrderDetailResponseSchema,
    handler: async (context) => {
      const { orderId } = parseRequest(OrderPathSchema, await params);
      return boundary.ordersReadService.getOrder(context, orderId);
    },
  });
}

export function OPTIONS() {
  return managementOptionsResponse();
}
