import { PublicCollectionListResponseSchema } from "../../../../../src/contracts";
import { parseRequest } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../src/http/public-route";
import { StorefrontListQuerySchema, queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// PUBLIC: lists published collections for the storefront's configured tenant. No session and no
// X-Tenant-Id header; the tenant is an explicit query parameter and only active collections that own at
// least one publicly visible product are ever returned.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicReadRoute({
    request,
    responseSchema: PublicCollectionListResponseSchema,
    handler: () => {
      const url = new URL(request.url);
      const query = parseRequest(
        StorefrontListQuerySchema,
        queryRecord(url.searchParams, ["tenantId", "brandId", "limit"]),
      );
      return boundary.storefrontCollectionService.listPublishedCollections(
        query.tenantId,
        query.limit,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
