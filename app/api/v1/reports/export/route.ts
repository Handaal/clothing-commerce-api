import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementDocumentRoute,
} from "../../../../../src/http/management-route";
import { ExportQuerySchema } from "../../../../../src/reporting/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementDocumentRoute({
    request,
    contextResolver: boundary.contextResolver,
    handler: (context) =>
      boundary.reportingService.export(
        context,
        parseRequest(ExportQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
