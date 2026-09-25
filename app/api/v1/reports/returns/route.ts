import { ReturnsReportResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { ReturnsQuerySchema } from "../../../../../src/reporting/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: ReturnsReportResponseSchema,
    handler: (context) =>
      boundary.reportingService.returns(
        context,
        parseRequest(ReturnsQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
