import {
  SetPosLoginPinRequestSchema,
  SetPosLoginPinResponseSchema,
} from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";
import { StaffPathSchema } from "../../../../../../../src/staff/request";

type RouteContext = { params: Promise<{ membershipId: string }> };

/** Reset (rotate) a pos_pin account's online PIN verifier. Idempotent (last write wins). Requires staff.manage. */
export async function PUT(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetPosLoginPinRequestSchema,
    responseSchema: SetPosLoginPinResponseSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.posAuthService.setPin(
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
