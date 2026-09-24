import { PosQuoteRequestSchema, PosQuoteResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementBodyRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: PosQuoteRequestSchema,
    responseSchema: PosQuoteResponseSchema,
    handler: ({ context, body }) =>
      boundary.posSaleService.quote(context, {
        registerId: body.registerId,
        lines: body.lines,
        promotionCode: body.promotionCode ?? null,
      }),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
