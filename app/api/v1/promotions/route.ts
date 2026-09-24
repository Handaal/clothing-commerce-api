import {
  CreatePromotionRequestSchema,
  PromotionDetailSchema,
  PromotionListResponseSchema,
} from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../src/http/management-route";
import { PromotionListQuerySchema } from "../../../../src/promotions/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: PromotionListResponseSchema,
    handler: (context) =>
      boundary.promotionsService.list(
        context,
        parseRequest(
          PromotionListQuerySchema,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
  });
}
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreatePromotionRequestSchema,
    responseSchema: PromotionDetailSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.promotionsService.create(context, idempotencyKey, body),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
