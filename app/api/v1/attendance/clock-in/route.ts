import { ClockInRequestSchema, AttendanceClockResponseSchema } from "../../../../../src/contracts";
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
    requestSchema: ClockInRequestSchema,
    responseSchema: AttendanceClockResponseSchema,
    handler: ({ context, body }) => boundary.attendanceService.clockIn(context, body),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
