import {
  StorefrontContentSchema,
  UpdateStorefrontContentRequestSchema,
} from "../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

// Storefront home-page content (hero + featured picks). catalog.author tenant-wide. PUT replaces the
// whole document (the editor always sends its full state) and is keyed for safe retries.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: StorefrontContentSchema,
    handler: (context) => boundary.merchandisingService.getStorefrontContent(context),
  });
}

export async function PUT(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateStorefrontContentRequestSchema,
    responseSchema: StorefrontContentSchema,
    handler: ({ context, body }) =>
      boundary.merchandisingService.updateStorefrontContent(context, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
