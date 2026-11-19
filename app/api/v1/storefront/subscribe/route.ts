import {
  StorefrontSubscribeRequestSchema,
  StorefrontSubscribeResponseSchema,
} from "../../../../../src/contracts";
import { parseJsonBody } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicRoute } from "../../../../../src/http/public-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// PUBLIC: add an email to the storefront's drop-alert list. Naturally idempotent (one row per email
// per tenant), and the answer is identical whether or not the address was already listed.
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicRoute({
    request,
    responseSchema: StorefrontSubscribeResponseSchema,
    handler: async () => {
      const body = await parseJsonBody(request, StorefrontSubscribeRequestSchema);
      return boundary.subscriberService.subscribe({
        tenantId: body.tenantId,
        email: body.email,
        ...(body.brandId ? { brandId: body.brandId } : {}),
        ...(body.source ? { source: body.source } : {}),
      });
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
