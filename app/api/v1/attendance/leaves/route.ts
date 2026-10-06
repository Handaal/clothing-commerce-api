import { LeaveListResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { DateRangeQuerySchema } from "../../../../../src/attendance/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: LeaveListResponseSchema,
    handler: (context) =>
      boundary.attendanceService.listLeaves(
        context,
        parseRequest(DateRangeQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
