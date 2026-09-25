import { SalesReportResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { SalesQuerySchema } from "../../../../../src/reporting/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SalesReportResponseSchema,
    handler: (context) =>
      boundary.reportingService.sales(
        context,
        parseRequest(SalesQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
