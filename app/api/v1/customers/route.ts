import { CustomerListResponseSchema } from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../src/http/management-route";
import { CustomerListQuerySchema, queryRecord } from "../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: CustomerListResponseSchema,
    handler: (context) => {
      const url = new URL(request.url);
      const query = parseRequest(
        CustomerListQuerySchema,
        queryRecord(url.searchParams, ["search", "limit", "cursor"]),
      );
      return boundary.customersReadService.listCustomers(context, {
        ...(query.search !== undefined ? { search: query.search } : {}),
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
