import { z } from "zod";
import {
  ReturnDetailResponseSchema as DetailSchema,
  SettleRefundRequestSchema,
} from "../../../../../../src/contracts/management/returns";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
const PathSchema = z.object({ returnId: z.uuid() });
export async function POST(
  request: Request,
  { params }: { params: Promise<{ returnId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SettleRefundRequestSchema,
    responseSchema: DetailSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const { returnId } = parseRequest(PathSchema, await params);
      return boundary.returnsService.settle(context, returnId, idempotencyKey, body);
    },
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
