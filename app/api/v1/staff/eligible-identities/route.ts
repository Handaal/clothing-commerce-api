import { EligibleIdentitiesResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { EligibleIdentityQuerySchema } from "../../../../../src/staff/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: EligibleIdentitiesResponseSchema,
    handler: (context) =>
      boundary.staffService.listEligibleIdentities(
        context,
        parseRequest(
          EligibleIdentityQuerySchema,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
