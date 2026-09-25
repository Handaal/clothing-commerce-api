import { ProductsReportResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { ProductsQuerySchema } from "../../../../../src/reporting/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: ProductsReportResponseSchema,
    handler: (context) =>
      boundary.reportingService.products(
        context,
        parseRequest(ProductsQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
