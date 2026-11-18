import { PublicStorefrontContentSchema } from "../../../../../src/contracts";
import { parseRequest } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../src/http/public-route";
import { StorefrontContentQuerySchema } from "../../../../../src/merchandising/request";
import { queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// PUBLIC: the Storefront home-page content (hero + featured products/collections) for an explicit
// tenant. Only publicly visible products and collections are returned, in the curated order.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicReadRoute({
    request,
    responseSchema: PublicStorefrontContentSchema,
    handler: () => {
      const url = new URL(request.url);
      const query = parseRequest(
        StorefrontContentQuerySchema,
        queryRecord(url.searchParams, ["tenantId", "brandId"]),
      );
      return boundary.merchandisingService.getPublicStorefrontContent(
        query.tenantId,
        query.brandId ?? null,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
