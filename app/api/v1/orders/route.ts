import { OrderListResponseSchema } from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../src/http/management-route";
import { OrderListQuerySchema, queryRecord } from "../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: OrderListResponseSchema,
    handler: (context) => {
      const url = new URL(request.url);
      const query = parseRequest(
        OrderListQuerySchema,
        queryRecord(url.searchParams, [
          "channel",
          "brandId",
          "branchId",
          "status",
          "limit",
          "cursor",
        ]),
      );
      return boundary.ordersReadService.listOrders(context, {
        ...(query.channel !== undefined ? { channel: query.channel } : {}),
        ...(query.brandId !== undefined ? { brandId: query.brandId } : {}),
        ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
    },
  });
}

export function OPTIONS() {
  return managementOptionsResponse();
}
