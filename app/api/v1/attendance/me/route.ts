import { MyAttendanceResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { MyAttendanceQuerySchema } from "../../../../../src/attendance/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: MyAttendanceResponseSchema,
    handler: (context) =>
      boundary.attendanceService.mine(
        context,
        parseRequest(MyAttendanceQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
