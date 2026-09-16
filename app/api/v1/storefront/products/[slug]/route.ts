import { PublicProductDetailResponseSchema } from "../../../../../../src/contracts";
import { parseRequest } from "../../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../../src/http/public-route";
import {
  StorefrontContextQuerySchema,
  StorefrontProductSlugPathSchema,
  queryRecord,
} from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

// PUBLIC: returns a single published product by slug for the storefront's configured tenant. A missing
// or unpublished product is a 404. Only published, publicly sellable data is ever returned.
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const boundary = getManagementApiBoundary();
  return runPublicReadRoute({
    request,
    responseSchema: PublicProductDetailResponseSchema,
    handler: async () => {
      const url = new URL(request.url);
      const query = parseRequest(
        StorefrontContextQuerySchema,
        queryRecord(url.searchParams, ["tenantId"]),
      );
      const { slug } = parseRequest(StorefrontProductSlugPathSchema, await params);
      return boundary.storefrontCatalogService.getPublishedProduct(query.tenantId, slug);
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
