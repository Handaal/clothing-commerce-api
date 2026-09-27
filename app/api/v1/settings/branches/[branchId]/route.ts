import { BranchSchema, UpdateBranchRequestSchema } from "../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../../src/http/management-route";
import { BranchPathSchema } from "../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ branchId: string }> };

export async function GET(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: BranchSchema,
    handler: async (context) =>
      boundary.settingsService.getBranch(
        context,
        parseRequest(BranchPathSchema, await route.params).branchId,
      ),
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: UpdateBranchRequestSchema,
    responseSchema: BranchSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.settingsService.updateBranch(
        context,
        parseRequest(BranchPathSchema, await route.params).branchId,
        idempotencyKey,
        body,
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
