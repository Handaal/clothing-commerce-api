import {
  StaffDetailSchema,
  UpdateStaffProfileRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { StaffPathSchema } from "../../../../../../src/staff/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ membershipId: string }> };

export async function PUT(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateStaffProfileRequestSchema,
    responseSchema: StaffDetailSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.staffService.updateProfile(
        context,
        parseRequest(StaffPathSchema, await route.params).membershipId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
