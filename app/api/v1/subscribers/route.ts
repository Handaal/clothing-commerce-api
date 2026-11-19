import { SubscriberListQuerySchema, SubscriberListResponseSchema } from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../src/http/management-route";
import { queryRecord } from "../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

// Storefront email sign-ups for the tenant, newest first (orders.read).
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SubscriberListResponseSchema,
    handler: (context) => {
      const url = new URL(request.url);
      const query = parseRequest(
        SubscriberListQuerySchema,
        queryRecord(url.searchParams, ["limit"]),
      );
      return boundary.subscriberService.list(context, query.limit);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
