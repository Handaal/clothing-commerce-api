import {
  AdjustmentListResponseSchema,
  AdjustmentSchema,
  CreateAdjustmentRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementBodyRoute,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { DateRangeQuerySchema } from "../../../../../src/attendance/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: AdjustmentListResponseSchema,
    handler: (context) =>
      boundary.attendanceService.listAdjustments(
        context,
        parseRequest(DateRangeQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateAdjustmentRequestSchema,
    responseSchema: AdjustmentSchema,
    handler: ({ context, body }) => boundary.attendanceService.createAdjustment(context, body),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
