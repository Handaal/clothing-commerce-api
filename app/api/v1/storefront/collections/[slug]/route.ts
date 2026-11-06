import { z } from "zod";

import { PublicCollectionDetailResponseSchema } from "../../../../../../src/contracts";
import { parseRequest } from "../../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../../src/http/public-route";
import { queryRecord } from "../../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const CollectionDetailQuerySchema = z.object({ tenantId: z.string().uuid() });

// PUBLIC: a single published collection (by slug) with its ordered, publicly visible products.
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const boundary = getManagementApiBoundary();
  return runPublicReadRoute({
    request,
    responseSchema: PublicCollectionDetailResponseSchema,
    handler: async () => {
      const url = new URL(request.url);
      const query = parseRequest(
        CollectionDetailQuerySchema,
        queryRecord(url.searchParams, ["tenantId"]),
      );
      const { slug } = await params;
      return boundary.storefrontCollectionService.getPublishedCollection(query.tenantId, slug);
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
