import {
  StorefrontSiteTextSchema,
  UpdateStorefrontSiteTextRequestSchema,
} from "../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

// Storefront site text (promo bar, home section titles, brand note, footer, SEO, contact, FAQ/Terms/
// Shipping pages). catalog.author tenant-wide. PUT replaces the whole document and is keyed for retries.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: StorefrontSiteTextSchema,
    handler: (context) => boundary.merchandisingService.getStorefrontSiteText(context),
  });
}

export async function PUT(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateStorefrontSiteTextRequestSchema,
    responseSchema: StorefrontSiteTextSchema,
    handler: ({ context, body }) =>
      boundary.merchandisingService.updateStorefrontSiteText(context, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
