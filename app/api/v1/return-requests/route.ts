import {
  ReturnRequestListQuerySchema,
  ReturnRequestListResponseSchema,
} from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../src/http/management-route";
import { queryRecord } from "../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

// Customer return requests from the Storefront, newest first (returns.read). Default: open ones.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: ReturnRequestListResponseSchema,
    handler: (context) => {
      const url = new URL(request.url);
      const query = parseRequest(
        ReturnRequestListQuerySchema,
        queryRecord(url.searchParams, ["status", "orderId", "limit"]),
      );
      return boundary.afterPurchaseService.list(context, query);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
