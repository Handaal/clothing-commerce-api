import {
  EnrollOfflinePinRequestSchema,
  EnrollOfflinePinResponseSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementWriteRoute,
  POS_CREDENTIAL_MAX_BODY_BYTES,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

/**
 * Offline PIN v2: the authenticated caller enrols THEMSELVES on one device of the register. No PIN is sent;
 * the till derives and seals the device-bound verifier in its main process after this succeeds.
 */
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: EnrollOfflinePinRequestSchema,
    responseSchema: EnrollOfflinePinResponseSchema,
    maxBodyBytes: POS_CREDENTIAL_MAX_BODY_BYTES,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.offlinePosService.enrollOfflinePin(context, body, idempotencyKey),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
