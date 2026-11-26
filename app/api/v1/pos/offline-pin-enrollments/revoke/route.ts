import {
  RevokeOfflinePinEnrollmentsRequestSchema,
  RevokeOfflinePinEnrollmentsResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

/** Offline PIN v2: revoke enrollments (own, or anyone's / a device's with staff.manage). */
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: RevokeOfflinePinEnrollmentsRequestSchema,
    responseSchema: RevokeOfflinePinEnrollmentsResponseSchema,
    handler: ({ context, body }) =>
      boundary.offlinePosService.revokeOfflinePinEnrollments(context, body),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
