import {
  PromotionDetailSchema,
  SetPromotionCodeStatusRequestSchema,
} from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { PromotionCodePathSchema } from "../../../../../../../src/promotions/request";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ codeId: string }> };

export async function POST(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetPromotionCodeStatusRequestSchema,
    responseSchema: PromotionDetailSchema,
    handler: async ({ context, body }) =>
      boundary.promotionsService.setCodeStatus(
        context,
        parseRequest(PromotionCodePathSchema, await route.params).codeId,
        body.status,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
