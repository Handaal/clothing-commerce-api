import { PublicProductListResponseSchema } from "../../../../../src/contracts";
import { parseRequest } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../src/http/public-route";
import { StorefrontListQuerySchema, queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// PUBLIC: lists published products for the storefront's configured tenant (optionally narrowed to a
// brand). No session and no X-Tenant-Id header; the tenant is an explicit query parameter and only
// published, publicly sellable data is ever returned.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicReadRoute({
    request,
    responseSchema: PublicProductListResponseSchema,
    handler: () => {
      const url = new URL(request.url);
      const query = parseRequest(
        StorefrontListQuerySchema,
        queryRecord(url.searchParams, ["tenantId", "brandId", "limit"]),
      );
      return boundary.storefrontCatalogService.listPublishedProducts(
        query.tenantId,
        query.brandId ?? null,
        query.limit,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
