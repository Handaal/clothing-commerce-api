import {
  PosOverridePasswordResponseSchema,
  SetPosOverridePasswordRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementWriteRoute,
  POS_CREDENTIAL_MAX_BODY_BYTES,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

/**
 * ADR-042 D-6: set or change the caller's OWN POS override password (separate from the sign-in PIN). The
 * caller re-enters their POS username + PIN; the server seals the password and never returns it.
 */
export async function PUT(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetPosOverridePasswordRequestSchema,
    responseSchema: PosOverridePasswordResponseSchema,
    maxBodyBytes: POS_CREDENTIAL_MAX_BODY_BYTES,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.offlinePosService.setOverridePassword(context, idempotencyKey, body),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
