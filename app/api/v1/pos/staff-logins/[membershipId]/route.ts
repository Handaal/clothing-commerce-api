import { StaffDetailSchema, UpdatePosLoginRequestSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
import { StaffPathSchema } from "../../../../../../src/staff/request";

type RouteContext = { params: Promise<{ membershipId: string }> };

/**
 * Update a pos_pin account's cafe-style POS UI access (display name + posRole + posPermissions). Membership
 * lifecycle (activate/suspend/deactivate) stays on the existing staff status path. Requires staff.manage.
 */
export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdatePosLoginRequestSchema,
    responseSchema: StaffDetailSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.posAuthService.updateLogin(
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
