import { PromotionsReportResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { PromotionsQuerySchema } from "../../../../../src/reporting/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: PromotionsReportResponseSchema,
    handler: (context) =>
      boundary.reportingService.promotions(
        context,
        parseRequest(PromotionsQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
