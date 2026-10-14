import { SupplierPurchaseItemsResponseSchema } from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";
import { SupplierPurchasePathSchema } from "../../../../../../../src/suppliers/request";

export async function GET(request: Request, route: { params: Promise<{ purchaseId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SupplierPurchaseItemsResponseSchema,
    handler: async (context) =>
      boundary.suppliersService.purchaseItems(
        context,
        parseRequest(SupplierPurchasePathSchema, await route.params).purchaseId,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
