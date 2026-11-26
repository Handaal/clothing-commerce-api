import {
  PromotionChannelPoliciesResponseSchema,
  UpsertPromotionCodeChannelLimitRequestSchema,
} from "../../../../../../../../src/contracts/management/promotions";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../../../src/management/server-management-boundary";
import { PromotionCodePathSchema } from "../../../../../../../../src/promotions/request";

type RouteContext = { params: Promise<{ codeId: string; channel: string }> };

/** ADR-042 §5: a code's own per-channel usage limit. */
export async function PUT(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpsertPromotionCodeChannelLimitRequestSchema,
    responseSchema: PromotionChannelPoliciesResponseSchema,
    handler: async ({ context, body }) => {
      const params = await route.params;
      return boundary.promotionsService.upsertCodeChannelLimit(
        context,
        parseRequest(PromotionCodePathSchema, { codeId: params.codeId }).codeId,
        params.channel,
        body,
      );
    },
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
