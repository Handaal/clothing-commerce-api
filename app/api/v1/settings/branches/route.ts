import {
  BranchSchema,
  BranchListResponseSchema,
  CreateBranchRequestSchema,
} from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
  runTenantManagementWriteRoute,
} from "../../../../../src/http/management-route";
import { BranchListQuerySchema } from "../../../../../src/settings/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: BranchListResponseSchema,
    handler: (context) =>
      boundary.settingsService.listBranches(
        context,
        parseRequest(BranchListQuerySchema, Object.fromEntries(new URL(request.url).searchParams)),
      ),
  });
}

export async function POST(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementWriteRoute({
    request,
    contextResolver: boundary.contextResolver,
    requestSchema: CreateBranchRequestSchema,
    responseSchema: BranchSchema,
    handler: ({ context, body, idempotencyKey }) =>
      boundary.settingsService.createBranch(context, idempotencyKey, body),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
