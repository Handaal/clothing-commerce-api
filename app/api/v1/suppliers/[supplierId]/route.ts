import { UpdateSupplierRequestSchema, SupplierSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { SupplierPathSchema } from "../../../../../src/suppliers/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";
type RouteContext = { params: Promise<{ supplierId: string }> };
export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: SupplierSchema,
    handler: async (context) =>
      boundary.suppliersService.detail(
        context,
        parseRequest(SupplierPathSchema, await route.params).supplierId,
      ),
  });
}
export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateSupplierRequestSchema,
    responseSchema: SupplierSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.suppliersService.update(
        context,
        parseRequest(SupplierPathSchema, await route.params).supplierId,
        idempotencyKey,
        body,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
