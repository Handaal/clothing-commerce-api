import { CustomerOrdersResponseSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../../src/http/management-route";
import {
  CustomerOrdersQuerySchema,
  CustomerPathSchema,
  queryRecord,
} from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: CustomerOrdersResponseSchema,
    handler: async (context) => {
      const { customerId } = parseRequest(CustomerPathSchema, await params);
      const url = new URL(request.url);
      const query = parseRequest(
        CustomerOrdersQuerySchema,
        queryRecord(url.searchParams, ["limit", "cursor"]),
      );
      return boundary.customersReadService.listCustomerOrders(context, customerId, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
