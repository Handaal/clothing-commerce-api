import { z } from "zod";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../../src/http/management-route";
import { AdjustmentPathSchema } from "../../../../../../src/attendance/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const DeletedSchema = z.object({ id: z.uuid() });
type RouteContext = { params: Promise<{ adjustmentId: string }> };

export async function DELETE(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: DeletedSchema,
    handler: async (context) =>
      boundary.attendanceService.removeAdjustment(
        context,
        parseRequest(AdjustmentPathSchema, await route.params).adjustmentId,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
