import { DeviceSchema, RevokeDeviceRequestSchema } from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { DevicePathSchema } from "../../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ deviceId: string }> };

export async function POST(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: RevokeDeviceRequestSchema,
    responseSchema: DeviceSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.settingsService.revokeDevice(
        context,
        parseRequest(DevicePathSchema, await route.params).deviceId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
