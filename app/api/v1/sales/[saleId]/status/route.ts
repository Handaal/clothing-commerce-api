import { SaleSchema, SetSaleStatusRequestSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { SalePathSchema } from "../../../../../../src/merchandising/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ saleId: string }> };

export async function POST(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetSaleStatusRequestSchema,
    responseSchema: SaleSchema,
    handler: async ({ context, body }) =>
      boundary.merchandisingService.setSaleStatus(
        context,
        parseRequest(SalePathSchema, await route.params).saleId,
        body.status,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
