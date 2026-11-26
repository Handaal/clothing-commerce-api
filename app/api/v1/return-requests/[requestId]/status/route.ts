import { z } from "zod";

import {
  ReturnRequestSchema,
  UpdateReturnRequestStatusSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const PathSchema = z.object({ requestId: z.string().uuid() });

/** Approve, decline or complete a customer return request (returns.create in the order's brand).
 * Repeating the same status is a no-op, so a retried tap is safe. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateReturnRequestStatusSchema,
    responseSchema: ReturnRequestSchema,
    handler: async ({ context, body }) => {
      const { requestId } = parseRequest(PathSchema, await params);
      return boundary.afterPurchaseService.setStatus(context, requestId, body);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
