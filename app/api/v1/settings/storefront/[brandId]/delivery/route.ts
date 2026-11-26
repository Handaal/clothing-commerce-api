import {
  StorefrontDeliverySettingsSchema,
  UpdateStorefrontDeliveryRequestSchema,
} from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { StorefrontPathSchema } from "../../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ brandId: string }> };

// Delivery areas + free-delivery threshold for the brand's Storefront (settings.read / settings.manage).
export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: StorefrontDeliverySettingsSchema,
    handler: async (context) =>
      boundary.settingsService.getStorefrontDelivery(
        context,
        parseRequest(StorefrontPathSchema, await route.params).brandId,
      ),
  });
}

// Replace the full zone list and threshold.
export async function PUT(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateStorefrontDeliveryRequestSchema,
    responseSchema: StorefrontDeliverySettingsSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.settingsService.updateStorefrontDelivery(
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
