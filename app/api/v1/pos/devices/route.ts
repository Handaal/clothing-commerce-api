import {
  EnrollPosDeviceRequestSchema,
  PosDeviceResponseSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: EnrollPosDeviceRequestSchema,
    responseSchema: PosDeviceResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.offlinePosService.enrollDevice(context, body, idempotencyKey),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
