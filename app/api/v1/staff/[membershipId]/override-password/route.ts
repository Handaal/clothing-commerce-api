import { PosOverridePasswordResponseSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";
import { StaffPathSchema } from "../../../../../../src/staff/request";
import { z } from "zod";

type RouteContext = { params: Promise<{ membershipId: string }> };

/** ADR-042 D-6: clear a staff member's POS override password (staff.manage). Never reads or sets it. */
export async function DELETE(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: z.object({}).strict(),
    responseSchema: PosOverridePasswordResponseSchema,
    handler: async ({ context, idempotencyKey }) =>
      boundary.offlinePosService.clearOverridePassword(
        context,
        parseRequest(StaffPathSchema, await route.params).membershipId,
        idempotencyKey,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
