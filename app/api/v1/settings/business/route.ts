import { BusinessSettingsSchema, UpdateBusinessRequestSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: BusinessSettingsSchema,
    handler: (context) => boundary.settingsService.getBusiness(context),
  });
}

export async function PATCH(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateBusinessRequestSchema,
    responseSchema: BusinessSettingsSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.settingsService.updateBusiness(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
