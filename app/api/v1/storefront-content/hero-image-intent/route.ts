import {
  CreateStorefrontHeroImageIntentRequestSchema,
  StorefrontHeroImageIntentSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementBodyRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// Mints a server-chosen, tenant-scoped hero image destination ("<tenant>/storefront/<uuid>.<ext>") and,
// when Storage is reachable, a signed upload URL. No durable state change, so no Idempotency-Key.
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateStorefrontHeroImageIntentRequestSchema,
    responseSchema: StorefrontHeroImageIntentSchema,
    handler: ({ context, body }) =>
      boundary.merchandisingService.createHeroImageIntent(context, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
