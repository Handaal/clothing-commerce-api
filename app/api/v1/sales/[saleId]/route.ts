import {
  DeleteSaleResponseSchema,
  SaleSchema,
  UpdateSaleRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { SalePathSchema } from "../../../../../src/merchandising/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ saleId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SaleSchema,
    handler: async (context) =>
      boundary.merchandisingService.getSale(
        context,
        parseRequest(SalePathSchema, await route.params).saleId,
      ),
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateSaleRequestSchema,
    responseSchema: SaleSchema,
    handler: async ({ context, body }) =>
      boundary.merchandisingService.updateSale(
        context,
        parseRequest(SalePathSchema, await route.params).saleId,
        body,
      ),
  });
}

export async function DELETE(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: DeleteSaleResponseSchema,
    handler: async (context) =>
      boundary.merchandisingService.deleteSale(
        context,
        parseRequest(SalePathSchema, await route.params).saleId,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
