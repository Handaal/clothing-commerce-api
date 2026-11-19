import {
  StorefrontReturnPolicyQuerySchema,
  StorefrontReturnPolicySchema,
} from "../../../../../src/contracts";
import { parseRequest } from "../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicRoute } from "../../../../../src/http/public-route";
import { queryRecord } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// PUBLIC: whether the store accepts returns and its admin-editable return window, for website copy.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicRoute({
    request,
    responseSchema: StorefrontReturnPolicySchema,
    handler: () => {
      const url = new URL(request.url);
      const query = parseRequest(
        StorefrontReturnPolicyQuerySchema,
        queryRecord(url.searchParams, ["tenantId"]),
      );
      return boundary.afterPurchaseService.returnPolicy(query.tenantId);
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
