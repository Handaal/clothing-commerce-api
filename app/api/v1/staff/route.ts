import {
  CreateStaffRequestSchema,
  StaffDetailSchema,
  StaffListResponseSchema,
} from "../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../src/http/management-route";
import { StaffListQuerySchema } from "../../../../src/staff/request";
import { getManagementApiBoundary } from "../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: StaffListResponseSchema,
    handler: (context) =>
      boundary.staffService.list(
        context,
        parseRequest(StaffListQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateStaffRequestSchema,
    responseSchema: StaffDetailSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.staffService.create(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
