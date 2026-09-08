import { z } from "zod";
import {
  PosDeviceResponseSchema,
  RotatePosDeviceCredentialRequestSchema,
} from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";

export async function POST(request: Request, route: { params: Promise<{ deviceId: string }> }) {
  const boundary = getManagementApiBoundary();
  const { deviceId } = await route.params;
  const parsedDeviceId = parseRequest(z.string().uuid(), deviceId);
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: RotatePosDeviceCredentialRequestSchema,
    responseSchema: PosDeviceResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.offlinePosService.rotateCredential(
        context,
        parsedDeviceId,
        body.registerId,
        body.publicKey.value,
        idempotencyKey,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
