import { CustomerLookupResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { CustomerLookupQuerySchema, queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: CustomerLookupResponseSchema,
    handler: (context) => {
      const url = new URL(request.url);
      const query = parseRequest(
        CustomerLookupQuerySchema,
        queryRecord(url.searchParams, ["phone"]),
      );
      return boundary.customersReadService.lookupByPhone(context, query.phone);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
