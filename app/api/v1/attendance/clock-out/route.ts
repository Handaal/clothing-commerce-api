import {
  ClockOutRequestSchema,
  AttendanceClockResponseSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementBodyRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: ClockOutRequestSchema,
    responseSchema: AttendanceClockResponseSchema,
    handler: ({ context }) => boundary.attendanceService.clockOut(context),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
