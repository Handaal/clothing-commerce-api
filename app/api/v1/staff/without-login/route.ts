import {
  CreateStaffWithoutLoginRequestSchema,
  StaffDetailSchema,
} from "../../../../../src/contracts/management/staff";
import {
  managementOptionsResponse,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateStaffWithoutLoginRequestSchema,
    responseSchema: StaffDetailSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.staffService.createWithoutLogin(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
