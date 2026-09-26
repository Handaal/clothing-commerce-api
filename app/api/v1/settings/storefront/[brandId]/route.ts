import {
  StorefrontSettingsSchema,
  UpsertStorefrontSettingsRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { StorefrontPathSchema } from "../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ brandId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: StorefrontSettingsSchema,
    handler: async (context) =>
      boundary.settingsService.getStorefront(
        context,
        parseRequest(StorefrontPathSchema, await route.params).brandId,
      ),
  });
}

export async function PUT(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpsertStorefrontSettingsRequestSchema,
    responseSchema: StorefrontSettingsSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.settingsService.upsertStorefront(
        context,
        parseRequest(StorefrontPathSchema, await route.params).brandId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
