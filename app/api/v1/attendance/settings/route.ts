import {
  PayrollSettingsSchema,
  UpdatePayrollSettingsRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementBodyRoute,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: PayrollSettingsSchema,
    handler: (context) => boundary.attendanceService.getPayrollSettings(context),
  });
}
export async function PUT(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdatePayrollSettingsRequestSchema,
    responseSchema: PayrollSettingsSchema,
    handler: ({ context, body }) => boundary.attendanceService.updatePayrollSettings(context, body),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
