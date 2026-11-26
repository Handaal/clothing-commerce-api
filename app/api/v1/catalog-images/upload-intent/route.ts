import {
  CatalogImageIntentSchema,
  CreateCatalogImageIntentRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementBodyRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// Server-chosen destination for a collection cover / category image (catalog.author tenant-wide). No
// durable state change, so no Idempotency-Key.
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateCatalogImageIntentRequestSchema,
    responseSchema: CatalogImageIntentSchema,
    handler: ({ context, body }) =>
      boundary.merchandisingService.createCatalogImageIntent(context, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
