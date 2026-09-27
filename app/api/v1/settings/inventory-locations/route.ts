import {
  InventoryLocationSchema,
  InventoryLocationListResponseSchema,
  CreateInventoryLocationRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { InventoryLocationListQuerySchema } from "../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: InventoryLocationListResponseSchema,
    handler: (context) =>
      boundary.settingsService.listInventoryLocations(
        context,
        parseRequest(
          InventoryLocationListQuerySchema,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateInventoryLocationRequestSchema,
    responseSchema: InventoryLocationSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.settingsService.createInventoryLocation(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
