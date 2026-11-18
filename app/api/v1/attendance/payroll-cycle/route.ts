import { PayrollCycleSettingsSchema } from "../../../../../src/contracts/management/payroll-cycle";
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
    responseSchema: PayrollCycleSettingsSchema,
    handler: (context) => boundary.attendanceService.getPayrollCycleSettings(context),
  });
}

export async function PUT(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: PayrollCycleSettingsSchema,
    responseSchema: PayrollCycleSettingsSchema,
    handler: ({ context, body }) =>
      boundary.attendanceService.setPayrollCycleSettings(context, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
