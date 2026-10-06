import {
  EmployeeCompensationSchema,
  SetCompensationRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementBodyRoute,
  runTenantManagementRoute,
} from "../../../../../../src/http/management-route";
import { MembershipPathSchema } from "../../../../../../src/attendance/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ membershipId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: EmployeeCompensationSchema.nullable(),
    handler: async (context) =>
      boundary.attendanceService.getCompensation(
        context,
        parseRequest(MembershipPathSchema, await route.params).membershipId,
      ),
  });
}
export async function PUT(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetCompensationRequestSchema,
    responseSchema: EmployeeCompensationSchema,
    handler: async ({ context, body }) =>
      boundary.attendanceService.setCompensation(
        context,
        parseRequest(MembershipPathSchema, await route.params).membershipId,
        body,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
