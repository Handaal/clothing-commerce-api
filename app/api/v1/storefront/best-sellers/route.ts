import { z } from "zod";

import { PublicBestSellersResponseSchema } from "../../../../../src/contracts";
import { parseRequest } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../src/http/public-route";
import { queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

const BestSellersQuerySchema = z.object({
  tenantId: z.string().uuid(),
  brandId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).optional().default(90),
  limit: z.coerce.number().int().min(1).max(50).optional().default(12),
});

// PUBLIC: publicly visible products ranked by recent units sold (ids only, best first).
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicReadRoute({
    request,
    responseSchema: PublicBestSellersResponseSchema,
    handler: () => {
      const url = new URL(request.url);
      const query = parseRequest(
        BestSellersQuerySchema,
        queryRecord(url.searchParams, ["tenantId", "brandId", "days", "limit"]),
      );
      return boundary.storefrontCatalogService.listBestSellers(
        query.tenantId,
        query.brandId ?? null,
        query.days,
        query.limit,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
