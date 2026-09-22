import { StaffDetailSchema, UpdateStaffStatusRequestSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { StaffPathSchema } from "../../../../../src/staff/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ membershipId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: StaffDetailSchema,
    handler: async (context) =>
      boundary.staffService.detail(
        context,
        parseRequest(StaffPathSchema, await route.params).membershipId,
      ),
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateStaffStatusRequestSchema,
    responseSchema: StaffDetailSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.staffService.updateStatus(
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
