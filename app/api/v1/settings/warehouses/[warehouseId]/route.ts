import { WarehouseSchema, UpdateWarehouseRequestSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { WarehousePathSchema } from "../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ warehouseId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: WarehouseSchema,
    handler: async (context) =>
      boundary.settingsService.getWarehouse(
        context,
        parseRequest(WarehousePathSchema, await route.params).warehouseId,
      ),
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateWarehouseRequestSchema,
    responseSchema: WarehouseSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.settingsService.updateWarehouse(
        context,
        parseRequest(WarehousePathSchema, await route.params).warehouseId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
