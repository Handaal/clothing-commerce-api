import { MeContextResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// Tenant-scoped. Requires X-Tenant-Id and returns the caller's already-effective read capability per
// management endpoint (permission-specific, never raw permission/scope internals).
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: MeContextResponseSchema,
    handler: (context) => boundary.contextService.resolveContext(context),
  });
}

export function OPTIONS() {
  return managementOptionsResponse();
}
