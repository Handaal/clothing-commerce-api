import { AttendanceListResponseSchema } from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../src/http/management-route";
import { AttendanceListQuerySchema } from "../../../../src/attendance/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: AttendanceListResponseSchema,
    handler: (context) =>
      boundary.attendanceService.list(
        context,
        parseRequest(AttendanceListQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
