import { z } from "zod";
import {
  AttendanceClockResponseSchema,
  UpdateAttendanceEntryRequestSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementBodyRoute,
  runTenantManagementRoute,
} from "../../../../../../src/http/management-route";
import { AttendanceEntryPathSchema } from "../../../../../../src/attendance/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

const DeletedSchema = z.object({ id: z.uuid() });
type RouteContext = { params: Promise<{ entryId: string }> };

export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateAttendanceEntryRequestSchema,
    responseSchema: AttendanceClockResponseSchema,
    handler: async ({ context, body }) =>
      boundary.attendanceService.updateEntry(
        context,
        parseRequest(AttendanceEntryPathSchema, await route.params).entryId,
        body,
      ),
  });
}
export async function DELETE(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: DeletedSchema,
    handler: async (context) =>
      boundary.attendanceService.removeEntry(
        context,
        parseRequest(AttendanceEntryPathSchema, await route.params).entryId,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
