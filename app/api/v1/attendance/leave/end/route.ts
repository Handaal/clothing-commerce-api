import { LeaveClockResponseSchema, LeaveEndRequestSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementBodyRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: LeaveEndRequestSchema,
    responseSchema: LeaveClockResponseSchema,
    handler: ({ context }) => boundary.attendanceService.leaveEnd(context),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
