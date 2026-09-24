import {
  PromotionDetailSchema,
  SetPromotionStatusRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { PromotionPathSchema } from "../../../../../../src/promotions/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ promotionId: string }> };

export async function POST(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetPromotionStatusRequestSchema,
    responseSchema: PromotionDetailSchema,
    handler: async ({ context, body }) =>
      boundary.promotionsService.setStatus(
        context,
        parseRequest(PromotionPathSchema, await route.params).promotionId,
        body.status,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
