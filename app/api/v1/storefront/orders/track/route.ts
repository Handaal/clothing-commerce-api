import {
  StorefrontTrackOrderRequestSchema,
  StorefrontTrackedOrderSchema,
} from "../../../../../../src/contracts";
import { parseJsonBody } from "../../../../../../src/http/management-route";
import { publicOptionsResponse, runPublicRoute } from "../../../../../../src/http/public-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

// PUBLIC: look up an online order by its number + the phone used at checkout. POST so the phone never
// lands in a URL or access log. Wrong number and wrong phone answer the same ORDER_NOT_FOUND.
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicRoute({
    request,
    responseSchema: StorefrontTrackedOrderSchema,
    handler: async () => {
      const body = await parseJsonBody(request, StorefrontTrackOrderRequestSchema);
      return boundary.afterPurchaseService.track(body);
    },
  });
}

export function OPTIONS(request: Request) {
  return publicOptionsResponse(request);
}
