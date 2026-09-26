import {
  WarehouseSchema,
  WarehouseListResponseSchema,
  CreateWarehouseRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { WarehouseListQuerySchema } from "../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: WarehouseListResponseSchema,
    handler: (context) =>
      boundary.settingsService.listWarehouses(
        context,
        parseRequest(WarehouseListQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateWarehouseRequestSchema,
    responseSchema: WarehouseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.settingsService.createWarehouse(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
