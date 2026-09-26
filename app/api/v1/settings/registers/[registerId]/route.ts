import { RegisterSchema, UpdateRegisterRequestSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { RegisterPathSchema } from "../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ registerId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: RegisterSchema,
    handler: async (context) =>
      boundary.settingsService.getRegister(
        context,
        parseRequest(RegisterPathSchema, await route.params).registerId,
      ),
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateRegisterRequestSchema,
    responseSchema: RegisterSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.settingsService.updateRegister(
        context,
        parseRequest(RegisterPathSchema, await route.params).registerId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
