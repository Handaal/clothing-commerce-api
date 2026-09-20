import { z } from "zod";
import { ReturnEligibilityResponseSchema } from "../../../../../../src/contracts/management/returns";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
const PathSchema = z.object({ orderId: z.uuid() });
export async function GET(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: ReturnEligibilityResponseSchema,
    handler: async (context) => {
      const { orderId } = parseRequest(PathSchema, await params);
      return boundary.returnsService.eligibility(context, orderId);
    },
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
