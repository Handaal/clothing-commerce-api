import { DeviceSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../../src/http/management-route";
import { DevicePathSchema } from "../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ deviceId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: DeviceSchema,
    handler: async (context) =>
      boundary.settingsService.getDevice(
        context,
        parseRequest(DevicePathSchema, await route.params).deviceId,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
