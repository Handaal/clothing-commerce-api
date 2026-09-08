import {
  OfflineBootstrapRequestSchema,
  OfflineBootstrapResponseSchema,
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
    requestSchema: OfflineBootstrapRequestSchema,
    responseSchema: OfflineBootstrapResponseSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.offlinePosService.createBootstrap(
        context,
        body.deviceId,
        body.registerId,
        idempotencyKey,
      ),
  });
}
export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
