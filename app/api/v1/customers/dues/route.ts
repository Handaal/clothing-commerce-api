import { CustomerDuesResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(request: Request) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: CustomerDuesResponseSchema,
    handler: (context) => boundary.customersArService.dues(context),
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
