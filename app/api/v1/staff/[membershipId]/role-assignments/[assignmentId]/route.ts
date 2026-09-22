import {
  StaffDetailSchema,
  UnassignStaffRoleRequestSchema,
} from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { StaffAssignmentPathSchema } from "../../../../../../../src/staff/request";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ membershipId: string; assignmentId: string }> };

export async function DELETE(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UnassignStaffRoleRequestSchema,
    responseSchema: StaffDetailSchema,
    handler: async ({ context, body, idempotencyKey }) => {
      const path = parseRequest(StaffAssignmentPathSchema, await route.params);
      return boundary.staffService.unassignRole(
        context,
        path.membershipId,
        path.assignmentId,
        idempotencyKey,
        body,
      );
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
