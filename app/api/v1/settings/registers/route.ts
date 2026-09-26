import {
  RegisterSchema,
  RegisterListResponseSchema,
  CreateRegisterRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { RegisterListQuerySchema } from "../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: RegisterListResponseSchema,
    handler: (context) =>
      boundary.settingsService.listRegisters(
        context,
        parseRequest(RegisterListQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateRegisterRequestSchema,
    responseSchema: RegisterSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.settingsService.createRegister(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
