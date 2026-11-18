import { z } from "zod";

import { PublicCategoryListResponseSchema } from "../../../../../src/contracts";
import { parseRequest } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../src/http/public-route";
import { queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

const StorefrontCategoriesQuerySchema = z.object({ tenantId: z.string().uuid() });

// PUBLIC: the storefront tenant's category tree (active categories with publicly visible products).
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicReadRoute({
    request,
    responseSchema: PublicCategoryListResponseSchema,
    handler: () => {
      const url = new URL(request.url);
      const query = parseRequest(
        StorefrontCategoriesQuerySchema,
        queryRecord(url.searchParams, ["tenantId"]),
      );
      return boundary.categoryService.listStorefrontCategories(query.tenantId);
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
