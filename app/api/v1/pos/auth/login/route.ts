import { PosLoginRequestSchema, PosLoginResponseSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  runPublicBodyRoute,
  POS_CREDENTIAL_MAX_BODY_BYTES,
} from "../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

/**
 * POS-native (pos_pin) connected sign-in. PUBLIC by nature: the username + PIN ARE the credential, verified
 * server-side against the online scrypt verifier. On success it returns a short-lived access token (an
 * `iss="pos"` JWT) the POS carries as a bearer token, plus the operator the POS renders. Unknown username
 * and wrong PIN collapse to one indistinguishable failure, with a durable per-username lockout.
 */
export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runPublicBodyRoute({
    request,
    requestSchema: PosLoginRequestSchema,
    responseSchema: PosLoginResponseSchema,
    maxBodyBytes: POS_CREDENTIAL_MAX_BODY_BYTES,
    handler: ({ body }) => boundary.posAuthService.login(body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
