import { BrandSchema, UpdateBrandRequestSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { BrandPathSchema } from "../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ brandId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: BrandSchema,
    handler: async (context) =>
      boundary.settingsService.getBrand(context, parseRequest(BrandPathSchema, await route.params).brandId),
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateBrandRequestSchema,
    responseSchema: BrandSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.settingsService.updateBrand(
        context,
        parseRequest(BrandPathSchema, await route.params).brandId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
