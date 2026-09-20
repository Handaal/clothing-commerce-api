import { z } from "zod";
import { ReturnDetailResponseSchema } from "../../../../../src/contracts/management/returns";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";
const PathSchema = z.object({ returnId: z.uuid() });
export async function GET(request: Request, { params }: { params: Promise<{ returnId: string }> }) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: ReturnDetailResponseSchema,
    handler: async (context) => {
      const { returnId } = parseRequest(PathSchema, await params);
      return boundary.returnsService.detail(context, returnId);
    },
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
