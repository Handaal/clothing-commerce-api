import { PromotionChannelPoliciesResponseSchema } from "../../../../../../src/contracts/management/promotions";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
import { PromotionPathSchema } from "../../../../../../src/promotions/request";

type RouteContext = { params: Promise<{ promotionId: string }> };

/** ADR-042 §5: the voucher's per-channel limits and POS offline terms. */
export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: PromotionChannelPoliciesResponseSchema,
    handler: async (context) =>
      boundary.promotionsService.channelPolicies(
        context,
        parseRequest(PromotionPathSchema, await route.params).promotionId,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
