import { SupplierReceiptsResponseSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../../src/http/management-route";
import {
  SupplierPathSchema,
  SupplierPageQuerySchema,
} from "../../../../../../src/suppliers/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
export async function GET(request: Request, route: { params: Promise<{ supplierId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SupplierReceiptsResponseSchema,
    handler: async (context) =>
      boundary.suppliersService.receipts(
        context,
        parseRequest(SupplierPathSchema, await route.params).supplierId,
        parseRequest(
          SupplierPageQuerySchema,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
