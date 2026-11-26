import { z } from "zod";

import { PublicVendorListResponseSchema } from "../../../../../src/contracts";
import { parseRequest } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicReadRoute } from "../../../../../src/http/public-route";
import { queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

const StorefrontVendorsQuerySchema = z.object({ tenantId: z.string().uuid() });

// PUBLIC: the labels the storefront tenant sells that have publicly visible products ("shop by brand").
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicReadRoute({
    request,
    responseSchema: PublicVendorListResponseSchema,
    handler: () => {
      const url = new URL(request.url);
      const query = parseRequest(
        StorefrontVendorsQuerySchema,
        queryRecord(url.searchParams, ["tenantId"]),
      );
      return boundary.vendorService.listStorefrontVendors(query.tenantId);
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
