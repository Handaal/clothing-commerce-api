import { BranchSchema, SetBranchBrandsRequestSchema } from "../../../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementWriteRoute,
} from "../../../../../../../src/http/management-route";
import { BranchPathSchema } from "../../../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../../../src/management/server-management-boundary";

type RouteContext = { params: Promise<{ branchId: string }> };

export async function PUT(request: Request, route: RouteContext) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: SetBranchBrandsRequestSchema,
    responseSchema: BranchSchema,
    handler: async ({ context, body, idempotencyKey }) =>
      boundary.settingsService.setBranchBrands(
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
