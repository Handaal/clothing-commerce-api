import {
  PromotionChannelPoliciesResponseSchema,
  UpsertPromotionChannelPolicyRequestSchema,
} from "../../../../../../../src/contracts/management/promotions";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";
import { PromotionPathSchema } from "../../../../../../../src/promotions/request";

type RouteContext = { params: Promise<{ promotionId: string; channel: string }> };

/** ADR-042 §5: set the voucher's limit (and POS offline terms) for one channel. */
export async function PUT(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpsertPromotionChannelPolicyRequestSchema,
    responseSchema: PromotionChannelPoliciesResponseSchema,
    handler: async ({ context, body }) => {
      const params = await route.params;
      return boundary.promotionsService.upsertChannelPolicy(
        context,
        parseRequest(PromotionPathSchema, { promotionId: params.promotionId }).promotionId,
        params.channel,
        body,
      );
    },
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
