import { z } from "zod";

import { PublicStorefrontSiteTextSchema } from "../../../../../src/contracts";
import { parseRequest } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../src/http/public-route";
import { queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

const QuerySchema = z.object({ tenantId: z.string().uuid() });

// PUBLIC: the Storefront's editable site text for an explicit tenant. Missing keys mean "use the
// website's built-in text"; unknown or inactive tenants read an empty document.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicReadRoute({
    request,
    responseSchema: PublicStorefrontSiteTextSchema,
    handler: () => {
      const url = new URL(request.url);
      const query = parseRequest(QuerySchema, queryRecord(url.searchParams, ["tenantId"]));
      return boundary.merchandisingService.getPublicStorefrontSiteText(query.tenantId);
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
