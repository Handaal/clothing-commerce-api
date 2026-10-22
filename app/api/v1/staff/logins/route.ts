import { CreateStaffLoginRequestSchema, StaffDetailSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

/**
 * Provision an email-less staff LOGIN and link it as active staff in one idempotent step. This is the
 * onboarding path for POS floor staff who have no email: the server mints the external account, records the
 * verified provider binding, creates the membership, and assigns the initial role+scope. Requires the same
 * tenant-wide staff.manage grant as every other staff mutation.
 */
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateStaffLoginRequestSchema,
    responseSchema: StaffDetailSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.staffService.createLogin(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
