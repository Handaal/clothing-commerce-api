import {
  InventoryLocationSchema,
  UpdateInventoryLocationRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { InventoryLocationPathSchema } from "../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ locationId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: InventoryLocationSchema,
    handler: async (context) =>
      boundary.settingsService.getInventoryLocation(
        context,
        parseRequest(InventoryLocationPathSchema, await route.params).locationId,
      ),
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateInventoryLocationRequestSchema,
    responseSchema: InventoryLocationSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.settingsService.updateInventoryLocation(
        context,
        parseRequest(InventoryLocationPathSchema, await route.params).locationId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
