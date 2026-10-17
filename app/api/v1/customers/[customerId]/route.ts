import { CustomerDetailResponseSchema } from "../../../../../src/contracts";
import {
  managementOptionsResponse,
  parseRequest,
  runTenantManagementRoute,
} from "../../../../../src/http/management-route";
import { CustomerPathSchema } from "../../../../../src/management/request";
import { getManagementApiBoundary } from "../../../../../src/management/server-management-boundary";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const boundary = getManagementApiBoundary();
  return runTenantManagementRoute({
    request,
    contextResolver: boundary.contextResolver,
    responseSchema: CustomerDetailResponseSchema,
    handler: async (context) => {
      const { customerId } = parseRequest(CustomerPathSchema, await params);
      return boundary.customersReadService.getCustomer(context, customerId);
    },
  });
}

export function OPTIONS(request: Request) {
  return managementOptionsResponse(request);
}
