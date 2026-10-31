import {
  SetStaffOfflinePinRequestSchema,
  SetStaffOfflinePinResponseSchema,
} from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
import { StaffPathSchema } from "../../../../../../src/staff/request";

type RouteContext = { params: Promise<{ membershipId: string }> };

/**
 * Set or rotate a staff member's OFFLINE-unlock PIN — a credential independent of their Clerk online
 * password. Requires the same tenant-wide staff.manage grant as every staff mutation; the server seals the
 * PIN with its key before it ever reaches the database and the RPC enforces anti-escalation. PUT is used
 * because setting is idempotent (last write wins) and carries an Idempotency-Key for safe retries.
 */
export async function PUT(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetStaffOfflinePinRequestSchema,
    responseSchema: SetStaffOfflinePinResponseSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.offlinePosService.setOfflinePin(
        context,
        parseRequest(StaffPathSchema, await route.params).membershipId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
