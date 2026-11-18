import { PayrollDueSchema } from "../../../../../../src/contracts/management/payroll-cycle";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: PayrollDueSchema,
    handler: (context) => boundary.attendanceService.payrollDue(context),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
