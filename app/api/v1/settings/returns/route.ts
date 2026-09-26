import { ReturnSettingsSchema, UpdateReturnSettingsRequestSchema } from "../../../../../src/contracts";
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
    responseSchema: ReturnSettingsSchema,
    handler: (context) => boundary.settingsService.getReturnSettings(context),
  });
}

export async function PUT(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateReturnSettingsRequestSchema,
    responseSchema: ReturnSettingsSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.settingsService.updateReturnSettings(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
