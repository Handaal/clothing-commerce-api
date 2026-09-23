import { PromotionDetailSchema, UpdatePromotionRequestSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { PromotionPathSchema } from "../../../../../src/promotions/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ promotionId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: PromotionDetailSchema,
    handler: async (context) =>
      boundary.promotionsService.detail(
        context,
        parseRequest(PromotionPathSchema, await route.params).promotionId,
      ),
  });
}
export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdatePromotionRequestSchema,
    responseSchema: PromotionDetailSchema,
    handler: async ({ context, body }) =>
      boundary.promotionsService.update(
        context,
        parseRequest(PromotionPathSchema, await route.params).promotionId,
        body,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
