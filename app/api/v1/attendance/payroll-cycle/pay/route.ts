import {
  MarkPayrollPaidRequestSchema,
  PayrollDueSchema,
} from "../../../../../../src/contracts/management/payroll-cycle";
import {
  managementOptionsResponse,
  runTenantManagementBodyRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementBodyRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: MarkPayrollPaidRequestSchema,
    responseSchema: PayrollDueSchema,
    handler: ({ context, body }) => boundary.attendanceService.markPayrollPaid(context, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
