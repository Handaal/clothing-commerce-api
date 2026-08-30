import { MeTenantsResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runIdentityManagementRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

// Identity-scoped bootstrap. No X-Tenant-Id: it returns only the verified caller's own active
// memberships against active tenants. It is NOT tenant/admin enumeration.
export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runIdentityManagementRoute({
    responseSchema: MeTenantsResponseSchema,
    handler: () => boundary.identityMembershipResolver.resolve(request),
  });
}

export function OPTIONS() {
  return managementOptionsResponse();
}
