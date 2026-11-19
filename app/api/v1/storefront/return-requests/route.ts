import {
  StorefrontReturnRequestResponseSchema,
  StorefrontReturnRequestSchema,
} from "../../../../../src/contracts";
import { parseJsonBody } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicRoute } from "../../../../../src/http/public-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// PUBLIC: a shopper asks to return delivered items (order number + checkout phone). Opens a request for
// staff; moves no stock or money.
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicRoute({
    request,
    responseSchema: StorefrontReturnRequestResponseSchema,
    handler: async () => {
      const body = await parseJsonBody(request, StorefrontReturnRequestSchema);
      return boundary.afterPurchaseService.requestReturn(body);
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
